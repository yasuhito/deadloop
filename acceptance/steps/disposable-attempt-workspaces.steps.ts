import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

import type { AttemptRecord, CompletionReportV1 } from "../../src/attempt-lifecycle";
import {
  attemptRecordPath,
  createPreparedAttempt,
  readAttemptRecord,
  recordPersistedCompletionReport,
  transitionPersistedAttempt,
  writeAttemptRecordAtomically,
} from "../../src/attempt-lifecycle";
import { evaluateCompletionPersistence, orchestrateFreshAttemptWorkspace, reconcileAttemptWorkspace } from "../../src/attempt-workspace-lifecycle";
import { runScheduledAutomation } from "../../src/automation-runner";
import { normalizeProject } from "../../src/core";

const { envConfig: workerEnvironment, launchIssueWorkerFlow } = require("../../extensions/deadloop/automations/issue-coordinator-driver.ts");
const { envConfig: reviewerEnvironment, launchBranchUpdate, launchPrReviewerFlow } = require("../../extensions/deadloop/automations/pr-reviewer-driver.ts");
const { envConfig: repairEnvironment, launchRepair, recordRepairLaunchGithubClaim } = require("../../extensions/deadloop/automations/pr-review-repair-dispatch.ts");
const { selectCleanupPlan } = require("../../extensions/deadloop/automations/cleanup-completed-worker-worktrees.ts");

const inputHead = "a".repeat(40);
const outputHead = "b".repeat(40);

type World = {
  root?: string;
  record?: AttemptRecord;
  report?: any;
  github?: any;
  result?: any;
  worktreeExists?: boolean;
  priorWorkspace?: any;
  currentWorkspace?: any;
  mutationCount?: number;
  layoutObservation?: { workspaces: Array<{ workspace_id: string; tab_count: number; pane_count: number }>; extraLayoutActions: string[] };
  runDir?: string;
};

function workerFixture(): { record: AttemptRecord; report: any; github: any } {
  const record: AttemptRecord = {
    attemptId: "attempt-1", launchUuid: "launch-1", project: "demo", repository: "owner/repo",
    role: "worker", target: { kind: "issue", number: 12 }, inputRevision: { head: inputHead },
    branch: "agent/issue-12", baseBranch: "origin/main", worktreePath: "/worktrees/issue-12",
    agentName: "dl-w-12-123456789abc", workspaceLabel: "Issue 12", promptFile: "/runs/1/prompt.md",
    promiseFile: "/runs/1/promise.json", phase: "agent_started", lastSuccessfulPhase: "agent_started",
    workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1", outputRevision: outputHead,
  };
  const report = {
    schemaVersion: 1, attemptId: record.attemptId, role: "worker", target: { repository: record.repository, ...record.target },
    inputRevision: record.inputRevision, status: "complete", summary: "Implemented and validated.",
    result: { outputRevision: outputHead }, evidence: { validations: ["npm test passed"] },
  };
  const marker = {
    attemptId: record.attemptId, role: record.role, repository: record.repository, target: record.target,
    inputHead, outcome: "complete", outputRevision: outputHead,
  };
  const github = {
    kind: "confirmed", role: "worker", repository: record.repository, target: record.target, issueClaimable: false,
    pullRequests: [{
      repository: record.repository, target: record.target, state: "open", headBranch: record.branch,
      headSha: outputHead, baseBranch: record.baseBranch, closesIssue: 12, labels: ["agent:review"], marker,
    }],
  };
  return { record, report, github };
}

function persistFixtureJournal(world: World, phase: "report_received" | "github_persisted" = "report_received"): void {
  const root = world.root ?? mkdtempSync(path.join(os.tmpdir(), "deadloop-cucumber-journal-"));
  world.root = root;
  const runDir = path.join(root, "runs", world.record!.launchUuid);
  world.runDir = runDir;
  const source = world.record!;
  createPreparedAttempt(runDir, {
    attemptId: source.attemptId, launchUuid: source.launchUuid, project: source.project, repository: source.repository,
    role: source.role, target: source.target, inputRevision: source.inputRevision, branch: source.branch,
    ...(source.baseBranch ? { baseBranch: source.baseBranch } : {}), worktreePath: source.worktreePath,
    agentName: source.agentName, workspaceLabel: source.workspaceLabel, promptFile: source.promptFile,
    promiseFile: source.promiseFile,
  });
  transitionPersistedAttempt(runDir, "github_claimed");
  const claimed = readAttemptRecord(runDir);
  writeAttemptRecordAtomically(attemptRecordPath(runDir), {
    ...claimed,
    workspaceId: source.workspaceId,
    tabId: source.tabId,
    rootPaneId: source.rootPaneId,
    phase: "workspace_opened",
    lastSuccessfulPhase: "workspace_opened",
  });
  transitionPersistedAttempt(runDir, "agent_started");
  recordPersistedCompletionReport(runDir, world.report as CompletionReportV1);
  if (phase === "github_persisted") transitionPersistedAttempt(runDir, "github_persisted");
  world.record = readAttemptRecord(runDir);
}

