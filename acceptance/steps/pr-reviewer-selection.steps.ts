import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";
import { runPrReviewerDriverFixture } from "../support/pr-reviewer-driver";

const { defaultDecisionConfig, selectPrForReview, workingReviewerPrNumbers } = require("../../extensions/deadloop/automations/pr-reviewer-decisions.ts");

type PullRequest = Record<string, unknown>;
type GithubEffect = {
  operation?: string;
  reviewer?: string;
  body?: string;
  move?: { add?: string | string[]; remove?: string | string[] };
};
type DriverResult = {
  driverAction?: string;
  comment?: string;
  githubEffects?: GithubEffect[];
  testAdapterEffects?: { herdrStarts?: unknown[] };
};
type SelectionWorld = {
  fixtureName?: string;
  agentsFixtureName?: string;
  autoMerge?: boolean;
  externalReviewEnabled?: boolean;
  driverFixtureName?: string;
  decision?: { selected?: boolean; number?: number };
  driverResult?: DriverResult;
  prs?: PullRequest[];
  agents?: Record<string, unknown>;
  attempts?: Record<string, unknown>[];
};

const fixtureDirectory = path.join(process.cwd(), "test/fixtures/pr-reviewer");
const fixedNow = new Date("2026-07-04T00:30:00Z");

function readFixture(name: string): PullRequest[] {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), "utf8")) as PullRequest[];
}

function setFixture(world: SelectionWorld, fixtureName: string): void {
  world.fixtureName = fixtureName;
}

Given("レビュー待ちの pull request がある", function (this: SelectionWorld) {
  setFixture(this, "precheck-agent-review.json");
  this.driverFixtureName = "external-review-request.json";
});

Given("人間確認待ちの pull request がある", function (this: SelectionWorld) {
  setFixture(this, "precheck-ready-for-human.json");
});

Given("レビュー対象外のラベルだけを持つ pull request がある", function (this: SelectionWorld) {
  setFixture(this, "precheck-non-candidate-label.json");
});

Given("CI 実行中の pull request がある", function (this: SelectionWorld) {
  setFixture(this, "precheck-pending-checks.json");
});

Given("外部レビューの待機期限が切れた pull request がある", function (this: SelectionWorld) {
  setFixture(this, "precheck-stale-external-marker.json");
  this.driverFixtureName = "fallback-review.json";
});

Given("外部レビュー待ちの pull request がある", function (this: SelectionWorld) {
  setFixture(this, "precheck-fresh-copilot-request.json");
  this.driverFixtureName = "external-review-wait.json";
});

Given("外部レビュー担当が処理中の pull request がある", function (this: SelectionWorld) {
  setFixture(this, "precheck-fresh-copilot-request.json");
});

Given("別の外部レビュー担当が処理中の pull request がある", function (this: SelectionWorld) {
  setFixture(this, "precheck-coderabbit-processing.json");
});

Given("下書きの pull request がある", function (this: SelectionWorld) {
  setFixture(this, "precheck-draft.json");
  this.driverFixtureName = "draft-pr.json";
});

Given("稼働中の担当者がいないレビュー中の pull request がある", function (this: SelectionWorld) {
  setFixture(this, "precheck-reviewing.json");
  this.agentsFixtureName = "agents-empty.json";
});

Given("別担当がレビュー中の pull request がある", function (this: SelectionWorld) {
  setFixture(this, "precheck-reviewing.json");
  this.agents = { result: { agents: [{ name: "dl-r-13-111111111111", agent_status: "working" }] } };
  this.attempts = [{ project: "demo", repository: "owner/repo", role: "reviewer", target: { kind: "pull-request", number: 13 }, phase: "agent_started", agentName: "dl-r-13-111111111111" }];
});

Given("停止中の pull request がある", function (this: SelectionWorld) {
  setFixture(this, "precheck-blocked.json");
});

Given("レビューできない pull request とレビュー可能な pull request が混在している", function (this: SelectionWorld) {
  setFixture(this, "precheck-mixed-candidates.json");
  this.agents = { result: { agents: [{ name: "dl-r-13-111111111111", agent_status: "working" }] } };
  this.attempts = [{ project: "demo", repository: "owner/repo", role: "reviewer", target: { kind: "pull-request", number: 13 }, phase: "agent_started", agentName: "dl-r-13-111111111111" }];
});

Given("自動マージが有効である", function (this: SelectionWorld) {
  this.autoMerge = true;
});

Given("自動マージが無効である", function (this: SelectionWorld) {
  this.autoMerge = false;
});

Given("外部レビューが有効である", function (this: SelectionWorld) {
  this.externalReviewEnabled = true;
});

Given("外部レビューが無効である", function (this: SelectionWorld) {
  this.externalReviewEnabled = false;
});

