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
const { renderRepairMarker, repairAttemptKey, reviewResultFingerprint } = require("../../extensions/deadloop/automations/pr-review-repair-state.cts");

const HEAD = "a".repeat(40);
const NOW = Date.parse("2026-08-26T00:05:00Z");
const FINDINGS = [{ title: "Lint contract failure", body: "Restore the lint gate", path: "src/a.ts", line: 4, severity: "blocker" }];
const REPAIR_KEY = repairAttemptKey(HEAD, reviewResultFingerprint(FINDINGS));

type RepairFailureWorld = {
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
  driverResult?: ReturnType<typeof runPrReviewerDriverFixture>;
  recoveryFixturePath?: string;
};

function writeStoppedRepairRecord(root: string): { runDir: string; worktreePath: string; promiseFile: string } {
  const runDir = path.join(root, "runs", "attempt-1");
  const worktreePath = path.join(root, "worktrees", "pr-42");
  const promiseFile = path.join(runDir, "promise.json");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(runDir, "attempt.json"), `${JSON.stringify({
    attemptId: REPAIR_KEY,
    launchUuid: "launch-1",
    project: "demo",
    repository: "owner/repo",
    role: "review-repair",
    target: { kind: "pull-request", number: 42 },
    inputRevision: { head: HEAD },
    branch: "pr-42",
    worktreePath,
    agentName: "demo-pr-42-review-repair",
    workspaceLabel: "demo-pr-42-review-repair",
    promptFile: path.join(runDir, "repair-prompt.md"),
    promiseFile,
    phase: "agent_started",
    lastSuccessfulPhase: "agent_started",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    rootPaneId: "pane-1",
  })}\n`);
  return { runDir, worktreePath, promiseFile };
}