Given("新しい作業試行を開始できる", function (this: World) {
  this.root = mkdtempSync(path.join(os.tmpdir(), "deadloop-cucumber-workspace-"));
});

When("deadloop が担当を起動する", function (this: World) {
  const root = this.root!;
  let launchedName = "";
  this.layoutObservation = { workspaces: [], extraLayoutActions: [] };
  let worktreePath = "";
  const runner = {
    createWorktree: (input: { branch: string }) => {
      worktreePath = path.join(root, input.branch.replace(/\//g, "-"));
      this.layoutObservation!.workspaces.push({ workspace_id: "workspace-1", tab_count: 1, pane_count: 1 });
      return { workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1", worktreePath };
    },
    openWorktree: () => { throw new Error("Worker must use the create path"); },
    renameWorkspace: () => "", startAgent: () => "", closeWorkspace: () => "", listWorkspaces: () => [],
    listWorktrees: () => [],
    listAgents: () => launchedName ? [{ name: launchedName, paneId: "pane-1", cwd: worktreePath, status: "working" }] : [],
    removeWorktree: () => "",
  };
  const env = workerEnvironment({
    DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: "/repo", DEADLOOP_GITHUB_REPO: "owner/repo",
    DEADLOOP_BASE_BRANCH: "origin/main", DEADLOOP_WORKTREE_ROOT: root, DEADLOOP_STATE_DIR: root,
  });
  this.result = launchIssueWorkerFlow({ number: 12, title: "one workspace" }, env, {
    mkdirSync: fs.mkdirSync,
    runner,
    runText: (args: string[]) => {
      if (args[0] === "herdr" && (args[1] === "tab" || args[1] === "pane")) this.layoutObservation!.extraLayoutActions.push(args.join(" "));
      const index = args.indexOf("--name");
      if (index >= 0) launchedName = args[index + 1];
      return args[0] === "git" ? `${inputHead}\n` : "started";
    },
    writeFileSync: fs.writeFileSync,
  });
});

Then("担当は一つの実行場所と一つの画面に表示される", function (this: World) {
  assert.deepEqual(this.layoutObservation, {
    workspaces: [{ workspace_id: this.result.workspaceId, tab_count: 1, pane_count: 1 }],
    extraLayoutActions: [],
  });
  rmSync(this.root!, { recursive: true, force: true });
});

Given("担当の PR と完了報告が一致している", function (this: World) {
  Object.assign(this, workerFixture());
  persistFixtureJournal(this);
  this.worktreeExists = true;
});

Given("担当が安全上の理由で作業を遮断した", function (this: World) {
  Object.assign(this, workerFixture());
  this.report = { ...this.report, status: "blocked", result: { reason: "unsafe", explanation: "unsafe", recovery: "inspect" }, evidence: {} };
});

Given("担当の完了報告が壊れている", function (this: World) {
  Object.assign(this, workerFixture());
  this.report = { status: "complete" };
});

Given("担当の結果を GitHub で確認できない", function (this: World) {
  Object.assign(this, workerFixture());
  this.github = { kind: "uncertain", reason: "timeout", detail: "GitHub timeout" };
});

When("deadloop が完了した試行を照合する", async function (this: World) {
  const decision = evaluateCompletionPersistence({
    record: this.record!, report: { kind: "v1", promisePath: this.record!.promiseFile, report: this.report }, github: this.github,
    context: { workerReviewLabel: "agent:review" },
  });
  if (decision.action === "preserve") {
    this.result = decision;
    this.worktreeExists = true;
    return;
  }
  this.result = await reconcileAttemptWorkspace({
    record: this.record!, report: { kind: "v1", promisePath: this.record!.promiseFile, report: this.report }, github: this.github,
    workspace: { kind: "confirmed", value: { exists: true, workspaceId: "workspace-1", ownerAttemptId: "attempt-1", canonicalWorktreePath: "/worktrees/issue-12" } },
    newerLiveOwner: { kind: "confirmed", value: false },
    context: { workerReviewLabel: "agent:review" },
  }, {
    persistPhase: (_record: AttemptRecord, phase: "github_persisted" | "workspace_closed") => transitionPersistedAttempt(this.runDir!, phase),
    closeWorkspace: () => ({ kind: "confirmed", value: undefined }),
    observeWorkspace: () => ({ kind: "confirmed", value: { exists: false } }),
    observeWorktree: () => ({ kind: "confirmed", value: { exists: true, canonicalPath: "/worktrees/issue-12", branch: "agent/issue-12" } }),
  });
  this.worktreeExists = true;
});

Then("担当の実行場所は消えて作業ツリーは残る", function (this: World) {
  assert.deepEqual({ action: this.result.action, phase: readAttemptRecord(this.runDir!).phase, worktree: this.worktreeExists }, {
    action: "closed", phase: "workspace_closed", worktree: true,
  });
  rmSync(this.root!, { recursive: true, force: true });
});

Given("作業担当の実行場所を安全に閉じている", function (this: World) {
  this.priorWorkspace = { workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1", canonicalWorktreePath: "/worktrees/issue-12" };
});

Given("レビュー結果を GitHub に保存して実行場所を閉じている", function (this: World) {
  this.priorWorkspace = { workspaceId: "workspace-2", tabId: "tab-2", rootPaneId: "pane-2", canonicalWorktreePath: "/worktrees/issue-12" };
});

function roleLaunchOps(root: string, workspaceId: string, onOpenWorktree?: () => void) {
  const worktreePath = path.join(root, "agent-issue-12");
  let launchedName = "";
  return {
    mkdirSync: fs.mkdirSync,
    runner: {
      createWorktree: () => { throw new Error("existing PR roles must open their linked worktree"); },
      openWorktree: () => {
        onOpenWorktree?.();
        return { workspaceId, tabId: `${workspaceId}-tab`, rootPaneId: `${workspaceId}-pane`, worktreePath };
      },
      renameWorkspace: () => "", startAgent: () => "", closeWorkspace: () => "", listWorkspaces: () => [],
      listWorktrees: () => [{ path: worktreePath, branch: "agent/issue-12" }],
      listAgents: () => launchedName ? [{ name: launchedName, paneId: `${workspaceId}-pane`, cwd: worktreePath, status: "working" }] : [],
      removeWorktree: () => "",
    },
    runText: (args: string[]) => {
      const index = args.indexOf("--name");
      if (index >= 0) launchedName = args[index + 1];
      return "started";
    },
    writeFileSync: fs.writeFileSync,
  };
}

function launchRepairBoundary(workspaceId: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-cucumber-review-repair-"));
  const env = repairEnvironment({
    projectId: "demo", repoPath: "/repo", githubRepo: "owner/repo", worktreeRoot: root, stateDir: root,
  });
  const branch = "agent/issue-12";
  const findings = [{ title: "Bounded defect", body: "Repair the selected defect", path: "src/a.ts", severity: "major" }];
  const key = "1234567890abcdef1234";
  const uuid = "cucumber-review-repair";
  const operations = roleLaunchOps(root, workspaceId);
  launchRepair("12", branch, inputHead, findings, key, env, undefined, uuid, true, operations);
  recordRepairLaunchGithubClaim("12", branch, inputHead, findings, key, env, uuid);
  const launched = launchRepair("12", branch, inputHead, findings, key, env, undefined, uuid, false, operations);
  rmSync(root, { recursive: true, force: true });
  return launched;
}

function launchBranchUpdateBoundary(workspaceId: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-cucumber-branch-update-"));
  const repoPath = path.join(root, "repo");
  const agentDir = path.join(root, "agent-state");
  const stateDir = path.join(agentDir, "deadloop");
  const worktreeRoot = path.join(root, "worktrees");
  const binDir = path.join(root, "bin");
  const enabledAt = 1;
  fs.mkdirSync(repoPath, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  execFileSync("git", ["-C", repoPath, "init", "--quiet"]);
  execFileSync("git", ["-C", repoPath, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  fs.writeFileSync(path.join(binDir, "gh"), "#!/bin/sh\nprintf '%s\\n' '{\"id\":\"R_fixture\"}'\n", "utf8");
  fs.chmodSync(path.join(binDir, "gh"), 0o755);
  fs.writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({
    projects: [{
      repoPath, githubRepo: "owner/repo", githubRepositoryId: "R_fixture", enabledAt, disableGeneration: 0,
      firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
      autoMergeAcknowledged: false, enabled: true,
    }],
  }), "utf8");

  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalPath = process.env.PATH;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PATH = `${binDir}:${originalPath || ""}`;
  try {
    const env = reviewerEnvironment({
      DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: repoPath, DEADLOOP_GITHUB_REPO: "owner/repo",
      DEADLOOP_WORKTREE_ROOT: worktreeRoot, DEADLOOP_STATE_DIR: stateDir, DEADLOOP_ENABLED_AT: String(enabledAt),
    });
    const pr = { number: 12, headRefName: "agent/issue-12", headRefOid: inputHead, labels: [] };
    let enablementGuardObserved = false;
    const operations = roleLaunchOps(worktreeRoot, workspaceId, () => {
      enablementGuardObserved = fs.existsSync(path.join(stateDir, "enabled-projects.json.lock"));
    });
    const launched = launchBranchUpdate(
      pr,
      env,
      { prs: [pr] },
      { headOid: inputHead, baseOid: "c".repeat(40) },
      { agentLaunchOps: operations },
    );
    return { ...launched, enablementGuardObserved };
  } finally {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(root, { recursive: true, force: true });
  }
}

When("deadloop がレビュー担当を起動する", function (this: World) {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-cucumber-reviewer-"));
  const env = reviewerEnvironment({
    DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: "/repo", DEADLOOP_GITHUB_REPO: "owner/repo",
    DEADLOOP_WORKTREE_ROOT: root, DEADLOOP_STATE_DIR: root,
  });
  this.currentWorkspace = launchPrReviewerFlow({
    number: 12, headRefName: "agent/issue-12", headRefOid: inputHead,
  }, env, "acceptance", roleLaunchOps(root, "workspace-2"));
  rmSync(root, { recursive: true, force: true });
});
When("deadloop が修正担当とブランチ更新担当を起動する", function (this: World) {
  this.currentWorkspace = {
    repair: launchRepairBoundary("workspace-3"),
    branchUpdate: launchBranchUpdateBoundary("workspace-4"),
  };
});

Then("レビュー担当は別の新しい実行場所を使う", function (this: World) {
  assert.notEqual(this.currentWorkspace.workspaceId, this.priorWorkspace.workspaceId);
});
Then("修正担当とブランチ更新担当はそれぞれ新しい実行場所を使う", function (this: World) {
  assert.deepEqual({
    prior: [this.priorWorkspace.workspaceId, this.priorWorkspace.tabId, this.priorWorkspace.rootPaneId],
    repair: [this.currentWorkspace.repair.workspaceId, this.currentWorkspace.repair.tabId, this.currentWorkspace.repair.rootPaneId],
    branchUpdate: [this.currentWorkspace.branchUpdate.workspaceId, this.currentWorkspace.branchUpdate.tabId, this.currentWorkspace.branchUpdate.rootPaneId],
    branchUpdateGuarded: this.currentWorkspace.branchUpdate.enablementGuardObserved,
  }, {
    prior: ["workspace-2", "tab-2", "pane-2"],
    repair: ["workspace-3", "workspace-3-tab", "workspace-3-pane"],
    branchUpdate: ["workspace-4", "workspace-4-tab", "workspace-4-pane"],
    branchUpdateGuarded: true,
  });
});
Then("担当の実行場所と作業ツリーを残す", function (this: World) { assert.equal(this.result.action, "preserve"); });

Given("自動化の実行元が対応外の Herdr に接続している", function (this: World) { this.mutationCount = 0; });

When("deadloop が自動化の周期を開始する", async function (this: World) {
  const project = normalizeProject({ id: "demo", repoPath: "/repo", githubRepo: "owner/repo", automations: [{ id: "a", name: "a" }] });
  try {
    await runScheduledAutomation(project, project.automations[0], 1, { automations: {} }, {
      compatibilityPreflight: () => { throw new Error("Herdr is unsupported"); }, now: () => 1,
      readPrompt: () => "", resolveAutomationFileInDir: () => ({ requested: "", resolved: "", found: false }),
      runDriver: async () => (this.mutationCount!++, { code: 0 }), runPrecheck: async () => (this.mutationCount!++, { code: 0 }),
      saveState: () => { this.mutationCount!++; }, sendUserMessage: () => { this.mutationCount!++; },
    });
  } catch {}
});

Then("GitHub と実行場所を変更せずに停止する", function (this: World) { assert.equal(this.mutationCount, 0); });

Given("同じ作業ツリーに調査中の実行場所が残っている", function (this: World) {
  this.priorWorkspace = { workspaceId: "workspace-retained", tabId: "tab-retained", rootPaneId: "pane-retained", canonicalWorktreePath: "/worktrees/issue-12" };
  this.mutationCount = 0;
});
When("deadloop が次の担当を検討する", async function (this: World) {
  this.result = await orchestrateFreshAttemptWorkspace({
    mode: "open", repoPath: "/repo", branch: "agent/issue-12", workspaceLabel: "retry",
    expectedCanonicalWorktreePath: "/worktrees/issue-12", priorAttempt: this.priorWorkspace,
  }, {
    reconcileRetainedAttempts: () => ({ kind: "confirmed", value: undefined }),
    observeMatchingWorkspaces: () => ({ kind: "confirmed", value: [{ exists: true, workspaceId: "workspace-retained", ownerAttemptId: "attempt-1", canonicalWorktreePath: "/worktrees/issue-12" }] }),
    createWorktree: () => { this.mutationCount!++; throw new Error("unexpected create"); },
    openWorktree: () => { this.mutationCount!++; throw new Error("unexpected open"); },
    renameWorkspace: () => { this.mutationCount!++; return { kind: "confirmed", value: undefined }; },
  });
});
Then("同じ作業ツリーには新しい担当を起動しない", function (this: World) {
  assert.deepEqual({ action: this.result.action, mutations: this.mutationCount }, { action: "rejected", mutations: 0 });
});

Given("GitHub への保存後に実行元が停止した", function (this: World) {
  Object.assign(this, workerFixture());
  persistFixtureJournal(this, "github_persisted");
  this.worktreeExists = true;
});
When("deadloop が再起動時に試行を照合する", async function (this: World) {
  const ambiguous = this.result?.ambiguous === true;
  this.result = await reconcileAttemptWorkspace({
    record: this.record!, report: { kind: "v1", promisePath: this.record!.promiseFile, report: this.report }, github: this.github,
    workspace: ambiguous
      ? { kind: "uncertain", reason: "ambiguous", detail: "owner cannot be identified" }
      : { kind: "confirmed", value: { exists: true, workspaceId: "workspace-1", ownerAttemptId: "attempt-1", canonicalWorktreePath: "/worktrees/issue-12" } },
    newerLiveOwner: { kind: "confirmed", value: false },
    context: { workerReviewLabel: "agent:review" },
  }, {
    persistPhase: (_record: AttemptRecord, phase: "github_persisted" | "workspace_closed") => transitionPersistedAttempt(this.runDir!, phase),
    closeWorkspace: () => ({ kind: "confirmed", value: undefined }),
    observeWorkspace: () => ({ kind: "confirmed", value: { exists: false } }),
    observeWorktree: () => ({ kind: "confirmed", value: { exists: true, canonicalPath: "/worktrees/issue-12", branch: "agent/issue-12" } }),
  });
});
Then("保存済みの実行場所だけを閉じて作業ツリーを残す", function (this: World) {
  assert.deepEqual({ action: this.result.action, phase: readAttemptRecord(this.runDir!).phase }, {
    action: "closed", phase: "workspace_closed",
  });
  rmSync(this.root!, { recursive: true, force: true });
});

Given("再起動時に実行場所の所有者を特定できない", function (this: World) {
  Object.assign(this, workerFixture());
  persistFixtureJournal(this, "github_persisted");
  this.result = { ambiguous: true };
});
Then("所有者不明の実行場所を閉じない", function (this: World) {
  assert.equal(this.result.action, "cleanup_pending");
  rmSync(this.root!, { recursive: true, force: true });
});

Given("PR が完了し作業ツリーが清浄で追跡中ではない", function (this: World) {
  this.result = {
    config: { repo: "owner/repo", repoPath: "/repo", worktreeRoot: "/worktrees", reviewLabel: "agent:review", humanLabel: "ready-for-human" },
    prs: [{ number: 21, state: "MERGED", headRefName: "agent/issue-12", headRefOid: outputHead, labels: [] }],
    worktrees: [{ path: "/worktrees/issue-12", branch: "agent/issue-12", is_linked_worktree: true }],
    gitStatuses: { "/worktrees/issue-12": "" },
  };
});
When("deadloop が PR の作業ツリーを片付ける", function (this: World) { this.result = selectCleanupPlan(this.result); });
Then("安全確認を満たした作業ツリーだけが削除対象になる", function (this: World) { assert.equal(this.result.candidates.length, 1); });
