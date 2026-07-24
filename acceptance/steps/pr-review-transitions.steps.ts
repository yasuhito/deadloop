import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

type GithubEffect = { operation?: string; reviewer?: string };
type TransitionResult = {
  driverAction?: string;
  githubEffects?: GithubEffect[];
  prompt?: string;
  testAdapterEffects?: { herdrStarts?: unknown[] };
};
type TransitionWorld = {
  fixtureName?: string;
  externalReviewEnabled?: boolean;
  autoMerge?: boolean;
  result?: TransitionResult;
};

Given("現在レビューできる pull request がない", function (this: TransitionWorld) {
  this.fixtureName = "no-candidate.json";
});

Given("pull request の CI が実行中である", function (this: TransitionWorld) {
  this.fixtureName = "pending-ci.json";
});

Given("CI が完了したレビュー待ちの pull request がある", function (this: TransitionWorld) {
  this.fixtureName = "external-review-request.json";
});

Given("以前の pull request head にだけ外部レビューを依頼している", function (this: TransitionWorld) {
  this.fixtureName = "previous-head-external-review.json";
});

Given("現在の pull request head の外部レビュー待機期限が切れている", function (this: TransitionWorld) {
  this.fixtureName = "fallback-review.json";
});

Given("外部レビューが無効に設定されている", function (this: TransitionWorld) {
  this.externalReviewEnabled = false;
});

Given("外部レビューが有効に設定されている", function (this: TransitionWorld) {
  this.externalReviewEnabled = true;
});

Given("自動マージが無効に設定されている", function (this: TransitionWorld) {
  this.autoMerge = false;
});

When("deadloop が pull request の次の処理を決める", function (this: TransitionWorld) {
  if (!this.fixtureName) throw new Error("pull request state is missing");
  const result = spawnSync(
    "node",
    ["extensions/deadloop/automations/pr-reviewer-driver.ts", "--fixture", path.join("test/fixtures/pr-reviewer-driver", this.fixtureName)],
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
        DEADLOOP_AUTO_MERGE: this.autoMerge ? "1" : "0",
        DEADLOOP_EXTERNAL_REVIEW_ENABLED: this.externalReviewEnabled ? "1" : "0",
        DEADLOOP_NOW: "2026-07-08T00:00:00Z",
      },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  this.result = JSON.parse(result.stdout) as TransitionResult;
});

Then("レビュー処理は開始されない", function (this: TransitionWorld) {
  assert.equal(this.result?.testAdapterEffects?.herdrStarts?.length ?? 0, 0);
});

Then("CI の完了待ちになる", function (this: TransitionWorld) {
  assert.equal(this.result?.driverAction, "wait");
});

Then("通常レビューを開始する", function (this: TransitionWorld) {
  assert.equal(this.result?.testAdapterEffects?.herdrStarts?.length, 1);
});

Then("現在の head の外部レビューを依頼する", function (this: TransitionWorld) {
  assert.equal(
    this.result?.githubEffects?.some(
      (effect) => effect.operation === "add_pr_reviewer" && effect.reviewer === "@copilot",
    ),
    true,
  );
});

Then("自動マージを無効にしたまま引き渡す", function (this: TransitionWorld) {
  assert.match(this.result?.prompt ?? "", /If autoMerge=false, never merge/);
});
