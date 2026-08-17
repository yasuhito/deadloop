#!/usr/bin/env node
// Close one disposable attempt workspace only after a bound V1 report and role-specific GitHub state agree.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { createCommandRunner, driverResult } = require("../../../src/automation-driver-kit.ts");
const { createHerdrRunnerFromCommandRunner } = require("../../../src/automation-driver-kit.ts");
const {
  readAttemptRecord,
  recordPersistedCompletionReport,
  releasesAttemptOwnership,
  transitionPersistedAttempt,
} = require("../../../src/attempt-lifecycle-runtime.cjs");
const { validatePromise } = require("./extract-worker-promise.ts");
const { runHerdrPreflight } = require("../../../src/herdr-preflight.cjs");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { parseAttemptPersistenceMarkers } = require("../../../src/attempt-persistence-marker.cjs");
const { evaluateCompletionPersistence } = require("../../../src/attempt-workspace-predicates.cjs");
const { isExactRequiredVerificationStop } = require("../../../src/issue-required-verification-stop.ts");
const {
  assertAttemptProjectBinding,
  assertWorktreeBelongsToProject,
  canonicalAttemptLocation,
} = require("../../../src/attempt-project-confinement.cjs");
const {
  assertCurrentWorkerContract,
  assertWorkerCompletionAuthorized,
  readRequiredVerificationRecord,
  workerRequiredVerificationPath,
} = require("../../../src/worker-required-verification-runtime.cjs");

import type { AttemptRecord, CompletionReportV1 } from "../../../src/attempt-lifecycle";
import type { GithubCompletionObservation } from "../../../src/attempt-workspace-lifecycle";
import type { JsonObject } from "../../../src/automation-driver-kit";

