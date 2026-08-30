import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

import { deliverPendingDriverHandoff } from "../../src/automation-runner";
import { runPrReviewerDriverFixture } from "../support/pr-reviewer-driver";

const { applyDeterministicAttemptMonitoring } = require("../../src/deterministic-attempt-monitor-runtime.cts");
const { applyTerminalMonitorDisposition } = require("../../extensions/deadloop/automations/contain-terminal-monitor.cts");
const { readAttemptRecord } = require("../../src/attempt-lifecycle-runtime.cjs");
const { observeAttemptMonitoringDirective } = require("../../src/monitor-handoff-observation.cts");

const HEAD = "a".repeat(40);
const NOW = Date.parse("2026-08-26T00:05:00Z");

type ReviewerFailureWorld = {
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
  labels?: string[];
  prTarget?: { labels: string[]; headRefOid: string };
  comments?: Array<{ body: string; user: { login: string }; created_at: string; updated_at: string }>;
  driverResult?: ReturnType<typeof runPrReviewerDriverFixture>;
  recoveryFixturePath?: string;
};

function writeAttemptRecord(runDir: string, promiseFile: string, worktreePath: string): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(runDir, "attempt.json"), `${JSON.stringify({
    attemptId: "attempt-1",
    launchUuid: "launch-1",
    project: "demo",
    repository: "owner/repo",
    role: "reviewer",
    target: { kind: "pull-request", number: 42 },
    inputRevision: { head: HEAD },
    branch: "pr-42",
    worktreePath,
    agentName: "reviewer",
    workspaceLabel: "reviewer 42",
    promptFile: path.join(runDir, "prompt.md"),
    promiseFile,
    phase: "agent_started",
    lastSuccessfulPhase: "agent_started",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    rootPaneId: "pane-1",
  })}\n`);
}

