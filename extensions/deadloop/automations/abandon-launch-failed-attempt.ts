#!/usr/bin/env node
// Safely abandon one launch-failed Worker or reviewer attempt and requeue its unchanged target.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { createCommandRunner, createHerdrRunnerFromCommandRunner, driverResult } = require("../../../src/automation-driver-kit.ts");
const { hasUncommittedWork, UNCOMMITTED_WORK_STATUS_ARGS } = require("../../../src/agent-scratch-area.ts");
const { abandonPersistedAttempt, readAttemptRecord, releasesAttemptOwnership } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { runHerdrPreflight } = require("../../../src/herdr-preflight.cjs");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const {
  assertAttemptProjectBinding,
  assertWorktreeBelongsToProject,
  canonicalAttemptLocation,
} = require("../../../src/attempt-project-confinement.cjs");

import type { AttemptRecord } from "../../../src/attempt-lifecycle";
import type { JsonObject } from "../../../src/automation-driver-kit";

type TargetObservation = { state: "claimed" | "requeued" } | { state: "unsafe"; reason: string };
type RecoveryDependencies = {
  listWorkspaces(): JsonObject[];
  listAgents(): JsonObject[];
  inspectWorktree(record: AttemptRecord): { head: string; status: string; retained: boolean };
  otherAttemptOwnsCheckout(record: AttemptRecord, runDir: string): boolean;
  workspaceCloseWasStarted(record: AttemptRecord, runDir: string): boolean;
  recordWorkspaceCloseStarted(record: AttemptRecord, runDir: string): void;
  observeTarget(record: AttemptRecord): TargetObservation;
  closeWorkspace(workspaceId: string): void;
  workspaceStillExists(record: AttemptRecord): boolean;
  abandonAttempt(runDir: string): AttemptRecord;
  requeueTarget(record: AttemptRecord): void;
};

function parseArgs(argv: string[]): JsonObject {
  const values: JsonObject = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const name of ["attemptRecord", "projectId", "projectRepo", "githubRepo", "stateDir", "enabledAt"]) {
    if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return values;
}

function manualReview(reason: string) {
  return driverResult("error", `manual review required: ${reason}`, { driverAction: "attempt_abandonment_refused" });
}

function samePath(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" && path.resolve(left) === path.resolve(right);
}

function agentOccupiesAttemptWorkspace(agent: JsonObject, record: AttemptRecord): boolean {
  return agent.paneId === record.rootPaneId || agent.name === record.agentName
    || agent.workspaceId === record.workspaceId || agent.workspace_id === record.workspaceId;
}

const ABANDONMENT_RECEIPT_FILE = "abandonment.json";

function workspaceCloseReceipt(record: AttemptRecord, startedAt: string) {
  return {
    schemaVersion: 1,
    action: "workspace_close_started",
    attemptId: record.attemptId,
    launchUuid: record.launchUuid,
    project: record.project,
    repository: record.repository,
    workspaceId: record.workspaceId,
    rootPaneId: record.rootPaneId,
    worktreePath: record.worktreePath,
    startedAt,
  };
}

function validWorkspaceCloseReceipt(value: JsonObject, record: AttemptRecord): boolean {
  return value?.schemaVersion === 1 && value.action === "workspace_close_started"
    && value.attemptId === record.attemptId && value.launchUuid === record.launchUuid
    && value.project === record.project && value.repository === record.repository
    && value.workspaceId === record.workspaceId && value.rootPaneId === record.rootPaneId
    && samePath(value.worktreePath, record.worktreePath)
    && typeof value.startedAt === "string" && Number.isFinite(Date.parse(value.startedAt));
}

function readWorkspaceCloseStartedReceipt(runDir: string, record: AttemptRecord): boolean {
  try {
    return validWorkspaceCloseReceipt(JSON.parse(fs.readFileSync(path.join(runDir, ABANDONMENT_RECEIPT_FILE), "utf8")), record);
  } catch { return false; }
}