function buildWorld(world: RepairFailureWorld): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-repair-failure-acceptance-"));
  const { runDir, worktreePath, promiseFile } = writeStoppedRepairRecord(root);

  const target = {
    number: 42,
    state: "OPEN",
    headRefOid: HEAD,
    labels: ["agent:implement", "agent:in-progress", "triage"],
  };
  const comments: Array<{ body: string; user: { login: string }; created_at: string; updated_at: string }> = [];
  let open = true;
  let workspaceClosed = false;
  const runnerStub = {
    listAgents: () => open ? [{ name: "demo-pr-42-review-repair", paneId: "pane-1", cwd: worktreePath, status: "done" }] : [],
    listWorkspaces: () => open ? [{ workspaceId: "workspace-1", worktreePath, tabCount: 1, paneCount: 1 }] : [],
    listWorktrees: () => [{ path: worktreePath }],
    closeWorkspace: () => { open = false; workspaceClosed = true; },
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
    workspaceClosed,
    handoff: {
      kind: "repair",
      input: {
        attemptRecordFile: path.join(runDir, "attempt.json"),
        promiseFile,
        prNumber: 42,
        expectedHeadOid: HEAD,
        branch: "pr-42",
        automationDir: "/automation",
        actorName: "review-repair worker",
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
function withBrokenReportRead<T>(world: RepairFailureWorld, operation: () => T): T {
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

function driveMonitoringOnce(world: RepairFailureWorld): void {
  if (!world.handoff || !world.runDir || !world.runnerStub || !world.stubDependencies || !world.project) {
    throw new Error("repair attempt state is missing");
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

Given("A pull request under automatic repair whose repair worker stopped without writing a completion report", function (this: RepairFailureWorld) {
  this.terminalEvidence = "terminal failure";
  buildWorld(this);
});

Given("A pull request under automatic repair whose repair worker stopped while deadloop could not read the completion report because the host ran out of storage", function (this: RepairFailureWorld) {
  this.terminalEvidence = "write failed: ENOSPC: no space left on device";
  this.brokenReportRead = true;
  buildWorld(this);
});

Given("A pull request under automatic repair whose repair worker stopped with pane output naming ENOSPC but no formal storage failure", function (this: RepairFailureWorld) {
  this.terminalEvidence = "write failed: ENOSPC: no space left on device";
  buildWorld(this);
});

When("deadloop applies deterministic attempt monitoring to the stopped repair", function (this: RepairFailureWorld) {
  withBrokenReportRead(this, () => driveMonitoringOnce(this));
});

Then("deadloop replaces the active repair state with agent:blocked", function (this: RepairFailureWorld) {
  assert.deepEqual(this.prTarget?.labels, ["triage", "agent:blocked"]);
});

Then("deadloop posts one stop explanation for the stopped repair", function (this: RepairFailureWorld) {
  assert.equal(this.comments?.length, 1);
});

Then("The stop explanation is bound to the repair attempt key and the exact pull request head", function (this: RepairFailureWorld) {
  assert.ok(String(this.comments?.[0]?.body)
    .includes(`<!-- deadloop:terminal-monitor-stop attempt=${REPAIR_KEY} head=${HEAD} reason=missing_completion_report -->`));
});

Then("The stopped attempt releases its ownership as a terminal missing-report failure and keeps its worktree", function (this: RepairFailureWorld) {
  const record = readAttemptRecord(this.runDir!);
  const worktrees = (this.runnerStub as { listWorktrees(): Array<{ path: string }> }).listWorktrees();
  assert.deepEqual(
    {
      phase: record.phase,
      reason: record.authorityRelease.reason,
      worktreeRetained: worktrees.some((worktree) => worktree.path === this.worktreePath),
    },
    { phase: "authority_released", reason: "terminal_missing_report", worktreeRetained: true },
  );
});

Then("The capacity stop names the observed storage exhaustion with recovery steps and no local paths on the repair PR", function (this: RepairFailureWorld) {
  const body = String(this.comments?.[0]?.body || "");
  assert.deepEqual(
    {
      capacityText: body.includes("ENOSPC or EDQUOT") && body.includes("free up storage on the machine running deadloop"),
      localPathLeak: body.includes(this.worktreePath!) || body.includes(this.promiseFile!),
    },
    { capacityText: true, localPathLeak: false },
  );
});

Then("The published stop stays a generic technical failure for the repair", function (this: RepairFailureWorld) {
  const body = String(this.comments?.[0]?.body || "");
  assert.deepEqual(
    {
      genericText: body.includes("without a valid completion report"),
      capacityText: body.includes("free up storage"),
    },
    { genericText: true, capacityText: false },
  );
});

Given("A blocked repair runtime failure that gained a new agent:implement request after the block", function (this: RepairFailureWorld) {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-repair-recovery-"));
  const fixturePath = path.join(fixtureDirectory, "recovery.json");

  // ADR 0032: the findings contract is the one persisted on GitHub — the repair attempt marker
  // carries it as an encoded payload. The stop explanation from #258's terminal monitor sits beside
  // it, and the queued agent:implement request strictly post-dates the block.
  const reviewCommentBody = `## Review result: changes required\n\n${renderRepairMarker(HEAD, reviewResultFingerprint(FINDINGS), { findings: FINDINGS })}\n<!-- deadloop:review-result head=${HEAD} review=${reviewResultFingerprint(FINDINGS)} outcome=changes_requested -->`;
  fs.writeFileSync(fixturePath, JSON.stringify({
    prs: [{
      number: 42,
      title: "PR whose repair stopped without a completion report",
      url: "https://github.com/owner/repo/pull/42",
      headRefName: "pr-42",
      headRefOid: HEAD,
      updatedAt: "2026-07-04T00:00:00Z",
      isCrossRepository: false,
      isDraft: false,
      labels: [{ name: "agent:implement" }, { name: "agent:blocked" }],
      statusCheckRollup: [],
      comments: [
        { createdAt: "2026-07-02T00:00:00Z", author: { login: "deadloop-bot" }, body: reviewCommentBody },
        {
          createdAt: "2026-07-03T00:05:00Z",
          author: { login: "deadloop-bot" },
          body: `deadloop stopped this attempt because its agent turn ended without a valid completion report. No monitor prompt will be redelivered. Inspect the retained attempt evidence, then add a new Agent request after resolving the failure.\nPull request head at selection: \`${HEAD}\`\n\n<!-- deadloop:terminal-monitor-stop attempt=${REPAIR_KEY} head=${HEAD} reason=missing_completion_report -->`,
        },
      ],
      reviewRequests: [],
      mergeable: "MERGEABLE",
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
          label: { name: "agent:implement" },
        },
      ],
    }],
    agents: { result: { agents: [] } },
  }));
  this.recoveryFixturePath = fixturePath;
});

When("deadloop processes the pull request request queue after recovery", function (this: RepairFailureWorld) {
  if (!this.recoveryFixturePath) throw new Error("recovery pull request state is missing");
  this.driverResult = runPrReviewerDriverFixture(this.recoveryFixturePath);
});

Then("deadloop relaunches the stopped repair contract through a new repair monitor handoff", function (this: RepairFailureWorld) {
  const handoff = (this.driverResult as unknown as { monitorHandoff?: { kind?: string; input?: { attemptKey?: string; expectedHeadOid?: string } } })?.monitorHandoff;
  assert.deepEqual({
    action: this.driverResult?.driverAction,
    starts: this.driverResult?.testAdapterEffects?.herdrStarts?.length ?? 0,
    handoffKind: handoff?.kind,
    attemptKey: handoff?.input?.attemptKey,
    expectedHead: handoff?.input?.expectedHeadOid,
  }, {
    action: "review_repair_monitor_request",
    starts: 1,
    handoffKind: "repair",
    attemptKey: REPAIR_KEY,
    expectedHead: HEAD,
  });
});
