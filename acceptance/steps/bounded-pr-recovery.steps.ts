import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

const { finalizeBranchUpdate } = require("../../extensions/deadloop/automations/pr-branch-update-finalize.ts");
const { renderRepairMarker, renderTechnicalFailureMarker, reviewResultFingerprint } = require("../../extensions/deadloop/automations/pr-review-repair-state.ts");
const { finalizeReviewRepair } = require("../../extensions/deadloop/automations/pr-review-repair-finalize.ts");

const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const repairedHead = "cccccccccccccccccccccccccccccccccccccccc";
const branch = "agent/issue-31";
const findings = [{ title: "Lint contract failure", body: "Format src/a.ts", path: "src/a.ts", severity: "major" }];

type RecoveryWorld = {
  case?: string;
  result?: Record<string, unknown>;
  commands?: string[][];
};

function adapterEffects(result: Record<string, unknown> | undefined): any {
  return result?.testAdapterEffects;
}

function loggedAgentStartCount(result: Record<string, unknown> | undefined): number {
  return String(result?.herdrLog || "").split("\n").filter((line) => line.startsWith("agent start ")).length;
}

function loggedRepairAgentStartCount(result: Record<string, unknown> | undefined): number {
  return String(result?.herdrLog || "").split("\n").filter((line) =>
    /^agent start dl-x-31-[0-9a-f]{12} /.test(line),
  ).length;
}

function observedLabels(result: Record<string, unknown> | undefined): string[] {
  return adapterEffects(result)?.labels?.["31"] ?? result?.observedLabels ?? [];
}

function observedComments(result: Record<string, unknown> | undefined): Array<{ body: string }> {
  return adapterEffects(result)?.githubComments ?? result?.observedComments ?? [];
}

