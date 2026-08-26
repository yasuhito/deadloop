import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

import { deliverPendingDriverHandoff } from "../../src/automation-runner";
import { runPrReviewerDriverFixture, type PrReviewerDriverResult } from "../support/pr-reviewer-driver";
import { fixtureStateDir } from "../support/fixture-state-dir";

const { applyDeterministicAttemptMonitoring } = require("../../src/deterministic-attempt-monitor-runtime.cts");
const { applyTerminalMonitorDisposition } = require("../../extensions/deadloop/automations/contain-terminal-monitor.cts");
const { readAttemptRecord } = require("../../src/attempt-lifecycle-runtime.cjs");
const { observeAttemptMonitoringDirective } = require("../../src/monitor-handoff-observation.cts");
const { renderBranchUpdateMarker } = require("../../extensions/deadloop/automations/pr-branch-update-state.cts");

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const NOW = Date.parse("2026-08-26T00:05:00Z");
const ATTEMPT_ID = "attempt-1";
const STOP_ATTEMPT_ID = "restart-1";

type BranchUpdateFailureWorld = {
  root?: string;
  runDir?: string;
  promiseFile?: string;
  worktreePath?: string;
  brokenReportRead?: boolean;
  terminalEvidence?: string;
  runnerStub?: unknown;
  stubDependencies?: unknown;
  project?: Record<string, unknown>;
  handoff?: { kind: string; input: Record<string, unknown> };
  prTarget?: { labels: string[]; headRefOid: string };
  comments?: Array<{ body: string; user: { login: string }; created_at: string; updated_at: string }>;
  driverResult?: PrReviewerDriverResult;
  recoveryFixturePath?: string;
};

function writeStoppedUpdateRecord(runDir: string, promiseFile: string, worktreePath: string): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(runDir, "attempt.json"), `${JSON.stringify({
    attemptId: ATTEMPT_ID,
    launchUuid: "launch-1",
    project: "demo",
    repository: "owner/repo",
    role: "branch-update",
    target: { kind: "pull-request", number: 42 },
    inputRevision: { head: HEAD, base: BASE },
    branch: "pr-42",
    worktreePath,
    agentName: "demo-pr-42-branch-update-x",
    workspaceLabel: "demo-pr-42-branch-update-x",
    promptFile: path.join(runDir, "branch-update-prompt.md"),
    promiseFile,
    phase: "agent_started",
    lastSuccessfulPhase: "agent_started",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    rootPaneId: "pane-1",
  })}\n`);
}

