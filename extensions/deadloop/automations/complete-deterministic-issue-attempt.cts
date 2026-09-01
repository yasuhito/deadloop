#!/usr/bin/env node
// Deterministic completion for shared-monitor Issue attempts: implementation Workers and
// read-only explorers. CommonJS-shaped so it can run directly under this package's
// `type: commonjs`, matching complete-deterministic-pr-attempt.cts.

const path = require("node:path") as typeof import("node:path");
const fs = require("node:fs") as typeof import("node:fs");

const { createCommandRunner, stageFailureReason } = require("../../../src/automation-driver-kit.cts");
const { createGithubOperations } = require("../../../src/github-operations.cts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const {
  readAttemptRecord,
  recordPersistedCompletionReport,
  transitionPersistedAttempt,
  validateCompletionReportBinding,
} = require("../../../src/attempt-lifecycle-runtime.cjs");
const {
  assertCurrentWorkerContract,
  assertWorkerCompletionAuthorized,
  readRequiredVerificationRecord,
  workerRequiredVerificationPath,
} = require("../../../src/worker-required-verification-runtime.cjs");
const issueRequestTransition = require("../../../src/issue-request-transition.cts");
const issueExploration = require("./complete-issue-exploration.cts");
const { normalizeCompletionReportCommitShas } = require("../../../src/completion-report-normalization.cjs");

type JsonObject = Record<string, any>;

type CompletionOps = {
  run(script: string, args: string[]): JsonObject;
  lock<T>(operation: (enabled: { automationLogin?: string }, recheck: () => void) => T): T;
};

function flag(name: string, value: unknown): string[] {
  return value === undefined || value === null || value === "" ? [] : [`--${name}`, String(value)];
}

function common(input: JsonObject): string[] {
  return [
    ...flag("attempt-record", input.attemptRecordFile),
    ...flag("project-id", input.projectId),
    ...flag("project-repo", input.repoPath),
    ...flag("github-repo", input.githubRepo),
    ...flag("state-dir", input.stateDir),
    ...flag("enabled-at", input.enabledAt),
  ];
}

function authorizedLogins(input: JsonObject, automationLogin: unknown): string[] {
  return [...new Set([
    ...String(input.authorizedAutomationLogins || "").split(",").map((value) => value.trim().toLowerCase()),
    String(automationLogin || "").trim().toLowerCase(),
  ].filter(Boolean))];
}

