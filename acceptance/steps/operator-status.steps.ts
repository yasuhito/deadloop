import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

import { EXTENSION_CODE_CHANGED_WARNING, normalizeProject } from "../../src/core";
import { buildStatusSnapshot, formatStatusReport } from "../../src/status";

const fixture = JSON.parse(readFileSync("test/fixtures/status/report-case.json", "utf8"));
const projects = fixture.projects.map(normalizeProject);

type StoppedTarget = "issue" | "pull-request";

type OperatorStatusWorld = {
  report?: string;
  warnings?: string[];
  stoppedTarget?: StoppedTarget;
  blockedComment?: string;
  commands?: string[];
};

function statusReport(warnings: string[] = []): string {
  return formatStatusReport(buildStatusSnapshot({ ...fixture, projects, warnings }));
}

function runDriverFixture(target: StoppedTarget): string {
  const isIssue = target === "issue";
  const script = isIssue
    ? "extensions/deadloop/automations/issue-coordinator-driver.ts"
    : "extensions/deadloop/automations/pr-reviewer-driver.ts";
  const fixturePath = isIssue
    ? "test/fixtures/issue-coordinator/driver-blocked-prd.json"
    : "test/fixtures/pr-reviewer-driver/draft-pr.json";
  const result = spawnSync("node", [script, "--fixture", path.join(fixturePath)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEADLOOP_PROJECT_ID: "demo",
      DEADLOOP_REPO_PATH: isIssue ? "/repo path" : "/repo",
      DEADLOOP_GITHUB_REPO: "owner/repo",
      DEADLOOP_CHECK_COMMAND: "npm test",
      DEADLOOP_WORKER_AGENT: "pi",
      DEADLOOP_REVIEWER_AGENT: "pi",
      DEADLOOP_REVIEWER_MODEL: "",
      DEADLOOP_AUTO_MERGE: "0",
      DEADLOOP_NOW: "2026-07-08T00:00:00Z",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout).comment;
}

Given("実装待ちの Issue がない", function (this: OperatorStatusWorld) {
  this.warnings = [];
});

Given("Issue #13 が実装中である", function (this: OperatorStatusWorld) {
  this.warnings = [];
});

Given("pull request #21 がレビュー待ちである", function (this: OperatorStatusWorld) {
  this.warnings = [];
});

Given("マージ済み pull request #20 の作業場所が残っている", function (this: OperatorStatusWorld) {
  this.warnings = [];
});

Given("実装中の Issue #13 の作業場所が稼働している", function (this: OperatorStatusWorld) {
  this.warnings = [];
});

Given("deadloop 拡張のコード更新が状態表示に反映されていない", function (this: OperatorStatusWorld) {
  this.warnings = [EXTENSION_CODE_CHANGED_WARNING];
});

Given("自動化が直近の実行で Issue #12 を選んでいる", function (this: OperatorStatusWorld) {
  this.warnings = [];
});

Given(
  "ローカル設定の場所が不明で、リポジトリ設定を origin\\/main の deadloop.json から読む設定である",
  function (this: OperatorStatusWorld) {
    this.warnings = [];
  },
);

When("オペレーターが deadloop の状態を表示する", function (this: OperatorStatusWorld) {
  this.report = statusReport(this.warnings);
});

Then("実装待ちの Issue はないと表示される", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /- eligible: none/);
});

Then("対象の Issue が表示される", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /- in-progress: #13 Add deadloop status report/);
});

Then("レビュー対象の pull request が表示される", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /- review target: #21 Add status report/);
});

Then("片付け候補の作業場所が表示される", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /#20 agent\/issue-12-old -> .*\(workspace-20; merged_pr\)/);
});

Then("稼働中の作業場所が表示される", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /agent\/issue-13-add-deadloop-status-report -> .*\(workspace-13\)/);
});

Then("コード更新の警告が表示される", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", new RegExp(EXTENSION_CODE_CHANGED_WARNING));
});

Then("自動化の直近の判断が表示される", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /summary=driver selected Issue #12/);
});

Then("設定元が表示される", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /config: local=unknown local projects\.json; repoPolicy=origin\/main:deadloop\.json \(not-read\)/);
});

Given(
  "PRD、設計、または親課題に相当する Issue #11 が実装待ちである",
  function (this: OperatorStatusWorld) {
    this.stoppedTarget = "issue";
  },
);

When("deadloop が停止コメントを作成する", function (this: OperatorStatusWorld) {
  if (!this.stoppedTarget) throw new Error("stopped target is required");
  this.blockedComment = runDriverFixture(this.stoppedTarget);
});

Then("停止コメントに理由が表示される", function (this: OperatorStatusWorld) {
  assert.match(this.blockedComment || "", /Skipped automated implementation because this looks like a PRD, design, or parent issue/);
});

Then("停止コメントに復旧手順が表示される", function (this: OperatorStatusWorld) {
  assert.match(this.blockedComment || "", /## Recovery steps/);
});

Then("停止コメントに安全な再投入方法が表示される", function (this: OperatorStatusWorld) {
  assert.match(this.blockedComment || "", /gh issue edit 11 -R owner\/repo --remove-label agent:blocked --add-label agent:implement/);
});

Given("pull request #23 が下書きでレビュー待ちである", function (this: OperatorStatusWorld) {
  this.stoppedTarget = "pull-request";
});

Then("pull request の停止コメントに理由が表示される", function (this: OperatorStatusWorld) {
  assert.match(this.blockedComment || "", /Skipped automated review and auto-merge because the PR is a draft/);
});

Then("pull request の停止コメントに復旧手順が表示される", function (this: OperatorStatusWorld) {
  assert.match(this.blockedComment || "", /## Recovery steps/);
});

Then("pull request の停止コメントに安全な再投入方法が表示される", function (this: OperatorStatusWorld) {
  assert.match(this.blockedComment || "", /gh issue edit <issueNumber> -R owner\/repo --remove-label agent:blocked --add-label agent:implement/);
});

Given("deadloop 拡張を起動できる", function (this: OperatorStatusWorld) {
  this.commands = [];
});

When("deadloop 拡張が公開コマンドを登録する", function (this: OperatorStatusWorld) {
  const extension = require("../../extensions/deadloop/index.ts").default;
  extension({
    registerCommand: (name: string) => this.commands?.push(name),
    on: () => {},
  });
});

Then("`\\/deadloop-status` が利用できる", function (this: OperatorStatusWorld) {
  assert.ok(this.commands?.includes("deadloop-status"));
});