function buildWorld(world: BranchUpdateFailureWorld): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-update-failure-acceptance-"));
  const runDir = path.join(root, "runs", ATTEMPT_ID);
  const worktreePath = path.join(root, "worktrees", "pr-42");
  const promiseFile = path.join(runDir, "promise.json");
  writeStoppedUpdateRecord(runDir, promiseFile, worktreePath);

  const target = {
    number: 42,
    state: "OPEN",
    headRefOid: HEAD,
    labels: ["agent:in-progress", "triage"],
  };
  const comments: Array<{ body: string; user: { login: string }; created_at: string; updated_at: string }> = [];
  let open = true;
  const runnerStub = {
    listAgents: () => open ? [{ name: "demo-pr-42-branch-update-x", paneId: "pane-1", cwd: worktreePath, status: "done" }] : [],
    listWorkspaces: () => open ? [{ workspaceId: "workspace-1", worktreePath, tabCount: 1, paneCount: 1 }] : [],
    listWorktrees: () => [{ path: worktreePath }],
    closeWorkspace: () => { open = false; },
  };
  const commandRunner = {
    runText: () => world.terminalEvidence || "terminal failure",
    runJson: (_args: string[], options: { input?: string } = {}) => {
      if (options.input) target.labels = JSON.parse(options.input).labels;
      return target.labels;
    },
  };
  const github = {
    getIssue: () => ({ ...target }),
    getPr: () => ({ ...target }),
    listIssueComments: () => [...comments],
    listPrComments: () => [...comments],
    commentIssue: (_repo: string, _number: number, body: string) => comments.push({
      user: { login: "deadloop-bot" }, body, created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(),
    }),
    commentPr: (_repo: string, _number: number, body: string) => comments.push({
      user: { login: "deadloop-bot" }, body, created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(),
    }),
  };
  Object.assign(world, {
    root,
    runDir,
    promiseFile,
    worktreePath,
    runnerStub,
    prTarget: target,
    comments,
    handoff: {
      kind: "branch-update",
      input: {
        attemptRecordFile: path.join(runDir, "attempt.json"),
        promiseFile,
        prNumber: 42,
        expectedHeadOid: HEAD,
        expectedBaseOid: BASE,
        branch: "pr-42",
        automationDir: "/automation",
        actorName: "branch-update worker",
        projectId: "demo",
        repoPath: root,
        githubRepo: "owner/repo",
        stateDir: root,
        enabledAt: 1,
      },
    },
    project: {
      id: "demo",
      repoPath: root,
      githubRepo: "owner/repo",
      stateDir: root,
      enabledAt: 1,
      automationLogin: "deadloop-bot",
      labels: {
        explore: "agent:explore",
        implement: "agent:implement",
        review: "agent:review",
        updateBranch: "agent:update-branch",
        inProgress: "agent:in-progress",
        blocked: "agent:blocked",
      },
    },
    stubDependencies: {
      commandRunner,
      runner: runnerStub,
      github,
      withEnabledProjectLock: (
        _project: unknown,
        operation: (enabled: unknown, recheck: () => void) => boolean,
      ) => operation({}, () => undefined),
    },
  });
}

/** Simulates the one formal channel deadloop owns: its completion-report read fails with ENOSPC. */
function withBrokenReportRead<T>(world: BranchUpdateFailureWorld, operation: () => T): T {
  if (!world.brokenReportRead || !world.promiseFile) return operation();
  const nodeFs = require("node:fs");
  const realReadFileSync = nodeFs.readFileSync;
  nodeFs.readFileSync = (file: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) => {
    if (String(file) === world.promiseFile) throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
    return (realReadFileSync as (...args: unknown[]) => string)(file, ...rest);
  };
  try {
    return operation();
  } finally {
    nodeFs.readFileSync = realReadFileSync;
  }
}

function driveMonitoringOnce(world: BranchUpdateFailureWorld): void {
  if (!world.handoff || !world.runDir || !world.runnerStub || !world.stubDependencies || !world.project) {
    throw new Error("branch-update attempt state is missing");
  }
  const entry: Record<string, unknown> = {
    pendingDriverHandoff: { action: "monitor", monitorHandoff: world.handoff },
  };
  deliverPendingDriverHandoff(entry, { automations: {} }, "PR reviewer", {
    enabledAt: () => 1,
    isEnabled: () => true,
    observeAttemptMonitoring: (_handoff: Record<string, unknown>, accounting: unknown, now: number) =>
      observeAttemptMonitoringDirective(readAttemptRecord(world.runDir!), accounting as never, now, 86_400_000, {
        runner: world.runnerStub as never,
        readTerminalEvidence: () => world.terminalEvidence || "terminal failure",
      }),
    applyAttemptMonitoring: (handoff: Record<string, unknown>, directive: never) =>
      applyDeterministicAttemptMonitoring(handoff, directive, (currentHandoff, disposition) =>
        applyTerminalMonitorDisposition({
          handoff: currentHandoff,
          disposition,
          project: world.project!,
        }, world.stubDependencies as never)),
    retryModelWait: () => false,
    now: () => NOW,
    saveState: () => undefined,
  });
}

Given("A pull request under branch update whose update worker stopped without writing a completion report", function (this: BranchUpdateFailureWorld) {
  this.terminalEvidence = "terminal failure";
  buildWorld(this);
});