function reviewerDriver(fixture: string): Record<string, unknown> {
  const fixturePath = path.isAbsolute(fixture) ? fixture : path.join("test/fixtures/pr-reviewer-driver", fixture);
  const result = spawnSync(
    "node",
    ["extensions/deadloop/automations/pr-reviewer-driver.ts", "--fixture", fixturePath],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DEADLOOP_PROJECT_ID: "demo",
        DEADLOOP_STATE_DIR: path.join(process.cwd(), "test/fixtures/pr-reviewer-driver/state"),
        DEADLOOP_REPO_PATH: "/repo",
        DEADLOOP_GITHUB_REPO: "owner/repo",
        DEADLOOP_REVIEWER_AGENT: "pi",
        DEADLOOP_REVIEWER_MODEL: "",
        DEADLOOP_AUTO_MERGE: "0",
        DEADLOOP_NOW: "2026-07-08T00:00:00Z",
      },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function repairDispatch(testCase: string): Record<string, unknown> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-acceptance-review-repair-"));
  try {
    const bin = path.join(root, "bin");
    const worktreeRoot = path.join(root, "worktrees");
    const worktree = path.join(worktreeRoot, "agent-issue-31");
    const configDir = path.join(root, "config");
    const state = path.join(configDir, "deadloop");
    const promise = path.join(root, "review-promise.json");
    const githubLog = path.join(root, "github.log");
    const herdrLog = path.join(root, "herdr.log");
    const labelsFile = path.join(root, "labels.json");
    const commentsFile = path.join(root, "comments.json");
    fs.mkdirSync(bin);
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(labelsFile, JSON.stringify(["agent:review", "agent:reviewing"]));
    fs.writeFileSync(
      path.join(state, "enabled-projects.json"),
      JSON.stringify({ projects: [{
        repoPath: root,
        githubRepo: "owner/repo",
        githubRepositoryId: "R_repo",
        enabledAt: 1,
        firstEnableAutoMerge: false,
        firstStartPending: false,
        lastObservedAutoMerge: false,
        autoMergeAcknowledged: false,
        enabled: true,
      }] }),
    );
    const blocked = testCase === "first-technical-failure" || testCase === "repeated-technical-failure";
    fs.writeFileSync(
      promise,
      JSON.stringify(blocked
        ? { status: "blocked", reason: "reviewer failed", summary: "Technical review failure." }
        : { status: "complete", outcome: "changes_requested", reason: "", summary: "Repair required.", findings }),
    );
    const comments = testCase === "repeated-repair"
      ? [{ body: renderRepairMarker(head, reviewResultFingerprint(findings)), author: { login: "deadloop-bot" } }]
      : testCase === "repeated-technical-failure"
        ? [{ body: renderTechnicalFailureMarker(head) }]
        : [];
    const currentHead = testCase === "repeated-repair" ? repairedHead : head;
    fs.writeFileSync(commentsFile, JSON.stringify(comments));
    const executable = (file: string, content: string) => {
      fs.writeFileSync(file, content);
      fs.chmodSync(file, 0o755);
    };
    executable(
      path.join(bin, "gh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "api" && args[1] === "user") process.stdout.write("deadloop-bot\\n");
else if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number: 31, state: "OPEN", headRefName: "${branch}", headRefOid: "${currentHead}", isCrossRepository: false,
  labels: JSON.parse(fs.readFileSync(process.env.TEST_LABELS_FILE, "utf8")).map(name => ({name})),
  comments: JSON.parse(fs.readFileSync(process.env.TEST_COMMENTS_FILE, "utf8"))
}));
else if (args[0] === "repo" && args[1] === "view") process.stdout.write(JSON.stringify({id: "R_repo"}));
else {
  if (args[0] === "pr" && args[1] === "edit") {
    const labels = new Set(JSON.parse(fs.readFileSync(process.env.TEST_LABELS_FILE, "utf8")));
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--add-label") labels.add(args[index + 1]);
      if (args[index] === "--remove-label") labels.delete(args[index + 1]);
    }
    fs.writeFileSync(process.env.TEST_LABELS_FILE, JSON.stringify([...labels]));
  }
  if (args[0] === "pr" && args[1] === "comment") {
    const comments = JSON.parse(fs.readFileSync(process.env.TEST_COMMENTS_FILE, "utf8"));
    comments.push({body: args[args.indexOf("--body") + 1], author: {login: "deadloop-bot"}});
    fs.writeFileSync(process.env.TEST_COMMENTS_FILE, JSON.stringify(comments));
  }
  fs.appendFileSync(process.env.TEST_GITHUB_LOG, args.join(" ") + "\\n");
}
`,
    );
    executable(
      path.join(bin, "git"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) process.stdout.write("https://github.com/owner/repo.git\\n");
`,
    );
    executable(
      path.join(bin, "herdr"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_HERDR_LOG, args.join(" ") + "\\n");
if (args[0] === "--version") process.stdout.write("herdr 0.7.5\\n");
else if (args[0] === "status" && args[1] === "server") process.stdout.write("version: 0.7.5\\ncompatible: yes\\n");
else if (args[0] === "worktree" && args[1] === "list") process.stdout.write(JSON.stringify({result: {worktrees: [{path: process.env.TEST_WORKTREE, branch: "agent/issue-31"}]}}));
else if (args[0] === "worktree" && args[1] === "open") process.stdout.write(JSON.stringify({result: {type: "worktree_opened", already_open: false, workspace: {workspace_id: "workspace-1"}, tab: {tab_id: "tab-1", workspace_id: "workspace-1"}, root_pane: {pane_id: "pane-1", tab_id: "tab-1", workspace_id: "workspace-1", cwd: process.env.TEST_WORKTREE}, worktree: {path: process.env.TEST_WORKTREE}}}));
else if (args[0] === "workspace" && args[1] === "list") process.stdout.write(JSON.stringify({result: {workspaces: []}}));
else if (args[0] === "workspace" && args[1] === "rename") process.stdout.write("renamed");
else if (args[0] === "agent" && args[1] === "list") process.stdout.write(JSON.stringify({result: {agents: fs.existsSync(process.env.TEST_HERDR_LOG + ".agent") ? [JSON.parse(fs.readFileSync(process.env.TEST_HERDR_LOG + ".agent", "utf8"))] : []}}));
else if (args[0] === "agent" && args[1] === "start") { fs.writeFileSync(process.env.TEST_HERDR_LOG + ".agent", JSON.stringify({terminal_id:"terminal-1",name:args[2],agent_status:"working",cwd:process.env.TEST_WORKTREE,pane_id:args[args.indexOf("--pane")+1]})); process.stdout.write(JSON.stringify({ok: true})); }
`,
    );
    const result = spawnSync(
      "node",
      ["extensions/deadloop/automations/pr-review-repair-dispatch.ts", "--promise", promise, "--pr", "31", "--expected-head", currentHead, "--branch", branch],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          PI_CODING_AGENT_DIR: configDir,
          DEADLOOP_PROJECT_ID: "demo",
          DEADLOOP_REPO_PATH: root,
          DEADLOOP_WORKTREE_ROOT: worktreeRoot,
          DEADLOOP_GITHUB_REPO: "owner/repo",
          DEADLOOP_ENABLED_AT: "1",
          DEADLOOP_STATE_DIR: state,
          DEADLOOP_REQUIRED_VERIFICATION: JSON.stringify({ repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: head }),
          TEST_COMMENTS_FILE: commentsFile,
          TEST_GITHUB_LOG: githubLog,
          TEST_HERDR_LOG: herdrLog,
          TEST_LABELS_FILE: labelsFile,
          TEST_WORKTREE: worktree,
        },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    let retryCycleEffects: unknown;
    if (testCase === "first-technical-failure" || testCase === "repeated-technical-failure") {
      const retryFixture = path.join(root, "retry-cycle.json");
      fs.writeFileSync(retryFixture, JSON.stringify({
        prs: [{
          number: 31, title: "PR", url: "https://github.com/owner/repo/pull/31", updatedAt: "2026-07-08T00:00:00Z",
          headRefName: branch, headRefOid: head, isCrossRepository: false, isDraft: false,
          labels: JSON.parse(fs.readFileSync(labelsFile, "utf8")).map((name: string) => ({ name })),
          statusCheckRollup: [], comments: JSON.parse(fs.readFileSync(commentsFile, "utf8")), reviewRequests: [], mergeStateStatus: "CLEAN",
        }],
        agents: { result: { agents: [] } },
      }));
      retryCycleEffects = reviewerDriver(retryFixture).testAdapterEffects;
    }
    return {
      ...JSON.parse(result.stdout),
      githubLog: fs.existsSync(githubLog) ? fs.readFileSync(githubLog, "utf8") : "",
      herdrLog: fs.existsSync(herdrLog) ? fs.readFileSync(herdrLog, "utf8") : "",
      observedLabels: JSON.parse(fs.readFileSync(labelsFile, "utf8")),
      observedComments: JSON.parse(fs.readFileSync(commentsFile, "utf8")),
      retryCycleEffects,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function finalizerOps(commands: string[][], actualHead = head, isCrossRepository = false, changedFileCount = 0) {
  return {
    ensureVerification: (_args: unknown, _candidate: string, _repositoryId: string, run: (args: string[]) => unknown) => run(["node", "/automation/run-project-check.ts"]),
    readRepairFindingCount: () => findings.length,
    assertEnabled: () => ({ githubRepo: "owner/repo", githubRepositoryId: "R_repo" }),
    run: (args: string[]) => {
      commands.push(args);
      if (args.includes("get-url")) return { status: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" };
      if (args.includes("ls-remote")) return { status: 0, stdout: `${head}\trefs/heads/${branch}\n`, stderr: "" };
      if (args.includes("--git-common-dir")) return { status: 0, stdout: "/common\n", stderr: "" };
      if (args.includes("symbolic-ref")) return { status: 0, stdout: `${branch}\n`, stderr: "" };
      if (args[0] === "gh" && args[1] === "repo") return { status: 0, stdout: JSON.stringify({ id: "R_repo" }), stderr: "" };
      if (args[0] === "gh") {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", isCrossRepository, headRefName: branch, headRefOid: actualHead }),
          stderr: "",
        };
      }
      if (args.includes("rev-parse")) return { status: 0, stdout: `${repairedHead}\n`, stderr: "" };
      if (args.includes("diff")) {
        const changedFiles = Array.from({ length: changedFileCount }, (_value, index) => `file-${index}.ts`);
        return { status: 0, stdout: `${changedFiles.join("\0")}${changedFiles.length ? "\0" : ""}`, stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

function repairFinalizer(commands: string[][], actualHead = head, changedFileCount = 0) {
  return finalizeReviewRepair(
    {
      repo: "/worktree",
      projectId: "demo",
      projectRepo: "/repo",
      githubRepo: "owner/repo",
      attemptRecord: "/state/runs/attempt/attempt.json",
      pr: "31",
      branch,
      expectedHead: head,
      remote: "origin",
      automationDir: "/automation",
      stateDir: "/state",
      enabledAt: 1,
      checkCommand: "npm test",
    },
    finalizerOps(commands, actualHead, false, changedFileCount),
  );
}

function branchUpdateFinalizer(commands: string[][], actualHead = head, isCrossRepository = false) {
  return finalizeBranchUpdate(
    {
      repo: "/worktree",
      projectId: "demo",
      projectRepo: "/repo",
      githubRepo: "owner/repo",
      attemptRecord: "/state/runs/attempt/attempt.json",
      pr: "31",
      branch,
      expectedHead: head,
      expectedBase: base,
      remote: "origin",
      automationDir: "/automation",
      stateDir: "/state",
      enabledAt: 1,
      checkCommand: "npm test",
    },
    finalizerOps(commands, actualHead, isCrossRepository),
  );
}

Given("A pull request has a conflict that can be recovered", function (this: RecoveryWorld) {
  this.case = "conflict";
});

Given("Conflict recovery was already attempted for the same pull request head and base", function (this: RecoveryWorld) {
  this.case = "repeated-conflict";
});

Given("Conflict recovery changed the pull request head", function (this: RecoveryWorld) {
  this.case = "resolved-conflict";
});

Given("Conflict recovery changed a repaired pull request head", function (this: RecoveryWorld) {
  this.case = "resolved-repaired-conflict";
});

Given("A pull request has actionable review findings for the first time", function (this: RecoveryWorld) {
  this.case = "first-repair";
});

Given("The same review findings remain on the new head after repair", function (this: RecoveryWorld) {
  this.case = "repeated-repair";
});

Given("A pull request is being repaired for review findings", function (this: RecoveryWorld) {
  this.case = "repair-dispatch";
});

Given("A repair push changed the pull request head", function (this: RecoveryWorld) {
  this.case = "repaired-head";
});

Given("A pull request has its first technical review failure", function (this: RecoveryWorld) {
  this.case = "first-technical-failure";
});

Given("A pull request already had one technical review failure", function (this: RecoveryWorld) {
  this.case = "repeated-technical-failure";
});

Given("The pull request head selected for repair has been verified", function (this: RecoveryWorld) {
  this.case = "repair-finalize";
});

Given("A repair changes six files for one finding", function (this: RecoveryWorld) {
  this.case = "oversized-repair";
});

Given("A repair changes five files for one finding", function (this: RecoveryWorld) {
  this.case = "bounded-repair";
});

Given("The pull request head selected for conflict recovery has been verified", function (this: RecoveryWorld) {
  this.case = "branch-update-finalize";
});

Given("A pull request from another repository has a conflict", function (this: RecoveryWorld) {
  this.case = "cross-repository-branch-update";
});

When("deadloop checks the pull request", function (this: RecoveryWorld) {
  if (this.case === "conflict") this.result = reviewerDriver("merge-conflict.json");
  if (this.case === "repeated-conflict") this.result = reviewerDriver("merge-conflict-double-attempt.json");
  if (this.case === "resolved-conflict") this.result = reviewerDriver("merge-conflict-updated.json");
  if (this.case === "resolved-repaired-conflict") this.result = reviewerDriver("repaired-merge-conflict-updated.json");
  if (this.case === "repaired-head") this.result = reviewerDriver("review-repair-pushed.json");
});

When("deadloop processes the review result", function (this: RecoveryWorld) {
  if (!this.case) throw new Error("review recovery case is missing");
  this.result = repairDispatch(this.case);
});

When("deadloop starts the review repair", function (this: RecoveryWorld) {
  if (!this.case) throw new Error("review repair case is missing");
  this.result = repairDispatch(this.case);
});

When("The pull request head changes immediately before push", function (this: RecoveryWorld) {
  this.commands = [];
  if (this.case === "repair-finalize") this.result = repairFinalizer(this.commands, base);
  if (this.case === "branch-update-finalize") this.result = branchUpdateFinalizer(this.commands, base);
});

When("deadloop completes the repair", function (this: RecoveryWorld) {
  this.commands = [];
  const changedFileCount = this.case === "oversized-repair" ? 6 : this.case === "bounded-repair" ? 5 : 0;
  this.result = repairFinalizer(this.commands, head, changedFileCount);
});

When("deadloop completes conflict recovery", function (this: RecoveryWorld) {
  this.commands = [];
  this.result = branchUpdateFinalizer(this.commands, head, this.case === "cross-repository-branch-update");
});

Then("deadloop starts a dedicated conflict-recovery attempt", function (this: RecoveryWorld) {
  const starts = adapterEffects(this.result)?.herdrStarts?.filter((start: any) => start.name.includes("branch-update")) ?? [];
  assert.equal(starts.length, 1);
});

Then("deadloop does not start another dedicated conflict-recovery attempt", function (this: RecoveryWorld) {
  const starts = adapterEffects(this.result)?.herdrStarts?.filter((start: any) => start.name.includes("branch-update")) ?? [];
  assert.equal(starts.length, 0);
});

Then("deadloop returns the pull request to normal review", function (this: RecoveryWorld) {
  const starts = adapterEffects(this.result)?.herdrStarts?.filter((start: any) => start.name.endsWith("-reviewer")) ?? [];
  assert.equal(starts.length, 1);
});

Then("The selection reason after conflict recovery is repair re-review", function (this: RecoveryWorld) {
  assert.equal((this.result?.decision as { reason?: string } | undefined)?.reason, "repair_rereview");
});

Then("deadloop preserves the review state", function (this: RecoveryWorld) {
  const labels = adapterEffects(this.result)?.labels?.["31"] ?? this.result?.observedLabels;
  assert.deepEqual(labels, ["agent:review", "agent:reviewing"]);
});

Then("deadloop starts a dedicated repair attempt", function (this: RecoveryWorld) {
  assert.equal(loggedRepairAgentStartCount(this.result), 1);
});

Then("deadloop does not start another dedicated repair attempt", function (this: RecoveryWorld) {
  assert.equal(loggedAgentStartCount(this.result), 0);
});

Then("deadloop keeps the pull request under review", function (this: RecoveryWorld) {
  assert.equal(observedLabels(this.result).includes("agent:review"), true);
});

Then("deadloop escalates the pull request for human handling", function (this: RecoveryWorld) {
  assert.equal(observedLabels(this.result).includes("agent:blocked"), true);
});

Then("deadloop leaves recovery guidance", function (this: RecoveryWorld) {
  assert.equal(observedComments(this.result).some((comment) => comment.body.includes("## Recovery steps")), true);
});

Then("deadloop retries the review exactly once", function (this: RecoveryWorld) {
  const starts = (this.result?.retryCycleEffects as any)?.herdrStarts?.filter((start: any) => start.name.endsWith("-reviewer")) ?? [];
  assert.equal(starts.length, 1);
});

Then("deadloop does not escalate the pull request for human handling", function (this: RecoveryWorld) {
  assert.equal((this.result?.observedLabels as string[]).includes("agent:blocked"), false);
});

Then("deadloop does not start normal review", function (this: RecoveryWorld) {
  const starts = (this.result?.retryCycleEffects as any)?.herdrStarts?.filter((start: any) => start.name.endsWith("-reviewer")) ?? [];
  assert.equal(starts.length, 0);
});

Then("deadloop does not push to the branch", function (this: RecoveryWorld) {
  assert.equal(this.commands?.some((command) => command.includes("push")), false);
});

Then("deadloop requires human review for the repair", function (this: RecoveryWorld) {
  assert.equal(this.result?.reason, "repair_size_limit_exceeded");
});

Then("deadloop pushes non-forcibly to the verified branch", function (this: RecoveryWorld) {
  assert.deepEqual(this.commands?.find((command) => command.includes("push")), ["git", "-C", "/worktree", "push", "--porcelain", "https://github.com/owner/repo.git", `${repairedHead}:refs/heads/${branch}`]);
});

Then("deadloop runs the configured checks before the final pull request head check", function (this: RecoveryWorld) {
  const checkIndex = this.commands?.findIndex((command) => command[0] === "node") ?? -1;
  const headCheckIndex = this.commands?.findIndex((command) => command[0] === "gh") ?? -1;
  assert.ok(checkIndex >= 0 && checkIndex < headCheckIndex);
});

Then("deadloop pushes non-forcibly to the conflict-recovery branch", function (this: RecoveryWorld) {
  assert.deepEqual(this.commands?.find((command) => command.includes("push")), ["git", "-C", "/worktree", "push", "--porcelain", "https://github.com/owner/repo.git", `${repairedHead}:refs/heads/${branch}`]);
});

Then("deadloop runs the configured checks before the final conflict-recovery pull request head check", function (this: RecoveryWorld) {
  const checkIndex = this.commands?.findIndex((command) => command[0] === "node") ?? -1;
  const headCheckIndex = this.commands?.findIndex((command) => command[0] === "gh") ?? -1;
  assert.ok(checkIndex >= 0 && checkIndex < headCheckIndex);
});

Then("deadloop does not push to the conflict-recovery branch", function (this: RecoveryWorld) {
  assert.equal(this.commands?.some((command) => command.includes("push")), false);
});