/** A passed record that already binds this report to the current policy authorizes resume without rerunning verification. */
function verificationAuthorizesCompletion(input: JsonObject, record: JsonObject, report: JsonObject): boolean {
  try {
    const configFile = process.env.DEADLOOP_CONFIG || path.join(String(input.stateDir), "projects.json");
    const current = assertCurrentWorkerContract(record, String(input.repoPath), configFile);
    const verification = readRequiredVerificationRecord(workerRequiredVerificationPath(String(input.attemptRecordFile)));
    assertWorkerCompletionAuthorized(record, report, verification, current);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Worker reported blocked. Persist one deadloop-authored stop (blocked label, request cleanup,
 * idempotent explanation), advance the journal, then close only the disposable workspace; the
 * linked worktree stays retained as evidence.
 */
function stopBlockedWorkerAttempt(
  input: JsonObject,
  record: JsonObject,
  report: JsonObject,
  deps: { ops: CompletionOps; enabled: { automationLogin?: string }; recheck: () => void },
): JsonObject {
  const automationLogin = String(deps.enabled.automationLogin || "");
  if (!automationLogin.trim()) throw new Error("authorized Automation host login is required");
  const runDir = path.dirname(String(input.attemptRecordFile));
  // The blocked report is a valid bound report, so it becomes the journal's completion record too.
  if (record.phase === "agent_started") recordPersistedCompletionReport(runDir, report);
  if (readAttemptRecord(runDir).phase !== "report_received") {
    throw new Error(`blocked Worker report is not completable from phase ${record.phase}`);
  }
  // Called through the module so tests can bind the stop seam to a controlled observation.
  issueRequestTransition.persistIssueAttemptStop({
    github: createGithubOperations(createCommandRunner(), deps.recheck),
    repository: String(record.repository),
    issueNumber: Number(record.target.number),
    requestLabels: [String(input.implementLabel), String(input.exploreLabel)],
    requestLabel: String(record.agentRequest?.label || input.implementLabel),
    requestEventId: String(record.agentRequest?.eventId || input.requestEventId),
    inProgressLabel: String(input.inProgressLabel),
    blockedLabel: String(input.blockedLabel),
    automationLogin,
    automationLogins: authorizedLogins(input, automationLogin),
    attemptId: String(record.attemptId),
    failure: {
      reason: String(report.result?.reason || "add_request"),
      explanation: String(report.result?.explanation || report.summary || ""),
      recovery: String(report.result?.recovery || report.result?.informationRequest || ""),
    },
    stopNoun: "implementation",
    persistGithub: () => { transitionPersistedAttempt(runDir, "github_persisted"); },
  });
  const closed = deps.ops.run("complete-attempt-workspace.cts", [...common(input)]);
  if (closed.driverAction !== "workspace_closed") {
    return { applied: false, retain: true, result: stageFailureReason("complete-attempt-workspace.cts", closed) };
  }
  return { applied: true, result: "issue_attempt_blocked_stopped" };
}

/**
 * One complete Worker completion report reaches its verified push, draft PR with review request,
 * persisted marker, and deterministic workspace closure. Every step is an independently guarded
 * command, so a pending closure retries without replaying GitHub mutations.
 */
function processWorker(input: JsonObject, record: JsonObject, report: JsonObject, ops: CompletionOps): JsonObject {
  if (!verificationAuthorizesCompletion(input, record, report)) {
    try {
      const verification = ops.run("run-worker-required-verification.cts", [
        ...common(input),
        ...flag("worktree", input.worktreePath),
        ...flag("quarantine-root", path.join(String(input.stateDir), "check-quarantine")),
        ...flag("role", "worker"),
      ]);
      // The stale-policy stop already removed the claim, added the blocked label, posted guidance,
      // and closed the workspace deterministically before reporting here.
      if (verification?.status === "blocked") return { applied: true, result: "required_verification_blocked" };
    } catch (error) {
      // Failed verification evidence stays on disk and the handoff entry stays pending, so the
      // failure keeps its existing visible recovery behavior instead of closing the attempt.
      return {
        applied: false,
        retain: true,
        result: "required_verification_failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  ops.run("guarded-push.cts", [
    ...common(input),
    ...flag("worktree", input.worktreePath),
    ...flag("remote", input.pushRemote || "origin"),
    ...flag("branch", input.branch),
  ]);
  ops.run("guarded-worker-pr.cts", [
    ...common(input),
    ...flag("title", input.issueTitle || `Issue #${input.issueNumber}`),
    ...flag("review-label", input.reviewLabel),
  ]);
  const persisted = ops.run("persist-attempt-result.cts", [
    ...common(input),
    ...flag("review-label", input.reviewLabel),
  ]);
  if (persisted.driverAction !== "result_persisted") {
    return { applied: false, retain: true, result: stageFailureReason("persist-attempt-result.cts", persisted) };
  }
  const closed = ops.run("complete-attempt-workspace.cts", [
    ...common(input),
    ...flag("worker-ready-label", input.readyLabel),
    ...flag("worker-implement-label", input.implementLabel),
    ...flag("worker-review-label", input.reviewLabel),
  ]);
  if (closed.driverAction !== "workspace_closed") {
    return { applied: false, retain: true, result: stageFailureReason("complete-attempt-workspace.cts", closed) };
  }
  return { applied: true, result: "issue_attempt_completed" };
}

function explorationArgs(input: JsonObject): JsonObject {
  return {
    attemptRecord: String(input.attemptRecordFile),
    projectId: String(input.projectId),
    projectRepo: String(input.repoPath),
    githubRepo: String(input.githubRepo),
    stateDir: String(input.stateDir),
    enabledAt: Number(input.enabledAt),
    exploreLabel: String(input.exploreLabel),
    implementLabel: String(input.implementLabel),
    inProgressLabel: String(input.inProgressLabel),
    blockedLabel: String(input.blockedLabel),
  };
}

function processInput(handoff: JsonObject, injectedOps?: CompletionOps): JsonObject {
  if (!handoff?.input || !["issue", "explorer"].includes(String(handoff.kind))) {
    throw new Error("deterministic Issue completion requires an issue or explorer handoff");
  }
  const input = handoff.input;
  const record = readAttemptRecord(path.dirname(String(input.attemptRecordFile)));
  const report = normalizeCompletionReportCommitShas(record, JSON.parse(fs.readFileSync(String(input.promiseFile), "utf8")));
  validateCompletionReportBinding(record, report);

  if (handoff.kind === "explorer") {
    const completed = issueExploration.complete(explorationArgs(input));
    return ["exploration_persisted", "exploration_blocked"].includes(String(completed.driverAction))
      ? { applied: true, result: String(completed.driverAction) }
      : { applied: false, retain: true, result: stageFailureReason("complete-issue-exploration.cts", completed) };
  }

  const commandRunner = createCommandRunner({ timeoutMs: 15 * 60_000 });
  const operations: CompletionOps = injectedOps || {
    run: (script, args) => commandRunner.runJson(["node", path.join(String(input.automationDir), script), ...args]),
    lock: (operation) => withEnabledDriverLock({
      projectId: String(input.projectId),
      repoPath: String(input.repoPath),
      githubRepo: String(input.githubRepo),
      stateDir: String(input.stateDir),
      enabledAt: Number(input.enabledAt),
    }, operation),
  };

  if (report.status === "blocked") {
    return operations.lock((enabled, recheck) => stopBlockedWorkerAttempt(input, record, report, { ops: operations, enabled, recheck }));
  }
  return processWorker(input, record, report, operations);
}

function main(): void {
  try {
    const handoff = JSON.parse(fs.readFileSync(0, "utf8"));
    process.stdout.write(`${JSON.stringify(processInput(handoff))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ applied: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  }
}

if (require.main === module) main();
module.exports = { processInput, processWorker, stopBlockedWorkerAttempt, verificationAuthorizesCompletion };