Given("A pull request under branch update whose update worker stopped while deadloop could not read the completion report because the host ran out of storage", function (this: BranchUpdateFailureWorld) {
  this.terminalEvidence = "write failed: ENOSPC: no space left on device";
  this.brokenReportRead = true;
  buildWorld(this);
});

Given("A pull request under branch update whose update worker stopped with pane output naming ENOSPC but no formal storage failure", function (this: BranchUpdateFailureWorld) {
  this.terminalEvidence = "write failed: ENOSPC: no space left on device";
  buildWorld(this);
});

When("deadloop applies deterministic attempt monitoring to the stopped update", function (this: BranchUpdateFailureWorld) {
  withBrokenReportRead(this, () => driveMonitoringOnce(this));
});

Then("deadloop replaces the active update claim with agent:blocked", function (this: BranchUpdateFailureWorld) {
  assert.deepEqual(this.prTarget?.labels, ["triage", "agent:blocked"]);
});

Then("deadloop posts one stop explanation for the stopped update", function (this: BranchUpdateFailureWorld) {
  assert.equal(this.comments?.length, 1);
});

Then("The stop explanation is bound to the update attempt, the exact pull request head, and the selected base", function (this: BranchUpdateFailureWorld) {
  assert.ok(String(this.comments?.[0]?.body)
    .includes(`<!-- deadloop:terminal-monitor-stop attempt=${ATTEMPT_ID} head=${HEAD} base=${BASE} reason=missing_completion_report -->`));
});

Then("The stopped update releases its ownership as a terminal missing-report failure and keeps its worktree", function (this: BranchUpdateFailureWorld) {
  const record = readAttemptRecord(this.runDir!);
  const retained = (this.runnerStub as { listWorktrees(): Array<{ path: string }> }).listWorktrees()
    .some((worktree) => worktree.path === this.worktreePath);
  assert.deepEqual(
    { phase: record.phase, reason: record.authorityRelease.reason, worktreeRetained: retained },
    { phase: "authority_released", reason: "terminal_missing_report", worktreeRetained: true },
  );
});

Then("The capacity stop names the observed storage exhaustion with recovery steps and no local paths on the update PR", function (this: BranchUpdateFailureWorld) {
  const body = String(this.comments?.[0]?.body || "");
  assert.deepEqual(
    {
      capacityText: body.includes("ENOSPC or EDQUOT") && body.includes("free up storage on the machine running deadloop"),
      localPathLeak: body.includes(this.worktreePath!) || body.includes(this.promiseFile!),
    },
    { capacityText: true, localPathLeak: false },
  );
});

Then("The published update stop stays a generic technical failure", function (this: BranchUpdateFailureWorld) {
  const body = String(this.comments?.[0]?.body || "");
  assert.deepEqual(
    {
      genericText: body.includes("without a valid completion report"),
      capacityText: body.includes("free up storage"),
    },
    { genericText: true, capacityText: false },
  );
});