function writeWorkspaceCloseStartedReceipt(runDir: string, record: AttemptRecord, startedAt: string): void {
  const file = path.join(runDir, ABANDONMENT_RECEIPT_FILE);
  if (fs.existsSync(file)) {
    if (!readWorkspaceCloseStartedReceipt(runDir, record)) throw new Error("workspace-close-started receipt is malformed or mismatched");
    return;
  }
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(workspaceCloseReceipt(record, startedAt))}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function workspaceProof(
  record: AttemptRecord,
  workspaces: JsonObject[],
  workspaceAbsenceAuthorized = false,
): { safe: boolean; present: boolean; reason?: string } {
  if (!record.workspaceId || !record.rootPaneId || !record.tabId) {
    return { safe: false, present: false, reason: "the launch journal lacks complete workspace ownership evidence" };
  }
  const exact = workspaces.filter((workspace) => workspace.workspaceId === record.workspaceId);
  const sameCheckout = workspaces.filter((workspace) => samePath(workspace.worktreePath, record.worktreePath));
  if (exact.length === 0) {
    if (sameCheckout.length !== 0) {
      return { safe: false, present: false, reason: "another workspace currently owns the recorded checkout" };
    }
    return workspaceAbsenceAuthorized
      ? { safe: true, present: false }
      : { safe: false, present: false, reason: "the recorded workspace disappeared without a guarded close-started receipt" };
  }
  if (exact.length !== 1 || sameCheckout.length !== 1 || exact[0] !== sameCheckout[0]) {
    return { safe: false, present: true, reason: "workspace ownership is ambiguous" };
  }
  const workspace = exact[0];
  if (!samePath(workspace.worktreePath, record.worktreePath)) {
    return { safe: false, present: true, reason: "the recorded workspace points at another checkout" };
  }
  if (workspace.tabCount !== 1 || workspace.paneCount !== 1) {
    return { safe: false, present: true, reason: "the workspace is no longer a one-tab, one-pane disposable attempt workspace" };
  }
  return { safe: true, present: true };
}

function abandonLocked(args: JsonObject, dependencies: RecoveryDependencies, recheck: () => void) {
  const runDir = path.dirname(String(args.attemptRecord));
  let record = readAttemptRecord(runDir) as AttemptRecord;
  if (record.phase !== "launch_failed" && record.phase !== "abandoned") {
    return manualReview(`attempt ${record.attemptId} is ${record.phase}, not launch_failed`);
  }
  if (record.role !== "worker" && record.role !== "reviewer") {
    return manualReview(`attempt role ${record.role} does not have a safe requeue policy`);
  }

  const target = dependencies.observeTarget(record);
  if (target.state === "unsafe") return manualReview(target.reason);

  if (record.lastSuccessfulPhase !== "workspace_opened") {
    return manualReview(`last successful phase ${record.lastSuccessfulPhase} cannot prove a disposable workspace opened before agent start`);
  }
  const worktree = dependencies.inspectWorktree(record);
  if (!worktree.retained) return manualReview("the recorded linked worktree is not retained by the configured repository");
  if (worktree.head.toLowerCase() !== record.inputRevision.head.toLowerCase()) {
    return manualReview("the linked worktree HEAD changed after the recorded launch input");
  }
  if (hasUncommittedWork(worktree.status)) return manualReview("the linked worktree contains changes");
  if (dependencies.otherAttemptOwnsCheckout(record, runDir)) {
    return manualReview("another nonterminal attempt owns the recorded checkout");
  }

  const closeStarted = dependencies.workspaceCloseWasStarted(record, runDir);
  const proof = workspaceProof(record, dependencies.listWorkspaces(), closeStarted);
  if (!proof.safe) return manualReview(proof.reason || "workspace ownership is not proven");
  if (dependencies.listAgents().some((agent) => agentOccupiesAttemptWorkspace(agent, record))) {
    return manualReview("an agent still owns the recorded workspace, pane, or launch-unique name");
  }

  if (record.phase === "launch_failed") {
    if (proof.present && record.workspaceId) {
      recheck();
      dependencies.recordWorkspaceCloseStarted(record, runDir);
      dependencies.closeWorkspace(record.workspaceId);
    }
    if (dependencies.workspaceStillExists(record)) {
      return manualReview("workspace closure could not be confirmed without affecting the linked worktree");
    }
    const worktreeAfterClose = dependencies.inspectWorktree(record);
    if (!worktreeAfterClose.retained) {
      return manualReview("the recorded linked worktree disappeared while closing the workspace");
    }
    if (worktreeAfterClose.head.toLowerCase() !== record.inputRevision.head.toLowerCase()) {
      return manualReview("the linked worktree HEAD changed while closing the workspace");
    }
    if (hasUncommittedWork(worktreeAfterClose.status)) {
      return manualReview("the linked worktree changed while closing the workspace");
    }
    const targetAfterClose = dependencies.observeTarget(record);
    if (targetAfterClose.state === "unsafe") return manualReview(targetAfterClose.reason);
    record = dependencies.abandonAttempt(runDir);
  }

  const currentTarget = dependencies.observeTarget(record);
  if (currentTarget.state === "unsafe") return manualReview(currentTarget.reason);
  if (currentTarget.state === "claimed") {
    recheck();
    dependencies.requeueTarget(record);
    const requeued = dependencies.observeTarget(record);
    if (requeued.state !== "requeued") {
      return manualReview(requeued.state === "unsafe" ? requeued.reason : "the target claim remained after the requeue request");
    }
  }
  return driverResult("done", `attempt ${record.attemptId} was abandoned with evidence and ${record.target.kind} #${record.target.number} was requeued`, {
    driverAction: "attempt_abandoned_and_requeued",
    attemptId: record.attemptId,
    target: record.target,
  });
}

