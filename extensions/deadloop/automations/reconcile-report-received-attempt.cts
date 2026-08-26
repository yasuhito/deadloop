#!/usr/bin/env node
// Collect an Issue Worker attempt stranded at report_received after its deterministic attempt
// monitoring was lost. The same attemptMonitoring vocabulary status/doctor publish decides between
// persistence, retention, and a reasoned stop; no agent is restarted and no evidence is rewritten.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const { createCommandRunner, driverResult } = require("../../../src/automation-driver-kit.cts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { runHerdrPreflight } = require("../../../src/herdr-preflight.cjs");
const {
  readAttemptRecord,
  releasePersistedAttemptAuthority,
  releasesAttemptOwnership,
} = require("../../../src/attempt-lifecycle-runtime.cjs");
const { assertAttemptProjectBinding, canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");
const issueRequestTransition = require("../../../src/issue-request-transition.cts");
const { createGithubOperations } = require("../../../src/github-operations.cts");
const { decideAttemptMonitoring } = require("../../../src/attempt-monitoring.cts");
const { reportObservation, runtimeObservation, terminalEvidenceArgs } = require("../../../src/monitor-handoff-observation.cts");
const { monitorRuntimeRunner } = require("../../../src/deterministic-attempt-monitor-runtime.cts");

type JsonObject = Record<string, any>;

type RecoveryObservationDependencies = {
  runner: ReturnType<typeof monitorRuntimeRunner>;
  readTerminalEvidence(record: JsonObject): string;
};

type RecoveryInjected = {
  observeDirective?(record: JsonObject): JsonObject;
  github?: JsonObject;
  runCompletion?(handoff: JsonObject): JsonObject;
};

function parseArgs(argv: string[]): JsonObject {
  const values: JsonObject = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const name of [
    "attemptRecord", "projectId", "projectRepo", "githubRepo", "stateDir", "enabledAt",
    "readyLabel", "exploreLabel", "implementLabel", "inProgressLabel", "reviewLabel", "blockedLabel",
  ]) {
    if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return values;
}

function authorizedLogins(args: JsonObject, automationLogin: unknown): string[] {
  return [...new Set([
    ...String(args.automationLogins || "").split(",").map((value: string) => value.trim().toLowerCase()),
    String(automationLogin || "").trim().toLowerCase(),
  ].filter(Boolean))];
}

/** A live turn, an unreadable runtime answer, or a missing runtime all keep the evidence untouched. */
const RETAINING_RUNTIME_KINDS = new Set(["working", "ambiguous", "unreachable"]);

/**
 * The exact directive vocabulary status/doctor publish: one observation over the bound report, the
 * execution-runtime state, and fresh accounting. Retention reads the runtime kind directly because
 * only an execution runtime that stopped reporting active work makes an old report collectable.
 */
function observeRecoveryDirective(record: JsonObject, dependencies: RecoveryObservationDependencies): JsonObject {
  const runtime = runtimeObservation(record, dependencies);
  const directive = decideAttemptMonitoring({
    attempt: record,
    report: reportObservation(record),
    runtime,
    accounting: { activeMilliseconds: 0, observedAt: new Date().toISOString(), runtimeWasWorking: false },
    maxActiveMilliseconds: 86_400_000,
    now: new Date().toISOString(),
  });
  return { runtime, directive };
}

function readTerminalEvidence(record: JsonObject): string {
  const output = spawnSync("herdr", terminalEvidenceArgs(record), {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL",
  });
  return output.status === 0 ? String(output.stdout || "") : "";
}

/** Spawns the shared deterministic Issue completion chain; its guards make every step re-runnable. */
function runDeterministicIssueCompletion(handoff: JsonObject): JsonObject {
  const completed = spawnSync("node", [path.join(__dirname, "complete-deterministic-issue-attempt.cts")], {
    input: JSON.stringify(handoff),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15 * 60_000,
    killSignal: "SIGKILL",
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    throw new Error(String(completed.stderr || completed.stdout || "deterministic issue completion failed").trim());
  }
  return JSON.parse(String(completed.stdout || "{}"));
}

type NewerOwnerCheck = { blocked: boolean; detail?: string };

/** Mirrors the workspace-closure guard: a newer live attempt owning the checkout is never overwritten. */
function anotherLiveAttemptOwnsCheckout(runsRoot: string, runDir: string, record: JsonObject): NewerOwnerCheck {
  let entries: string[];
  try { entries = fs.readdirSync(runsRoot); }
  catch { return { blocked: true, detail: "other attempt journals cannot be inspected" }; }
  for (const entry of entries) {
    const candidateDir = path.join(runsRoot, entry);
    if (candidateDir === runDir) continue;
    if (!fs.existsSync(path.join(candidateDir, "attempt.json"))) continue;
    let candidate;
    try { candidate = readAttemptRecord(candidateDir); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("Attempt record is missing:")) continue;
      return { blocked: true, detail: error instanceof Error ? error.message : String(error) };
    }
    if (candidate.project !== record.project || candidate.repository !== record.repository) continue;
    const candidateOwnsWorkspace = !["prepared", "github_claimed"].includes(candidate.phase);
    if (!candidateOwnsWorkspace || releasesAttemptOwnership(candidate.phase) || candidate.attemptId === record.attemptId) continue;
    if (candidate.workspaceId === record.workspaceId
      || path.resolve(candidate.worktreePath) === path.resolve(record.worktreePath)) {
      return { blocked: true, detail: `attempt ${candidate.attemptId}` };
    }
  }
  return { blocked: false };
}

const UNPROVABLE_REASONS: Record<string, string> = {
  invalid_completion_report: "its completion report is present but no longer proves its binding to this attempt's target revision",
  storage_exhaustion: "the completion report could not be read back from full storage",
  terminal_without_report: "the completion report file is missing even though the journal recorded receiving one",
};

/**
 * One stop with reason and manual recovery steps replaces an unprovable dangling claim. The GitHub
 * stop is proven first; releasing the journal authority afterwards keeps a crash retry idempotent.
 */
function stopUnprovableAttempt(
  args: JsonObject,
  record: JsonObject,
  reason: string,
  runDir: string,
  enabled: { automationLogin?: string },
  commandRunner: ReturnType<typeof createCommandRunner>,
  injected: RecoveryInjected = {},
): JsonObject {
  const automationLogin = String(enabled.automationLogin || "");
  if (!automationLogin.trim()) throw new Error("authorized Automation host login is required");
  issueRequestTransition.persistIssueAttemptStop({
    github: injected.github || createGithubOperations(commandRunner),
    repository: String(record.repository),
    issueNumber: Number(record.target.number),
    requestLabels: [String(args.implementLabel), String(args.exploreLabel)],
    requestLabel: String(record.agentRequest?.label || args.implementLabel),
    requestEventId: String(record.agentRequest?.eventId || record.requestEventId || ""),
    inProgressLabel: String(args.inProgressLabel),
    blockedLabel: String(args.blockedLabel),
    automationLogin,
    automationLogins: authorizedLogins(args, automationLogin),
    attemptId: String(record.attemptId),
    failure: {
      reason,
      explanation: `deadloop stopped this implementation attempt during reconciliation because ${UNPROVABLE_REASONS[reason] || reason}. Attempt journal: ${runDir}.`,
      recovery: `The retained local branch (${record.branch}) and workspace (${record.worktreePath}) were left untouched as evidence. Inspect them together with the attempt journal, then either persist the result manually or add "${String(args.implementLabel)}" again to request a fresh implementation attempt.`,
    },
    stopNoun: "implementation",
    persistGithub: () => {},
  });
  releasePersistedAttemptAuthority(runDir, new Date().toISOString(), undefined, "terminal_missing_report");
  return driverResult("done", `report_received attempt ${record.attemptId} stopped because ${UNPROVABLE_REASONS[reason] || reason}`, {
    driverAction: "report_received_stopped",
  });
}

function reconcileReportReceivedLocked(
  args: JsonObject,
  commandRunner: ReturnType<typeof createCommandRunner>,
  enabled: { automationLogin?: string } = {},
  _recheck: () => void = () => {},
  injected: RecoveryInjected = {},
): JsonObject {
  const { runDir, runsRoot, attemptRecord } = canonicalAttemptLocation(args);
  const record = readAttemptRecord(runDir);
  assertAttemptProjectBinding(record, args);
  if (record.phase !== "report_received") {
    return driverResult("done", `attempt is already ${record.phase}`, { driverAction: "recovery_not_applicable" });
  }
  if (record.role !== "worker" || record.target.kind !== "issue") {
    return driverResult("done", `${record.role} attempts have their own reconciliation`, { driverAction: "recovery_not_applicable" });
  }

  const observation = injected.observeDirective?.(record)
    || observeRecoveryDirective(record, { runner: monitorRuntimeRunner() as never, readTerminalEvidence });
  const runtimeKind = String(observation.runtime.kind || "");
  if (RETAINING_RUNTIME_KINDS.has(runtimeKind)) {
    return driverResult("done", `report_received attempt retained while the execution runtime reports ${runtimeKind}`, {
      driverAction: "recovery_retained", runtime: runtimeKind,
    });
  }

  const directive = observation.directive as JsonObject;
  if (directive.action !== "completion" && directive.action !== "missing_report") {
    return driverResult("done", `report_received attempt retained under directive ${directive.action}`, {
      driverAction: "recovery_retained",
    });
  }

  if (directive.action === "missing_report") {
    return stopUnprovableAttempt(args, record as JsonObject, String(directive.reason), runDir, enabled, commandRunner, injected);
  }

  // The completion report proves its binding through validateCompletionReportBinding inside the shared
  // decision, so persistence goes through the ordinary guarded chain exactly like live monitoring.
  const owner = anotherLiveAttemptOwnsCheckout(runsRoot, runDir, record as JsonObject);
  if (owner.blocked) {
    return driverResult("done", `report_received attempt retained because another attempt owns the checkout${owner.detail ? ` (${owner.detail})` : ""}`, {
      driverAction: "recovery_retained_newer_owner", ...(owner.detail ? { detail: owner.detail } : {}),
    });
  }

  const input: JsonObject = {
    issueNumber: Number(record.target.number),
    automationDir: __dirname,
    promiseFile: String(record.promiseFile),
    attemptRecordFile: attemptRecord,
    actorName: "Worker",
    projectId: String(args.projectId),
    repoPath: String(args.projectRepo),
    githubRepo: String(args.githubRepo),
    stateDir: String(args.stateDir),
    enabledAt: Number(args.enabledAt),
    worktreePath: String(record.worktreePath),
    branch: String(record.branch),
    readyLabel: String(args.readyLabel),
    exploreLabel: String(args.exploreLabel),
    implementLabel: String(args.implementLabel),
    reviewLabel: String(args.reviewLabel),
    inProgressLabel: String(args.inProgressLabel),
    blockedLabel: String(args.blockedLabel),
    requestEventId: String((record as JsonObject).agentRequest?.eventId || (record as JsonObject).requestEventId || ""),
    maxActiveMilliseconds: 86_400_000,
  };
  if (args.issueTitle) input.issueTitle = String(args.issueTitle);

  const handoff = { kind: "issue", input };
  const applied = injected.runCompletion?.(handoff) || runDeterministicIssueCompletion(handoff);
  if (applied.applied === true) {
    return driverResult("done", `report_received attempt persisted deterministically: ${applied.result}`, {
      driverAction: "report_received_persisted", result: applied.result,
    });
  }
  return driverResult("done", `report_received attempt kept pending by the deterministic completion chain: ${applied.result}`, {
    driverAction: "report_received_completion_pending", result: applied.result,
    ...(typeof applied.error === "string" ? { detail: applied.error } : {}),
  });
}

function reconcile(args: JsonObject): JsonObject {
  const commandRunner = createCommandRunner();
  runHerdrPreflight({ run: (command: string, commandArgs: string[]) => commandRunner.runText([command, ...commandArgs]) });
  const project = {
    id: String(args.projectId), repoPath: path.resolve(String(args.projectRepo)), githubRepo: String(args.githubRepo),
    stateDir: path.resolve(String(args.stateDir)), enabledAt: Number(args.enabledAt),
  };
  return withEnabledDriverLock(project, (enabled: { automationLogin?: string }, recheck: () => void) =>
    reconcileReportReceivedLocked(args, commandRunner, enabled, recheck));
}

function main(): void {
  try { process.stdout.write(`${JSON.stringify(reconcile(parseArgs(process.argv.slice(2))))}\n`); }
  catch (error) {
    process.stdout.write(`${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "exception" }))}\n`);
  }
}
if (require.main === module) main();
module.exports = { anotherLiveAttemptOwnsCheckout, observeRecoveryDirective, parseArgs, reconcile, reconcileReportReceivedLocked, stopUnprovableAttempt };