Given("A pull request blocked by a published branch-update runtime failure that gained a new agent:update-branch request after the block", function (this: BranchUpdateFailureWorld) {
  // The retained journal of the stopped update: deadloop's own record of what the old attempt was.
  const stateRoot = fixtureStateDir();
  const stoppedRunDir = path.join(stateRoot, "runs", STOP_ATTEMPT_ID);
  const stoppedWorktreePath = path.join(fs.realpathSync(os.tmpdir()), `deadloop-update-recovery-${STOP_ATTEMPT_ID}`, "worktrees", "pr-42");
  fs.mkdirSync(path.dirname(stoppedWorktreePath), { recursive: true });
  fs.mkdirSync(stoppedRunDir, { recursive: true });
  fs.writeFileSync(path.join(stoppedRunDir, "attempt.json"), `${JSON.stringify({
    attemptId: STOP_ATTEMPT_ID,
    launchUuid: "launch-restart-1",
    project: "demo",
    repository: "owner/repo",
    role: "branch-update",
    target: { kind: "pull-request", number: 42 },
    inputRevision: { head: HEAD, base: BASE },
    branch: "pr-42",
    worktreePath: stoppedWorktreePath,
    agentName: "demo-pr-42-branch-update-x",
    workspaceLabel: "demo-pr-42-branch-update-x",
    promptFile: path.join(stoppedRunDir, "branch-update-prompt.md"),
    promiseFile: path.join(stoppedRunDir, "promise.json"),
    phase: "authority_released",
    lastSuccessfulPhase: "agent_started",
    authorityRelease: { reason: "terminal_missing_report", releasedAt: "2026-07-03T00:00:00Z" },
  })}\n`);

  const stopComment = `deadloop stopped this attempt because its agent turn ended without a valid completion report. No monitor prompt will be redelivered. Inspect the retained attempt evidence, then add a new Agent request after resolving the failure.\nPull request head at selection: \`${HEAD}\`\nSelected base head at selection: \`${BASE}\`\n\n<!-- deadloop:terminal-monitor-stop attempt=${STOP_ATTEMPT_ID} head=${HEAD} base=${BASE} reason=missing_completion_report -->`;
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-update-recovery-"));
  const fixturePath = path.join(fixtureDirectory, "recovery.json");
  fs.writeFileSync(fixturePath, JSON.stringify({
    automationLogin: "deadloop-bot",
    prs: [{
      number: 42,
      title: "PR whose branch update stopped without a completion report",
      url: "https://github.com/owner/repo/pull/42",
      headRefName: "pr-42",
      headRefOid: HEAD,
      updatedAt: "2026-07-04T00:00:00Z",
      isCrossRepository: false,
      isDraft: false,
      labels: [{ name: "agent:update-branch" }, { name: "agent:blocked" }],
      statusCheckRollup: [],
      comments: [
        { createdAt: "2026-07-02T00:00:00Z", author: { login: "deadloop-bot" }, body: `Starting one guarded merge update for the current PR/base pair.\n\n${renderBranchUpdateMarker(HEAD, BASE)}` },
        { createdAt: "2026-07-03T00:00:00Z", author: { login: "deadloop-bot" }, body: stopComment },
      ],
      reviewRequests: [],
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      timelineEvents: [
        {
          id: "30",
          event: "labeled",
          created_at: "2026-07-03T00:06:00Z",
          actor: { login: "deadloop-bot" },
          label: { name: "agent:blocked" },
        },
        {
          id: "31",
          event: "labeled",
          created_at: "2026-07-03T01:00:00Z",
          actor: { login: "human" },
          label: { name: "agent:update-branch" },
        },
      ],
    }],
    agents: { result: { agents: [] } },
    branchUpdate: { action: "delegate_worker", reason: "merge_conflict", baseOid: BASE },
  }));
  this.recoveryFixturePath = fixturePath;
});

When("deadloop processes the pull request queue after the update block", function (this: BranchUpdateFailureWorld) {
  if (!this.recoveryFixturePath) throw new Error("recovery pull request state is missing");
  this.driverResult = runPrReviewerDriverFixture(this.recoveryFixturePath);
});

Then("deadloop relaunches the stopped update contract through a new branch-update monitor handoff", function (this: BranchUpdateFailureWorld) {
  const handoff = (this.driverResult as unknown as { monitorHandoff?: { kind?: string; input?: { expectedHeadOid?: string; expectedBaseOid?: string } } })?.monitorHandoff;
  assert.deepEqual(
    {
      action: this.driverResult?.driverAction,
      starts: this.driverResult?.testAdapterEffects?.herdrStarts?.length ?? 0,
      handoffKind: handoff?.kind,
      expectedHead: handoff?.input?.expectedHeadOid,
      expectedBase: handoff?.input?.expectedBaseOid,
    },
    { action: "branch_update_monitor_request", starts: 1, handoffKind: "branch-update", expectedHead: HEAD, expectedBase: BASE },
  );
});
