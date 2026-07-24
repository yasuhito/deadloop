import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

const { mergeReviewedPr } = require("../../extensions/deadloop/automations/merge-reviewed-pr.ts");

const currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const previousHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
  result?: TransitionResult;
  staleApproval?: boolean;
  completionCommands?: string[][];
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

Given("外部レビューが無効に設定されている", function (this: TransitionWorld) {
  this.externalReviewEnabled = false;
});

Given("外部レビューが有効に設定されている", function (this: TransitionWorld) {
  this.externalReviewEnabled = true;
});

Given("以前の pull request head に対する承認結果がある", function (this: TransitionWorld) {
  this.staleApproval = true;
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
        DEADLOOP_AUTO_MERGE: "0",
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

When("deadloop が現在の pull request の承認処理を完了する", function (this: TransitionWorld) {
  if (!this.staleApproval) throw new Error("approval result is missing");
  const commands: string[][] = [];
  try {
    mergeReviewedPr(
      {
        projectRepo: "/repo",
        githubRepo: "owner/repo",
        stateDir: "/state",
        enabledAt: 1,
        pr: "25",
        expectedHead: currentHead,
        reviewPromise: "/state/reviewer-promise.json",
        reviewLabel: "agent:review",
        reviewingLabel: "agent:reviewing",
        blockedLabel: "agent:blocked",
      },
      {
        withLock: (_project: unknown, operation: (enabled: unknown) => number) => operation({
          firstEnableAutoMerge: false,
          firstStartPending: false,
          autoMergeAcknowledged: false,
        }),
        isAutoMergeEnabled: () => true,
        validateReviewPromise: () => ({
          status: "complete",
          promise: {
            status: "complete",
            outcome: "approved",
            reviewedHead: previousHead,
            reason: "",
            summary: "approved",
            findings: [],
          },
        }),
        run: (args: string[]) => {
          commands.push(args);
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
  } catch {
    // A stale approval must stop completion before the externally visible merge command.
  }
  this.completionCommands = commands;
});

Then("現在の pull request はマージされない", function (this: TransitionWorld) {
  assert.equal(
    this.completionCommands?.some((args) => args[0] === "gh" && args[1] === "pr" && args[2] === "merge"),
    false,
  );
});
