import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

import type { AttemptRecord, CompletionReportV1 } from "../../src/attempt-lifecycle";
import {
  abandonPersistedAttempt,
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
const advancedBaseHead = "c".repeat(40);

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
  recoveredWorker?: { worktreePath: string; opened: number; inputHead?: string; policyBaseHead?: string };
  runDir?: string;
};

function workerFixture(): { record: AttemptRecord; report: any; github: any } {
  const record: AttemptRecord = {
    attemptId: "attempt-1", launchUuid: "launch-1", project: "demo", repository: "owner/repo",
    role: "worker", target: { kind: "issue", number: 12 }, inputRevision: { head: inputHead },
    requiredVerification: { repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: inputHead },
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
    role: source.role, target: source.target, inputRevision: source.inputRevision,
    ...(source.requiredVerification ? { requiredVerification: source.requiredVerification } : {}), branch: source.branch,
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

Given("A new work attempt can start", function (this: World) {
  this.root = mkdtempSync(path.join(os.tmpdir(), "deadloop-cucumber-workspace-"));
});

When("deadloop starts the agent", function (this: World) {
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
    DEADLOOP_REQUIRED_VERIFICATION: JSON.stringify({ repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: inputHead }),
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

Given("A Worker's worktree remains after its launch failure was abandoned with evidence", function (this: World) {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-cucumber-abandoned-worker-"));
  this.root = root;
  const worktreePath = path.join(root, "agent-issue-12-retry");
  const runDir = path.join(root, "runs", "old-launch");
  createPreparedAttempt(runDir, {
    attemptId: "old-attempt", launchUuid: "old-launch", project: "demo", repository: "owner/repo",
    role: "worker", target: { kind: "issue", number: 12 }, inputRevision: { head: inputHead },
    requiredVerification: { repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: inputHead },
    branch: "agent/issue-12-retry", baseBranch: "origin/main", worktreePath,
    agentName: "dl-w-12-old000000000", workspaceLabel: "old worker", promptFile: path.join(runDir, "prompt.md"),
    promiseFile: path.join(runDir, "promise.json"),
  });
  transitionPersistedAttempt(runDir, "github_claimed");
  const claimed = readAttemptRecord(runDir);
  writeAttemptRecordAtomically(attemptRecordPath(runDir), {
    ...claimed, workspaceId: "workspace-old", tabId: "tab-old", rootPaneId: "pane-old",
    phase: "workspace_opened", lastSuccessfulPhase: "workspace_opened",
  });
  transitionPersistedAttempt(runDir, "launch_failed", "agent did not start");
  abandonPersistedAttempt(runDir, "2026-07-24T00:00:00.000Z");
  this.recoveredWorker = { worktreePath, opened: 0 };
});

When("deadloop starts the requeued Worker", function (this: World) {
  const root = this.root!;
  const recovered = this.recoveredWorker!;
  let launchedName = "";
  let openedWorkspace = false;
  const runner = {
    createWorktree: () => { throw new Error("requeued Worker must not create a duplicate worktree"); },
    openWorktree: () => {
      recovered.opened += 1;
      openedWorkspace = true;
      return { workspaceId: "workspace-new", tabId: "tab-new", rootPaneId: "pane-new", worktreePath: recovered.worktreePath };
    },
    renameWorkspace: () => "", startAgent: () => "", closeWorkspace: () => "",
    listWorkspaces: () => [],
    listWorktrees: () => [{ branch: "agent/issue-12-retry", path: recovered.worktreePath }],
    listAgents: () => launchedName && openedWorkspace
      ? [{ name: launchedName, paneId: "pane-new", workspace_id: "workspace-new", cwd: recovered.worktreePath, status: "working" }]
      : [],
    removeWorktree: () => "",
  };
  const env = workerEnvironment({
    DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: "/repo", DEADLOOP_GITHUB_REPO: "owner/repo",
    DEADLOOP_BASE_BRANCH: "origin/main", DEADLOOP_WORKTREE_ROOT: root, DEADLOOP_STATE_DIR: root,
    DEADLOOP_REQUIRED_VERIFICATION: JSON.stringify({ repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: advancedBaseHead }),
  });
  this.result = launchIssueWorkerFlow({ number: 12, title: "renamed issue" }, env, {
    mkdirSync: fs.mkdirSync,
    runner,
    runText: (args: string[]) => {
      const nameIndex = args.indexOf("--name");
      if (nameIndex >= 0) launchedName = args[nameIndex + 1];
      if (args[0] === "git" && args.includes("status")) return "";
      if (args[0] === "git" && args[2] === "/repo") return `${advancedBaseHead}\n`;
      return args[0] === "git" ? `${inputHead}\n` : "started";
    },
    writeFileSync: fs.writeFileSync,
  });
  const newRun = fs.readdirSync(path.join(root, "runs")).find((entry) => entry !== "old-launch");
  const attempt = readAttemptRecord(path.join(root, "runs", String(newRun)));
  recovered.inputHead = attempt.inputRevision.head;
  recovered.policyBaseHead = attempt.requiredVerification?.baseRevision;
});

Then("deadloop opens the same worktree in a fresh workspace", function (this: World) {
  assert.deepEqual({ opened: this.recoveredWorker?.opened, workspaceId: this.result.workspaceId, worktreePath: this.result.worktreePath, inputHead: this.recoveredWorker?.inputHead, policyBaseHead: this.recoveredWorker?.policyBaseHead }, {
    opened: 1, workspaceId: "workspace-new", worktreePath: this.recoveredWorker?.worktreePath, inputHead, policyBaseHead: advancedBaseHead,
  });
  rmSync(this.root!, { recursive: true, force: true });
});

Then("The agent appears in exactly one workspace and one pane", function (this: World) {
  assert.deepEqual(this.layoutObservation, {
    workspaces: [{ workspace_id: this.result.workspaceId, tab_count: 1, pane_count: 1 }],
    extraLayoutActions: [],
  });
  rmSync(this.root!, { recursive: true, force: true });
});

Given("The agent's PR and completion report agree", function (this: World) {
  Object.assign(this, workerFixture());
  persistFixtureJournal(this);
  this.worktreeExists = true;
});

Given("The agent blocked its work for a safety reason", function (this: World) {
  Object.assign(this, workerFixture());
  this.report = { ...this.report, status: "blocked", result: { reason: "unsafe", explanation: "unsafe", recovery: "inspect" }, evidence: {} };
});

Given("The agent's completion report is malformed", function (this: World) {
  Object.assign(this, workerFixture());
  this.report = { status: "complete" };
});

Given("The agent's result cannot be confirmed on GitHub", function (this: World) {
  Object.assign(this, workerFixture());
  this.github = { kind: "uncertain", reason: "timeout", detail: "GitHub timeout" };
});

When("deadloop reconciles the completed attempt", async function (this: World) {
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

Then("The agent's workspace is gone and the worktree remains", function (this: World) {
  assert.deepEqual({ action: this.result.action, phase: readAttemptRecord(this.runDir!).phase, worktree: this.worktreeExists }, {
    action: "closed", phase: "workspace_closed", worktree: true,
  });
  rmSync(this.root!, { recursive: true, force: true });
});

Given("The Worker's workspace was closed safely", function (this: World) {
  this.priorWorkspace = { workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1", canonicalWorktreePath: "/worktrees/issue-12" };
});

Given("The review result was saved to GitHub and the Reviewer workspace was closed", function (this: World) {
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
    requiredVerification: { repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: "a".repeat(40) },
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
      DEADLOOP_REQUIRED_VERIFICATION: JSON.stringify({ repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: "a".repeat(40) }),
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

When("deadloop starts the Reviewer", function (this: World) {
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
When("deadloop starts the repair agent and branch-update agent", function (this: World) {
  this.currentWorkspace = {
    repair: launchRepairBoundary("workspace-3"),
    branchUpdate: launchBranchUpdateBoundary("workspace-4"),
  };
});

Then("The Reviewer uses a separate fresh workspace", function (this: World) {
  assert.notEqual(this.currentWorkspace.workspaceId, this.priorWorkspace.workspaceId);
});
Then("Each agent uses a fresh workspace", function (this: World) {
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
Then("deadloop preserves the agent's workspace and worktree", function (this: World) { assert.equal(this.result.action, "preserve"); });

Given("The automation host is connected to an unsupported Herdr", function (this: World) { this.mutationCount = 0; });

When("deadloop starts an automation cycle", async function (this: World) {
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

Then("deadloop stops without changing GitHub or a workspace", function (this: World) { assert.equal(this.mutationCount, 0); });

Given("A workspace retained for investigation remains on the same worktree", function (this: World) {
  this.priorWorkspace = { workspaceId: "workspace-retained", tabId: "tab-retained", rootPaneId: "pane-retained", canonicalWorktreePath: "/worktrees/issue-12" };
  this.mutationCount = 0;
});
When("deadloop considers starting the next agent", async function (this: World) {
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
Then("deadloop does not start a new agent on the same worktree", function (this: World) {
  assert.deepEqual({ action: this.result.action, mutations: this.mutationCount }, { action: "rejected", mutations: 0 });
});

Given("The automation host stopped after persisting the result to GitHub", function (this: World) {
  Object.assign(this, workerFixture());
  persistFixtureJournal(this, "github_persisted");
  this.worktreeExists = true;
});
When("deadloop reconciles the attempt after restart", async function (this: World) {
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
Then("deadloop closes only the persisted workspace and leaves the worktree", function (this: World) {
  assert.deepEqual({ action: this.result.action, phase: readAttemptRecord(this.runDir!).phase }, {
    action: "closed", phase: "workspace_closed",
  });
  rmSync(this.root!, { recursive: true, force: true });
});

Given("The workspace owner cannot be identified after restart", function (this: World) {
  Object.assign(this, workerFixture());
  persistFixtureJournal(this, "github_persisted");
  this.result = { ambiguous: true };
});
Then("deadloop does not close a workspace with an unknown owner", function (this: World) {
  assert.equal(this.result.action, "cleanup_pending");
  rmSync(this.root!, { recursive: true, force: true });
});

Given("The PR is complete and its worktree is clean and untracked by Herdr", function (this: World) {
  this.result = {
    config: { repo: "owner/repo", repoPath: "/repo", worktreeRoot: "/worktrees", reviewLabel: "agent:review", humanLabel: "ready-for-human" },
    prs: [{ number: 21, state: "MERGED", headRefName: "agent/issue-12", headRefOid: outputHead, labels: [] }],
    worktrees: [{ path: "/worktrees/issue-12", branch: "agent/issue-12", is_linked_worktree: true }],
    gitStatuses: { "/worktrees/issue-12": "" },
  };
});
When("deadloop cleans up the PR worktree", function (this: World) { this.result = selectCleanupPlan(this.result); });
Then("Only a worktree that passes the safety checks is selected for removal", function (this: World) { assert.equal(this.result.candidates.length, 1); });