function parseArgs(argv: string[]): JsonObject {
  const values: JsonObject = { expectedLabel: [], managedLabel: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    const name = flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
    if (name === "expectedLabel" || name === "managedLabel") values[name].push(value);
    else values[name] = value;
  }
  for (const name of ["attemptRecord", "projectId", "projectRepo", "githubRepo", "stateDir", "enabledAt"]) {
    if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return values;
}

function labelsOf(item: JsonObject): string[] {
  return (item.labels || []).map((label: JsonObject | string) => typeof label === "string" ? label : String(label?.name || ""));
}

function same(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function outputRevision(report: CompletionReportV1): string | undefined {
  return report.status === "complete" && ["worker", "review-repair", "branch-update"].includes(report.role)
    ? (report.result as { outputRevision: string }).outputRevision
    : undefined;
}

function persistedMarker(comments: JsonObject[], record: AttemptRecord): JsonObject | undefined {
  return parseAttemptPersistenceMarkers(comments).find((marker: JsonObject) =>
    marker.attemptId === record.attemptId && marker.role === record.role && marker.repository === record.repository
    && marker.target?.kind === record.target.kind && marker.target?.number === record.target.number
    && same(marker.inputRevision?.head, record.inputRevision.head)
    && String(marker.inputRevision?.base || "").toLowerCase() === String(record.inputRevision.base || "").toLowerCase()
  );
}

function completionMarkerFromPersisted(marker: JsonObject | undefined) {
  if (!marker) return undefined;
  return {
    attemptId: marker.attemptId, role: marker.role, repository: marker.repository, target: marker.target,
    inputHead: marker.inputRevision.head, inputBase: marker.inputRevision.base, outcome: marker.outcome,
    outputRevision: marker.outputRevision, validationPassed: marker.validationPassed,
  };
}

function prView(runner: ReturnType<typeof createCommandRunner>, record: AttemptRecord): JsonObject {
  return runner.runJson([
    "gh", "pr", "view", String(record.target.number), "-R", record.repository,
    "--json", "number,state,isDraft,headRefName,headRefOid,baseRefName,body,labels,comments,closingIssuesReferences",
  ]);
}

function workerObservation(
  runner: ReturnType<typeof createCommandRunner>,
  record: AttemptRecord,
  _report: CompletionReportV1,
): GithubCompletionObservation {
  const prs = runner.runJson([
    "gh", "pr", "list", "-R", record.repository, "--state", "open", "--head", record.branch,
    "--json", "number,state,headRefName,headRefOid,baseRefName,body,labels,closingIssuesReferences,comments",
  ]);
  const pullRequests = (Array.isArray(prs) ? prs : []).map((pr: JsonObject) => ({
    repository: record.repository,
    target: record.target,
    state: (String(pr.state || "").toLowerCase() === "open" ? "open" : String(pr.state || "").toLowerCase() === "merged" ? "merged" : "closed") as "open" | "closed" | "merged",
    headBranch: String(pr.headRefName || ""),
    headSha: String(pr.headRefOid || ""),
    baseBranch: String(pr.baseRefName || "") === String(record.baseBranch || "").replace(/^origin\//, "")
      ? String(record.baseBranch || "") : String(pr.baseRefName || ""),
    closesIssue: (pr.closingIssuesReferences || []).some((item: JsonObject) => Number(item.number) === record.target.number)
      ? record.target.number : null,
    labels: labelsOf(pr),
    marker: completionMarkerFromPersisted(persistedMarker(pr.comments || [], record)),
  }));
  return {
    kind: "confirmed", role: "worker", repository: record.repository, target: record.target,
    pullRequests,
  };
}

function reviewerObservation(record: AttemptRecord, report: CompletionReportV1, pr: JsonObject) {
  if (report.status !== "complete" || report.role !== "reviewer") throw new Error("reviewer report is not complete");
  const persisted = persistedMarker(pr.comments || [], record);
  return {
    kind: "confirmed" as const,
    role: "reviewer" as const,
    repository: record.repository,
    target: record.target,
    headSha: String(pr.headRefOid || ""),
    labels: labelsOf(pr),
    draft: pr.isDraft === true,
    ...(persisted ? {
      reviewPersistence: {
        repository: record.repository,
        target: record.target,
        headSha: record.inputRevision.head,
        marker: completionMarkerFromPersisted(persisted),
        findings: Array.isArray(persisted.findings) ? persisted.findings : [],
        boundedRepairAttemptMarked: persisted.boundedRepairAttemptMarked === true,
      },
    } : {}),
  };
}

function writerObservation(record: AttemptRecord, report: CompletionReportV1, pr: JsonObject) {
  if (report.status !== "complete" || (report.role !== "review-repair" && report.role !== "branch-update")) {
    throw new Error("writer report is not complete");
  }
  const persisted = persistedMarker(pr.comments || [], record);
  const pushed = persisted?.pushRecorded === true;
  return {
    kind: "confirmed" as const,
    role: report.role,
    repository: record.repository,
    target: record.target,
    headSha: String(pr.headRefOid || ""),
    marker: completionMarkerFromPersisted(persisted),
    pushRecorded: pushed,
    successClaimRecorded: persisted?.successClaimRecorded === true,
  };
}

function assertWorkerPersistenceAuthorized(
  record: AttemptRecord,
  report: CompletionReportV1,
  args: JsonObject,
  currentContract: (record: AttemptRecord, projectRepo: string, localConfigPath?: string, repositoryId?: string) => unknown = assertCurrentWorkerContract,
  repositoryId: string | undefined = args.githubRepositoryId,
): void {
  const localConfigPath = process.env.DEADLOOP_CONFIG || path.join(String(args.stateDir), "projects.json");
  currentContract(record, String(args.projectRepo), localConfigPath, repositoryId);
  const verification = readRequiredVerificationRecord(workerRequiredVerificationPath(String(args.attemptRecord)));
  const currentAfterVerification = currentContract(record, String(args.projectRepo), localConfigPath, repositoryId);
  assertWorkerCompletionAuthorized(record, report, verification, currentAfterVerification);
}

function cleanupPending(message: string, detail?: string) {
  return driverResult("done", message, {
    driverAction: "cleanup_pending",
    ...(detail ? { cleanupDetail: detail } : {}),
  });
}

function safeRunnerCall<T>(operation: () => T): { ok: true; value: T } | { ok: false; detail: string } {
  try { return { ok: true, value: operation() }; }
  catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error) }; }
}

