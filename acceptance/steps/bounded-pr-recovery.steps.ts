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
    const worktree = path.join(root, "worktree");
    const configDir = path.join(root, "config");
    const state = path.join(configDir, "deadloop");
    const promise = path.join(root, "review-promise.json");
    const githubLog = path.join(root, "github.log");
    const herdrLog = path.join(root, "herdr.log");
    const labelsFile = path.join(root, "labels.json");
    const commentsFile = path.join(root, "comments.json");
    fs.mkdirSync(bin);
    fs.mkdirSync(worktree);
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
      ? [{ body: renderRepairMarker(head, reviewResultFingerprint(findings)) }]
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
if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
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
    comments.push({body: args[args.indexOf("--body") + 1]});
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
if (args[0] === "worktree" && args[1] === "open") process.stdout.write(JSON.stringify({workspace_id: "workspace-1", path: process.env.TEST_WORKTREE}));
else if (args[0] === "agent" && args[1] === "list") process.stdout.write(JSON.stringify({result: {agents: []}}));
else if (args[0] === "tab" && args[1] === "create") process.stdout.write(JSON.stringify({tab_id: "tab-1"}));
else if (args[0] === "agent" && args[1] === "start") process.stdout.write(JSON.stringify({ok: true}));
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
          DEADLOOP_GITHUB_REPO: "owner/repo",
          DEADLOOP_ENABLED_AT: "1",
          DEADLOOP_STATE_DIR: state,
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
    if (testCase === "first-technical-failure") {
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
      retryCycleEffects,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function finalizerOps(commands: string[][], actualHead = head, isCrossRepository = false) {
  return {
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
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

function repairFinalizer(commands: string[][], actualHead = head) {
  return finalizeReviewRepair(
    {
      repo: "/worktree",
      projectRepo: "/repo",
      githubRepo: "owner/repo",
      pr: "31",
      branch,
      expectedHead: head,
      remote: "origin",
      automationDir: "/automation",
      stateDir: "/state",
      enabledAt: 1,
      checkCommand: "npm test",
    },
    finalizerOps(commands, actualHead),
  );
}

function branchUpdateFinalizer(commands: string[][], actualHead = head, isCrossRepository = false) {
  return finalizeBranchUpdate(
    {
      repo: "/worktree",
      projectRepo: "/repo",
      githubRepo: "owner/repo",
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

Given("回復できる競合状態の pull request がある", function (this: RecoveryWorld) {
  this.case = "conflict";
});

Given("同じ pull request head と base の競合回復を一度試した pull request がある", function (this: RecoveryWorld) {
  this.case = "repeated-conflict";
});

Given("base の更新後に競合が解消した pull request がある", function (this: RecoveryWorld) {
  this.case = "resolved-conflict";
});

Given("初めての対応可能なレビュー指摘がある pull request がある", function (this: RecoveryWorld) {
  this.case = "first-repair";
});

Given("修正後の新しい head でも同じレビュー指摘が残った pull request がある", function (this: RecoveryWorld) {
  this.case = "repeated-repair";
});

Given("レビュー指摘の修正中である pull request がある", function (this: RecoveryWorld) {
  this.case = "repair-dispatch";
});

Given("修正の push で head が変わった pull request がある", function (this: RecoveryWorld) {
  this.case = "repaired-head";
});

Given("初めて技術的に失敗したレビューがある pull request がある", function (this: RecoveryWorld) {
  this.case = "first-technical-failure";
});

Given("技術的に一度失敗したレビューがある pull request がある", function (this: RecoveryWorld) {
  this.case = "repeated-technical-failure";
});

Given("修正対象の pull request head が確認済みである", function (this: RecoveryWorld) {
  this.case = "repair-finalize";
});

Given("競合回復対象の pull request head が確認済みである", function (this: RecoveryWorld) {
  this.case = "branch-update-finalize";
});

Given("別のリポジトリからの pull request が競合している", function (this: RecoveryWorld) {
  this.case = "cross-repository-branch-update";
});

When("deadloop が pull request を確認する", function (this: RecoveryWorld) {
  if (this.case === "conflict") this.result = reviewerDriver("merge-conflict.json");
  if (this.case === "repeated-conflict") this.result = reviewerDriver("merge-conflict-double-attempt.json");
  if (this.case === "resolved-conflict") this.result = reviewerDriver("merge-conflict-updated.json");
  if (this.case === "repaired-head") this.result = reviewerDriver("review-repair-pushed.json");
});

When("deadloop がレビュー結果を処理する", function (this: RecoveryWorld) {
  if (!this.case) throw new Error("review recovery case is missing");
  this.result = repairDispatch(this.case);
});

When("deadloop がレビュー指摘の修正を開始する", function (this: RecoveryWorld) {
  if (!this.case) throw new Error("review repair case is missing");
  this.result = repairDispatch(this.case);
});

When("push の直前に pull request head が変わる", function (this: RecoveryWorld) {
  this.commands = [];
  if (this.case === "repair-finalize") this.result = repairFinalizer(this.commands, base);
  if (this.case === "branch-update-finalize") this.result = branchUpdateFinalizer(this.commands, base);
});

When("deadloop が修正を完了する", function (this: RecoveryWorld) {
  this.commands = [];
  this.result = repairFinalizer(this.commands);
});

When("deadloop が競合回復を完了する", function (this: RecoveryWorld) {
  this.commands = [];
  this.result = branchUpdateFinalizer(this.commands, head, this.case === "cross-repository-branch-update");
});

Then("deadloop は専用の競合回復作業を開始する", function (this: RecoveryWorld) {
  const starts = adapterEffects(this.result)?.herdrStarts?.filter((start: any) => start.name.includes("branch-update")) ?? [];
  assert.equal(starts.length, 1);
});

Then("deadloop は専用の競合回復作業を開始しない", function (this: RecoveryWorld) {
  const starts = adapterEffects(this.result)?.herdrStarts?.filter((start: any) => start.name.includes("branch-update")) ?? [];
  assert.equal(starts.length, 0);
});

Then("deadloop は通常レビューを開始する", function (this: RecoveryWorld) {
  const starts = adapterEffects(this.result)?.herdrStarts?.filter((start: any) => start.name.endsWith("-reviewer")) ?? [];
  assert.equal(starts.length, 1);
});

Then("deadloop はレビュー状態を維持する", function (this: RecoveryWorld) {
  const labels = adapterEffects(this.result)?.labels?.["31"] ?? this.result?.observedLabels;
  assert.deepEqual(labels, ["agent:review", "agent:reviewing"]);
});

Then("deadloop は専用の修正作業を開始する", function (this: RecoveryWorld) {
  assert.equal(loggedAgentStartCount(this.result), 1);
});

Then("deadloop は専用の修正作業を開始しない", function (this: RecoveryWorld) {
  assert.equal(loggedAgentStartCount(this.result), 0);
});

Then("deadloop はレビューを一度だけ再試行する", function (this: RecoveryWorld) {
  const starts = (this.result?.retryCycleEffects as any)?.herdrStarts?.filter((start: any) => start.name.endsWith("-reviewer")) ?? [];
  assert.equal(starts.length, 1);
});

Then("deadloop は人間対応にしない", function (this: RecoveryWorld) {
  assert.equal((this.result?.observedLabels as string[]).includes("agent:blocked"), false);
});

Then("deadloop は通常レビューを開始しない", function (this: RecoveryWorld) {
  assert.equal(loggedAgentStartCount(this.result), 0);
});

Then("deadloop は branch へ push しない", function (this: RecoveryWorld) {
  assert.equal(this.commands?.some((command) => command.includes("push")), false);
});

Then("deadloop は確認した branch へ非強制で push する", function (this: RecoveryWorld) {
  assert.deepEqual(this.commands?.find((command) => command.includes("push")), ["git", "-C", "/worktree", "push", "--porcelain", "https://github.com/owner/repo.git", `${repairedHead}:refs/heads/${branch}`]);
});

Then("deadloop は最後の pull request head 確認より先に設定済みチェックを実行する", function (this: RecoveryWorld) {
  const checkIndex = this.commands?.findIndex((command) => command[0] === "node") ?? -1;
  const headCheckIndex = this.commands?.findIndex((command) => command[0] === "gh") ?? -1;
  assert.ok(checkIndex >= 0 && checkIndex < headCheckIndex);
});

Then("deadloop は競合回復 branch へ非強制で push する", function (this: RecoveryWorld) {
  assert.deepEqual(this.commands?.find((command) => command.includes("push")), ["git", "-C", "/worktree", "push", "--porcelain", "https://github.com/owner/repo.git", `${repairedHead}:refs/heads/${branch}`]);
});

Then("deadloop は競合回復の最後の pull request head 確認より先に設定済みチェックを実行する", function (this: RecoveryWorld) {
  const checkIndex = this.commands?.findIndex((command) => command[0] === "node") ?? -1;
  const headCheckIndex = this.commands?.findIndex((command) => command[0] === "gh") ?? -1;
  assert.ok(checkIndex >= 0 && checkIndex < headCheckIndex);
});

Then("deadloop は競合回復 branch へ push しない", function (this: RecoveryWorld) {
  assert.equal(this.commands?.some((command) => command.includes("push")), false);
});