function buildWorld(world: ReviewerFailureWorld): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-reviewer-failure-acceptance-"));
  const runDir = path.join(root, "runs", "attempt-1");
  const worktreePath = path.join(root, "worktrees", "pr-42");
  const promiseFile = path.join(runDir, "promise.json");
  writeAttemptRecord(runDir, promiseFile, worktreePath);

  const target = {
    number: 42,
    state: "OPEN",
    headRefOid: HEAD,
    labels: ["agent:review", "agent:in-progress", "triage"],
  };
  const comments: Array<{ body: string; user: { login: string }; created_at: string; updated_at: string }> = [];
  let open = true;
  const runnerStub = {
    listAgents: () => open ? [{ name: "reviewer", paneId: "pane-1", cwd: worktreePath, status: "done" }] : [],
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
    labels: target.labels,
    handoff: {
      kind: "reviewer",
      input: {
        attemptRecordFile: path.join(runDir, "attempt.json"),
        promiseFile,
        prNumber: 42,
        expectedHeadOid: HEAD,
        branch: "pr-42",
        automationDir: "/automation",
        actorName: "reviewer",
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
function withBrokenReportRead<T>(world: ReviewerFailureWorld, operation: () => T): T {
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

function driveMonitoringOnce(world: ReviewerFailureWorld): void {
  if (!world.handoff || !world.runDir || !world.runnerStub || !world.stubDependencies || !world.project) {
    throw new Error("reviewer attempt state is missing");
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

Given("A pull request under review whose reviewer stopped without writing a completion report", function (this: ReviewerFailureWorld) {
  this.terminalEvidence = "terminal failure";
  buildWorld(this);
});

Given("A pull request under review whose reviewer stopped while deadloop could not read the completion report because the host ran out of storage", function (this: ReviewerFailureWorld) {
  this.terminalEvidence = "write failed: ENOSPC: no space left on device";
  this.brokenReportRead = true;
  buildWorld(this);
});

Given("A pull request under review whose reviewer stopped with pane output naming ENOSPC but no formal storage failure", function (this: ReviewerFailureWorld) {
  this.terminalEvidence = "write failed: ENOSPC: no space left on device";
  buildWorld(this);
});

When("deadloop applies deterministic attempt monitoring", function (this: ReviewerFailureWorld) {
  withBrokenReportRead(this, () => driveMonitoringOnce(this));
});

Then("deadloop replaces the active review state with agent:blocked", function (this: ReviewerFailureWorld) {
  assert.deepEqual(this.prTarget?.labels, ["triage", "agent:blocked"]);
});

Then("deadloop posts one stop explanation on the pull request", function (this: ReviewerFailureWorld) {
  assert.equal(this.comments?.length, 1);
});

Then("The stop explanation is bound to the attempt and the exact pull request head", function (this: ReviewerFailureWorld) {
  assert.ok(String(this.comments?.[0]?.body)
    .includes(`<!-- deadloop:terminal-monitor-stop attempt=attempt-1 head=${HEAD} reason=add_request -->`));
});

Then("The stopped attempt releases its ownership as a terminal missing-report failure", function (this: ReviewerFailureWorld) {
  const record = readAttemptRecord(this.runDir!);
  assert.deepEqual(
    { phase: record.phase, reason: record.authorityRelease.reason },
    { phase: "authority_released", reason: "terminal_missing_report" },
  );
});

Then("The capacity stop names the observed storage exhaustion with recovery steps and no local paths", function (this: ReviewerFailureWorld) {
  const body = String(this.comments?.[0]?.body || "");
  assert.deepEqual(
    {
      capacityText: body.includes("ENOSPC or EDQUOT") && body.includes("free up storage on the machine running deadloop"),
      localPathLeak: body.includes(this.worktreePath!) || body.includes(this.promiseFile!),
    },
    { capacityText: true, localPathLeak: false },
  );
});

Then("The published stop stays a generic technical failure", function (this: ReviewerFailureWorld) {
  const body = String(this.comments?.[0]?.body || "");
  assert.deepEqual(
    {
      genericText: body.includes("without a valid completion report"),
      capacityText: body.includes("free up storage"),
    },
    { genericText: true, capacityText: false },
  );
});

Given("A pull request blocked by a reviewer runtime failure that gained a new agent:review request after the block", function (this: ReviewerFailureWorld) {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-reviewer-recovery-"));
  const fixturePath = path.join(fixtureDirectory, "recovery.json");
  fs.writeFileSync(fixturePath, JSON.stringify({
    prs: [{
      number: 42,
      title: "PR awaiting re-review after a reviewer runtime failure",
      url: "https://github.com/owner/repo/pull/42",
      headRefName: "pr-42",
      headRefOid: HEAD,
      updatedAt: "2026-07-04T00:00:00Z",
      isDraft: false,
      labels: [{ name: "agent:review" }, { name: "agent:blocked" }],
      statusCheckRollup: [],
      comments: [{
        createdAt: "2026-07-03T00:00:00Z",
        author: { login: "deadloop-bot" },
        body: `deadloop stopped this attempt because its agent turn ended without a valid completion report. No monitor prompt will be redelivered. Inspect the retained attempt evidence, then add a new Agent request after resolving the failure.\nPull request head at selection: \`${HEAD}\`\n\n<!-- deadloop:terminal-monitor-stop attempt=attempt-1 head=${HEAD} reason=add_request -->`,
      }],
      reviewRequests: [],
      timelineEvents: [
        {
          id: "30",
          event: "labeled",
          created_at: "2026-07-03T00:00:00Z",
          actor: { login: "deadloop-bot" },
          label: { name: "agent:blocked" },
        },
        {
          id: "31",
          event: "labeled",
          created_at: "2026-07-03T01:00:00Z",
          actor: { login: "human" },
          label: { name: "agent:review" },
        },
      ],
    }],
    agents: { result: { agents: [] } },
  }));
  this.recoveryFixturePath = fixturePath;
});

When("deadloop processes the review target after recovery", function (this: ReviewerFailureWorld) {
  if (!this.recoveryFixturePath) throw new Error("recovery pull request state is missing");
  this.driverResult = runPrReviewerDriverFixture(this.recoveryFixturePath);
});

Then("deadloop consumes the new review request through the recovery view", function (this: ReviewerFailureWorld) {
  assert.deepEqual({
    action: this.driverResult?.driverAction,
    starts: this.driverResult?.testAdapterEffects?.herdrStarts?.length ?? 0,
  }, { action: "reviewer_monitor_request", starts: 1 });
});