function labelsOf(item: JsonObject): Set<string> {
  return new Set((item.labels || []).map((label: JsonObject | string) => typeof label === "string" ? label : String(label?.name || "")));
}

function productionDependencies(args: JsonObject, commandRunner: ReturnType<typeof createCommandRunner>): RecoveryDependencies {
  const runner = createHerdrRunnerFromCommandRunner(commandRunner);
  const location = canonicalAttemptLocation(args);
  const configured = {
    ready: String(args.readyLabel || "ready-for-agent"),
    implement: String(args.implementLabel || "agent:implement"),
    inProgress: String(args.inProgressLabel || "agent:in-progress"),
    review: String(args.reviewLabel || "agent:review"),
    blocked: String(args.blockedLabel || "agent:blocked"),
    human: String(args.humanLabel || "ready-for-human"),
  };

  function observeTarget(record: AttemptRecord): TargetObservation {
    if (record.role === "worker") {
      const issue = commandRunner.runJson(["gh", "issue", "view", String(record.target.number), "-R", record.repository, "--json", "number,state,labels"]);
      const labels = labelsOf(issue);
      if (String(issue.state || "").toUpperCase() !== "OPEN" || labels.has(configured.blocked) || labels.has(configured.human)) {
        return { state: "unsafe", reason: "the Issue state or safety labels changed" };
      }
      if (labels.has(configured.ready) && labels.has(configured.inProgress) && !labels.has(configured.implement)) return { state: "claimed" };
      if (!labels.has(configured.inProgress) && labels.has(configured.ready) && labels.has(configured.implement)) return { state: "requeued" };
      return { state: "unsafe", reason: "the Issue labels no longer match the recorded claim or exact requeue state" };
    }
    const pr = commandRunner.runJson(["gh", "pr", "view", String(record.target.number), "-R", record.repository, "--json", "number,state,headRefName,headRefOid,labels"]);
    const labels = labelsOf(pr);
    if (String(pr.state || "").toUpperCase() !== "OPEN" || String(pr.headRefName || "") !== record.branch
      || String(pr.headRefOid || "").toLowerCase() !== record.inputRevision.head.toLowerCase()
      || labels.has(configured.blocked) || labels.has(configured.human) || !labels.has(configured.review)) {
      return { state: "unsafe", reason: "the pull request head, branch, state, or safety labels changed" };
    }
    return labels.has(configured.inProgress) ? { state: "claimed" } : { state: "requeued" };
  }

  return {
    listWorkspaces: () => runner.listWorkspaces(),
    listAgents: () => runner.listAgents(),
    inspectWorktree: (record) => {
      assertWorktreeBelongsToProject(commandRunner, record, args);
      const head = commandRunner.runText(["git", "-C", record.worktreePath, "rev-parse", "HEAD"]).trim();
      const status = commandRunner.runText(["git", "-C", record.worktreePath, ...UNCOMMITTED_WORK_STATUS_ARGS]);
      const retained = runner.listWorktrees(String(args.projectRepo)).some((worktree: JsonObject) =>
        worktree.branch === record.branch && samePath(worktree.path, record.worktreePath));
      return { head, status, retained };
    },
    otherAttemptOwnsCheckout: (record, runDir) => {
      for (const entry of fs.readdirSync(location.runsRoot)) {
        const candidateDir = path.join(location.runsRoot, entry);
        if (candidateDir === runDir || !fs.existsSync(path.join(candidateDir, "attempt.json"))) continue;
        const candidate = readAttemptRecord(candidateDir);
        if (candidate.project !== record.project || candidate.repository !== record.repository || releasesAttemptOwnership(candidate.phase)) continue;
        if (candidate.workspaceId === record.workspaceId || samePath(candidate.worktreePath, record.worktreePath)) return true;
      }
      return false;
    },
    workspaceCloseWasStarted: (record, runDir) => readWorkspaceCloseStartedReceipt(runDir, record),
    recordWorkspaceCloseStarted: (record, runDir) => writeWorkspaceCloseStartedReceipt(runDir, record, new Date().toISOString()),
    observeTarget,
    closeWorkspace: (workspaceId) => runner.closeWorkspace(workspaceId),
    workspaceStillExists: (record) => {
      const workspaces = runner.listWorkspaces();
      const workspaceRemains = workspaces.some((workspace: JsonObject) =>
        workspace.workspaceId === record.workspaceId || samePath(workspace.worktreePath, record.worktreePath));
      if (workspaceRemains) return true;
      assertWorktreeBelongsToProject(commandRunner, record, args);
      return false;
    },
    abandonAttempt: (runDir) => abandonPersistedAttempt(runDir, new Date().toISOString()),
    requeueTarget: (record) => {
      if (record.role === "worker") {
        commandRunner.runText(["gh", "issue", "edit", String(record.target.number), "-R", record.repository,
          "--remove-label", configured.inProgress, "--add-label", configured.ready, "--add-label", configured.implement]);
      } else {
        commandRunner.runText(["gh", "pr", "edit", String(record.target.number), "-R", record.repository,
          "--remove-label", configured.inProgress]);
      }
    },
  };
}