When("deadloop がレビュー対象を探す", function (this: SelectionWorld) {
  if (!this.fixtureName) throw new Error("review state is missing");
  const agents = this.agents ?? (this.agentsFixtureName
    ? JSON.parse(fs.readFileSync(path.join(fixtureDirectory, this.agentsFixtureName), "utf8"))
    : { result: { agents: [] } });
  const config = defaultDecisionConfig({
    autoMerge: this.autoMerge ?? false,
    externalReviewEnabled: this.externalReviewEnabled ?? false,
    now: fixedNow,
    projectId: "demo",
  });
  this.decision = selectPrForReview(readFixture(this.fixtureName), config, workingReviewerPrNumbers(agents, config.projectId, this.attempts || [], "owner/repo"));
});

When("deadloop が外部レビューの扱いを決める", function (this: SelectionWorld) {
  if (!this.driverFixtureName) throw new Error("review state is missing");
  if (this.externalReviewEnabled === undefined) throw new Error("external review state is missing");
  this.driverResult = runDriver(this.driverFixtureName, { DEADLOOP_EXTERNAL_REVIEW_ENABLED: this.externalReviewEnabled ? "1" : "0" });
});

function runDriver(fixtureName: string, extraEnv: Record<string, string> = {}): DriverResult {
  return runDriverPath(`test/fixtures/pr-reviewer-driver/${fixtureName}`, extraEnv);
}

function runDriverPath(fixturePath: string, extraEnv: Record<string, string> = {}): DriverResult {
  return runPrReviewerDriverFixture(fixturePath, extraEnv);
}

When("deadloop がレビューを開始しようとする", function (this: SelectionWorld) {
  if (!this.driverFixtureName) throw new Error("review state is missing");
  this.driverResult = runDriver(this.driverFixtureName);
});

When("deadloop がレビュー対象を選んで処理する", function (this: SelectionWorld) {
  if (!this.fixtureName) throw new Error("review state is missing");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-acceptance-"));
  const fixturePath = path.join(tempRoot, "selection-cycle.json");
  try {
    fs.writeFileSync(fixturePath, JSON.stringify({ prs: readFixture(this.fixtureName), agents: { result: { agents: [] } } }));
    this.driverResult = runDriverPath(fixturePath);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

Given("別担当が選択後にレビューを開始している", function (this: SelectionWorld) {
  if (!this.fixtureName) throw new Error("review state is missing");
  const config = defaultDecisionConfig({ now: fixedNow, projectId: "demo" });
  this.prs = readFixture(this.fixtureName);
  const firstDecision = selectPrForReview(this.prs, config);
  const selected = this.prs.find((pr) => pr.number === firstDecision.number);
  if (!selected) throw new Error("selected pull request is missing");
  selected.labels = [...(selected.labels as unknown[]), { name: "agent:reviewing" }];
  const agentName = `dl-r-${firstDecision.number}-111111111111`;
  this.agents = { result: { agents: [{ name: agentName, agent_status: "working" }] } };
  this.attempts = [{ project: "demo", repository: "owner/repo", role: "reviewer", target: { kind: "pull-request", number: firstDecision.number }, phase: "agent_started", agentName }];
});

When("次の選定周期になる", function (this: SelectionWorld) {
  if (!this.prs || !this.agents) throw new Error("review state is missing");
  const config = defaultDecisionConfig({ now: fixedNow, projectId: "demo" });
  this.decision = selectPrForReview(this.prs, config, workingReviewerPrNumbers(this.agents, config.projectId, this.attempts || [], "owner/repo"));
});

Then("pull request #{int} をレビュー対象に選ぶ", function (this: SelectionWorld, number: number) {
  assert.equal(this.decision?.number, number);
});

Then("レビュー対象は選ばれない", function (this: SelectionWorld) {
  assert.equal(this.decision?.selected, false);
});

Then("deadloop は外部レビューを依頼する", function (this: SelectionWorld) {
  assert.equal(
    this.driverResult?.githubEffects?.some(
      (effect) => effect.operation === "add_pr_reviewer" && effect.reviewer === "@copilot",
    ),
    true,
  );
});

Then("レビュー担当は起動されない", function (this: SelectionWorld) {
  assert.equal(this.driverResult?.testAdapterEffects?.herdrStarts?.length ?? 0, 0);
});

Then("外部レビューの完了待ちになる", function (this: SelectionWorld) {
  assert.equal(this.driverResult?.driverAction, "wait");
});

Then("レビュー担当が起動される", function (this: SelectionWorld) {
  assert.equal(this.driverResult?.testAdapterEffects?.herdrStarts?.length, 1);
});

Then("pull request の復旧手順を示す", function (this: SelectionWorld) {
  const commentEffect = this.driverResult?.githubEffects?.find((effect) => effect.operation === "comment_pr");
  assert.match(commentEffect?.body ?? "", /## Recovery steps/);
});