type CompletionStopExpectation = {
  resolution: Record<string, unknown>;
  labels: { ready: string; implement: string; inProgress: string; blocked: string };
};

function completeLocked(
  args: JsonObject,
  commandRunner: ReturnType<typeof createCommandRunner>,
  recheck: () => void,
  authorizeWorker?: (record: AttemptRecord, report: CompletionReportV1, args: JsonObject) => void,
  completionStop?: CompletionStopExpectation,
) {
  const authorizeWorkerCompletion = authorizeWorker || assertWorkerPersistenceAuthorized;
  const { attemptRecord, runDir, runsRoot } = canonicalAttemptLocation(args);
  let record = readAttemptRecord(runDir) as AttemptRecord;
  assertAttemptProjectBinding(record, args);

  // Terminal local state is authoritative for idempotency. Do not re-read a later-damaged promise
  // or touch GitHub/Herdr after closure has already been proven and persisted.
  if (record.phase === "workspace_closed") {
    return driverResult("done", "attempt workspace was already closed; linked worktree retained", {
      driverAction: "workspace_closed", lifecycle: { action: "closed", record },
    });
  }
  if (record.phase === "launch_failed") {
    return driverResult("done", "launch-failed workspace retained for inspection", { driverAction: "workspace_retained" });
  }

  const runner = createHerdrRunnerFromCommandRunner(commandRunner);
  const needsWorktreeProof = !["prepared", "github_claimed"].includes(record.phase);
  if (needsWorktreeProof) assertWorktreeBelongsToProject(commandRunner, record, args);

  // Once GitHub persistence is durable, never replay promise validation or GitHub proof. Retry only
  // ownership, workspace closure, and linked-worktree postconditions.
  let report: CompletionReportV1 | undefined;
  let github: GithubCompletionObservation | undefined;
  if (record.phase !== "github_persisted") {
    let validation;
    try { validation = validatePromise(record.promiseFile, attemptRecord); }
    catch (error) {
      return driverResult("done", "attempt workspace retained because the completion report is malformed", {
        driverAction: "workspace_retained", detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (validation.evidenceStrength !== "strong") {
      return driverResult("done", "attempt workspace retained because the completion report is not strongly bound", { driverAction: "workspace_retained" });
    }
    try { report = JSON.parse(fs.readFileSync(record.promiseFile, "utf8")) as CompletionReportV1; }
    catch (error) {
      return driverResult("done", "attempt workspace retained because the completion report is malformed", {
        driverAction: "workspace_retained", detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (record.phase === "workspace_opened") {
      const agents = safeRunnerCall(() => runner.listAgents());
      if ("detail" in agents) return cleanupPending("attempt workspace observation is pending", agents.detail);
      const occupants = agents.value.filter((agent) => agent.name === record.agentName);
      if (occupants.length !== 1 || occupants[0].paneId !== record.rootPaneId || !occupants[0].cwd
        || path.resolve(occupants[0].cwd) !== path.resolve(record.worktreePath)) {
        return driverResult("done", "attempt workspace retained because agent start was not confirmed", { driverAction: "workspace_retained" });
      }
      assertWorktreeBelongsToProject(commandRunner, record, args);
      record = transitionPersistedAttempt(runDir, "agent_started");
    }
    if (!["agent_started", "report_received"].includes(record.phase)) {
      return driverResult("done", `attempt workspace retained at non-completable phase ${record.phase}`, { driverAction: "workspace_retained" });
    }
    if (record.phase === "agent_started") {
      assertWorktreeBelongsToProject(commandRunner, record, args);
      record = recordPersistedCompletionReport(runDir, report);
    }
    // A stop without a completion report keeps its workspace for inspection. A completed review
    // that asks for a person does not: its result is on the pull request and the handoff is what
    // the person acts on, so leaving the workspace open would only block the next attempt.
    if (report.status === "blocked") {
      return driverResult("done", "attempt workspace retained for inspection", { driverAction: "workspace_retained" });
    }

    let pr: JsonObject | undefined;
    if (record.role !== "worker") pr = prView(commandRunner, record);
    if (record.role !== "worker" && (!same(pr?.headRefOid, outputRevision(report) || record.inputRevision.head))) {
      return driverResult("done", "attempt workspace retained because the live PR head differs", { driverAction: "workspace_retained" });
    }
    if (record.role === "worker" && !completionStop) github = workerObservation(commandRunner, record, report);
    else if (record.role !== "worker") github = record.role === "reviewer"
      ? reviewerObservation(record, report, pr as JsonObject)
      : writerObservation(record, report, pr as JsonObject);
  }

  const listed = safeRunnerCall(() => runner.listWorkspaces());
  if ("detail" in listed) return cleanupPending("attempt workspace observation is pending", listed.detail);
  const workspaceMatches = record.workspaceId
    ? listed.value.filter((workspace) => workspace.workspaceId === record.workspaceId)
    : [];
  if (workspaceMatches.length > 1 || (workspaceMatches.length === 1
    && (!workspaceMatches[0].worktreePath || path.resolve(workspaceMatches[0].worktreePath) !== path.resolve(record.worktreePath)))) {
    return record.phase === "github_persisted"
      ? cleanupPending("attempt workspace cleanup is pending because ownership is ambiguous")
      : driverResult("done", "attempt workspace retained because workspace ownership is ambiguous", { driverAction: "workspace_retained" });
  }
  if (record.phase === "report_received" && workspaceMatches.length !== 1 && !completionStop) {
    return driverResult("done", "attempt workspace retained because exact workspace ownership is no longer present", { driverAction: "workspace_retained" });
  }

  let newerOwner = false;
  for (const entry of fs.readdirSync(runsRoot)) {
    if (path.join(runsRoot, entry) === runDir) continue;
    let candidate;
    try { candidate = readAttemptRecord(path.join(runsRoot, entry)); }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("Attempt record is missing:")) continue;
      return driverResult("done", "attempt workspace retained because another journal is malformed", {
        driverAction: "workspace_retained", detail: error instanceof Error ? error.message : String(error),
      });
    }
    if (candidate.project !== record.project || candidate.repository !== record.repository) continue;
    const candidateOwnsWorkspace = !["prepared", "github_claimed"].includes(candidate.phase);
    if (candidateOwnsWorkspace && !releasesAttemptOwnership(candidate.phase) && candidate.attemptId !== record.attemptId
      && (Boolean(record.workspaceId) && candidate.workspaceId === record.workspaceId
        || path.resolve(candidate.worktreePath) === path.resolve(record.worktreePath))) {
      newerOwner = true;
      break;
    }
  }
  if (newerOwner) {
    return driverResult("done", "attempt workspace retained because another live attempt claims it", { driverAction: "workspace_retained" });
  }

  if (record.phase !== "github_persisted") {
    let completionStopConfirmed = false;
    if (completionStop) {
      const issue = commandRunner.runJson([
        "gh", "issue", "view", String(record.target.number), "-R", record.repository,
        "--json", "number,state,labels,comments",
      ]);
      completionStopConfirmed = isExactRequiredVerificationStop(issue, completionStop.resolution, completionStop.labels);
    }
    const decision = completionStop
      ? { action: completionStopConfirmed ? "close" as const : "retain" as const }
      : evaluateCompletionPersistence({
        record,
        report: { kind: "v1", promisePath: record.promiseFile, report },
        github,
        context: {
          workerReviewLabel: String(args.workerReviewLabel || ""),
          reviewerExpectedLabels: args.expectedLabel || [],
          reviewerManagedLabels: args.managedLabel?.length ? args.managedLabel : args.expectedLabel || [],
        },
      });
    if (decision.action !== "close") {
      return driverResult("done", "attempt workspace retained because GitHub persistence is not confirmed", { driverAction: "workspace_retained" });
    }
    if (record.role === "worker" && !completionStopConfirmed) {
      try { authorizeWorkerCompletion(record, report as CompletionReportV1, { ...args, attemptRecord }); }
      catch (error) {
        return driverResult("done", "attempt workspace retained because required verification is not authoritative", {
          driverAction: "workspace_retained", detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    assertWorktreeBelongsToProject(commandRunner, record, args);
    record = transitionPersistedAttempt(runDir, "github_persisted");
  }

  // Never close first: immediately before any close, re-prove the configured checkout, common Git
  // directory, and canonical linked worktree observation.
  assertWorktreeBelongsToProject(commandRunner, record, args);
  if (workspaceMatches.length === 1 && record.workspaceId) {
    recheck();
    const closed = safeRunnerCall(() => runner.closeWorkspace(record.workspaceId as string));
    if ("detail" in closed) return cleanupPending("attempt workspace cleanup is pending", closed.detail);
  }
  const afterClose = safeRunnerCall(() => runner.listWorkspaces());
  if ("detail" in afterClose) return cleanupPending("attempt workspace cleanup confirmation is pending", afterClose.detail);
  if (record.workspaceId && afterClose.value.some((workspace) => workspace.workspaceId === record.workspaceId)) {
    return cleanupPending("attempt workspace cleanup is pending");
  }
  const worktrees = safeRunnerCall(() => runner.listWorktrees(String(args.projectRepo)));
  if ("detail" in worktrees) return cleanupPending("attempt linked-worktree confirmation is pending", worktrees.detail);
  const canonicalRecordPath = fs.realpathSync(record.worktreePath);
  const worktreeExists = worktrees.value.some((worktree) => {
    if (typeof worktree.path !== "string" || worktree.branch !== record.branch) return false;
    try { return fs.realpathSync(worktree.path) === canonicalRecordPath; } catch { return false; }
  });
  if (!worktreeExists) return cleanupPending("attempt workspace cleanup is pending because the linked worktree was not retained");
  record = transitionPersistedAttempt(runDir, "workspace_closed");
  return driverResult("done", "attempt workspace closed; linked worktree retained", {
    driverAction: "workspace_closed", lifecycle: { action: "closed", record },
  });
}

function closeCompletionStoppedWorkerAttempt(
  args: JsonObject,
  commandRunner: ReturnType<typeof createCommandRunner>,
  recheck: () => void,
  expectation: CompletionStopExpectation,
) {
  const record = readAttemptRecord(canonicalAttemptLocation(args).runDir) as AttemptRecord;
  if (record.role !== "worker" || record.target.kind !== "issue") {
    throw new Error("completion-stop workspace closure requires an Issue Worker attempt");
  }
  return completeLocked(args, commandRunner, recheck, undefined, expectation);
}

async function complete(args: JsonObject) {
  const commandRunner = createCommandRunner();
  runHerdrPreflight({ run: (command: string, commandArgs: string[]) => commandRunner.runText([command, ...commandArgs]) });
  const project = {
    id: String(args.projectId),
    repoPath: path.resolve(String(args.projectRepo)),
    githubRepo: String(args.githubRepo),
    stateDir: path.resolve(String(args.stateDir)),
    enabledAt: Number(args.enabledAt),
  };
  return withEnabledDriverLock(project, (enabled: { githubRepositoryId?: string }, recheck: () => void) =>
    completeLocked({ ...args, githubRepositoryId: enabled.githubRepositoryId }, commandRunner, recheck));
}

function main(): void {
  complete(parseArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => process.stdout.write(`${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "exception" }))}\n`));
}

if (require.main === module) main();
module.exports = { assertWorkerPersistenceAuthorized, closeCompletionStoppedWorkerAttempt, complete, completeLocked, parseArgs, persistedMarker, workerObservation, reviewerObservation, writerObservation };
