import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

const { finalizeBranchUpdate } = require("../../extensions/deadloop/automations/pr-branch-update-finalize.ts");
const {
  decideTechnicalReviewFailure,
  renderRepairMarker,
  renderTechnicalFailureMarker,
  reviewResultFingerprint,
  selectRepairAttempt,
} = require("../../extensions/deadloop/automations/pr-review-repair-state.ts");
const { finalizeReviewRepair } = require("../../extensions/deadloop/automations/pr-review-repair-finalize.ts");
const { repairWorkerPrompt } = require("../../extensions/deadloop/automations/pr-review-repair-dispatch.ts");

const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const branch = "agent/issue-31";
const findings = [{ title: "Lint contract failure", body: "Format src/a.ts", path: "src/a.ts", severity: "major" }];

type RecoveryWorld = {
  case?: string;
  result?: Record<string, unknown>;
  commands?: string[][];
};

function reviewerDriver(fixture: string): Record<string, unknown> {
  const result = spawnSync(
    "node",
    ["extensions/deadloop/automations/pr-reviewer-driver.ts", "--fixture", path.join("test/fixtures/pr-reviewer-driver", fixture)],
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

function finalizerOps(commands: string[][], actualHead = head) {
  return {
    run: (args: string[]) => {
      commands.push(args);
      if (args[0] === "gh") {
        return {
          status: 0,
          stdout: JSON.stringify({ state: "OPEN", isCrossRepository: false, headRefName: branch, headRefOid: actualHead }),
          stderr: "",
        };
      }
      if (args.includes("rev-parse")) return { status: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

function repairFinalizer(commands: string[][], actualHead = head) {
  return finalizeReviewRepair(
    {
      repo: "/worktree",
      githubRepo: "owner/repo",
      pr: "31",
      branch,
      expectedHead: head,
      remote: "origin",
      automationDir: "/automation",
      stateDir: "/state",
      checkCommand: "npm test",
    },
    finalizerOps(commands, actualHead),
  );
}

function branchUpdateFinalizer(commands: string[][], actualHead = head) {
  return finalizeBranchUpdate(
    {
      repo: "/worktree",
      githubRepo: "owner/repo",
      pr: "31",
      branch,
      expectedHead: head,
      expectedBase: base,
      remote: "origin",
      automationDir: "/automation",
      stateDir: "/state",
      checkCommand: "npm test",
    },
    finalizerOps(commands, actualHead),
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

Given("同じレビュー指摘の修正を一度試した pull request がある", function (this: RecoveryWorld) {
  this.case = "repeated-repair";
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

When("deadloop が pull request を確認する", function (this: RecoveryWorld) {
  if (this.case === "conflict") this.result = reviewerDriver("merge-conflict.json");
  if (this.case === "repeated-conflict") this.result = reviewerDriver("merge-conflict-double-attempt.json");
  if (this.case === "resolved-conflict") this.result = reviewerDriver("merge-conflict-updated.json");
});

When("deadloop がレビュー結果を処理する", function (this: RecoveryWorld) {
  if (this.case === "first-repair") this.result = selectRepairAttempt([], head, findings);
  if (this.case === "repeated-repair") this.result = selectRepairAttempt([{ body: renderRepairMarker(head, reviewResultFingerprint(findings)) }], head, findings);
  if (this.case === "first-technical-failure") this.result = decideTechnicalReviewFailure([], head);
  if (this.case === "repeated-technical-failure") this.result = decideTechnicalReviewFailure([{ body: renderTechnicalFailureMarker(head) }], head);
});

When("deadloop が修正作業者へ指示する", function (this: RecoveryWorld) {
  this.result = { prompt: repairWorkerPrompt("31", branch, head, findings, "/state/promise.json", "/worktree", {
    projectId: "demo",
    repoPath: "/repo",
    githubRepo: "owner/repo",
    stateDir: "/state",
    checkCommand: "npm test",
    workerAgent: "pi",
    workerModel: "",
    remote: "origin",
    reviewLabel: "agent:review",
    reviewingLabel: "agent:reviewing",
    blockedLabel: "agent:blocked",
    automationDir: "/automation",
  }) };
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
  this.result = branchUpdateFinalizer(this.commands);
});

Then("deadloop は専用の競合回復作業を開始する", function (this: RecoveryWorld) {
  assert.equal(this.result?.driverAction, "branch_update_monitor_request");
});

Then("deadloop は監視者に branch を直接 push しないよう指示する", function (this: RecoveryWorld) {
  assert.ok(String(this.result?.prompt).includes("never launch or select an agent, push a branch, review the PR, or merge it"));
});

Then("deadloop は競合回復を停止して人間対応にする", function (this: RecoveryWorld) {
  assert.equal(this.result?.driverAction, "branch_update_attempt_exhausted");
});

Then("deadloop は通常レビューを開始する", function (this: RecoveryWorld) {
  assert.equal(this.result?.driverAction, "reviewer_monitor_request");
});

Then("deadloop はレビュー状態を維持する", function (this: RecoveryWorld) {
  assert.deepEqual(this.result?.labelsPreserved, ["agent:review", "agent:reviewing"]);
});

Then("deadloop は専用の修正作業を開始する", function (this: RecoveryWorld) {
  assert.equal(this.result?.action, "launch_repair");
});

Then("deadloop は修正を停止して人間対応にする", function (this: RecoveryWorld) {
  assert.equal(this.result?.action, "human_required");
});

Then("deadloop はレビューを一度だけ再試行する", function (this: RecoveryWorld) {
  assert.equal(this.result?.action, "retry");
});

Then("deadloop はレビューを停止して人間対応にする", function (this: RecoveryWorld) {
  assert.equal(this.result?.action, "human_required");
});

Then("deadloop は修正作業者に作業範囲を広げないよう指示する", function (this: RecoveryWorld) {
  assert.ok(String(this.result?.prompt).includes("Do not add features, reinterpret the issue, or widen scope"));
});

Then("deadloop は修正作業者に直接 push しないよう指示する", function (this: RecoveryWorld) {
  assert.ok(String(this.result?.prompt).includes("Do not run git push directly"));
});

Then("deadloop は branch へ push しない", function (this: RecoveryWorld) {
  assert.equal(this.commands?.some((command) => command.includes("push")), false);
});

Then("deadloop は確認した branch へ非強制で push する", function (this: RecoveryWorld) {
  assert.deepEqual(this.commands?.find((command) => command.includes("push")), ["git", "-C", "/worktree", "push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`]);
});

Then("deadloop は push 前に設定済みチェックを実行する", function (this: RecoveryWorld) {
  assert.ok((this.commands?.findIndex((command) => command[0] === "node") ?? -1) < (this.commands?.findIndex((command) => command[0] === "gh") ?? -1));
});

Then("deadloop は競合回復 branch へ非強制で push する", function (this: RecoveryWorld) {
  assert.deepEqual(this.commands?.find((command) => command.includes("push")), ["git", "-C", "/worktree", "push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`]);
});

Then("deadloop は競合回復の push 前に設定済みチェックを実行する", function (this: RecoveryWorld) {
  assert.ok((this.commands?.findIndex((command) => command[0] === "node") ?? -1) < (this.commands?.findIndex((command) => command[0] === "gh") ?? -1));
});

Then("deadloop は競合回復 branch へ push しない", function (this: RecoveryWorld) {
  assert.equal(this.commands?.some((command) => command.includes("push")), false);
});