async function abandon(args: JsonObject) {
  const commandRunner = createCommandRunner();
  runHerdrPreflight({ run: (command: string, commandArgs: string[]) => commandRunner.runText([command, ...commandArgs]) });
  const location = canonicalAttemptLocation(args);
  const record = readAttemptRecord(location.runDir);
  assertAttemptProjectBinding(record, args);
  const project = {
    id: String(args.projectId),
    repoPath: path.resolve(String(args.projectRepo)),
    githubRepo: String(args.githubRepo),
    stateDir: path.resolve(String(args.stateDir)),
    enabledAt: Number(args.enabledAt),
  };
  const dependencies = productionDependencies(args, commandRunner);
  return withEnabledDriverLock(project, (_enabled: unknown, recheck: () => void) => abandonLocked(args, dependencies, recheck));
}

function main(): void {
  abandon(parseArgs(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => process.stdout.write(`${JSON.stringify(manualReview(error instanceof Error ? error.message : String(error)))}\n`));
}

if (require.main === module) main();
module.exports = {
  abandon,
  abandonLocked,
  agentOccupiesAttemptWorkspace,
  parseArgs,
  productionDependencies,
  readWorkspaceCloseStartedReceipt,
  workspaceProof,
  writeWorkspaceCloseStartedReceipt,
};
