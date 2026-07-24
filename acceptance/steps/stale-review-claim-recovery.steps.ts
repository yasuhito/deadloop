import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

const { defaultDecisionConfig, selectPrForReview, workingReviewerPrNumbers } = require("../../extensions/deadloop/automations/pr-reviewer-decisions.ts");

type ClaimWorld = {
  prs?: Record<string, unknown>[];
  agents?: unknown;
  decision?: { selected?: boolean; number?: number; staleReclaim?: boolean; reason?: string };
};

const fixtureDirectory = path.join(process.cwd(), "test/fixtures/pr-reviewer");
const fixedNow = new Date("2026-07-04T00:30:00Z");

function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), "utf8"));
}

function setClaim(world: ClaimWorld, prFixture: string, agentsFixture: string): void {
  world.prs = fixture(prFixture) as Record<string, unknown>[];
  world.agents = fixture(agentsFixture);
}

Given("実働担当がいない古いレビュー占有がある", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-empty.json");
});

Given("レビュー担当が稼働中のレビュー占有がある", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-reviewer-working.json");
});

Given("ブランチ更新担当の完了を待つ猶予中のレビュー占有がある", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-branch-update-working.json");
});

Given("終了済みのレビュー担当だけが残るレビュー占有がある", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-reviewer-idle.json");
});

Given("意図的に停止されたレビュー占有がある", function (this: ClaimWorld) {
  setClaim(this, "precheck-blocked.json", "agents-empty.json");
});

Given("まだ占有されていないレビュー待ちの pull request がある", function (this: ClaimWorld) {
  setClaim(this, "precheck-agent-review.json", "agents-empty.json");
});

Given("古いレビュー占有の回収後に新しい担当が稼働している", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-empty.json");
  decide(this);
  this.agents = fixture("agents-reviewer-working.json");
});

function decide(world: ClaimWorld): void {
  if (!world.prs) throw new Error("review claim is missing");
  const config = defaultDecisionConfig({ now: fixedNow, projectId: "demo" });
  world.decision = selectPrForReview(world.prs, config, workingReviewerPrNumbers(world.agents, config.projectId));
}

When("deadloop が古いレビュー占有の回収対象を探す", function (this: ClaimWorld) {
  decide(this);
});

When("次の周期で古いレビュー占有の回収対象を探す", function (this: ClaimWorld) {
  decide(this);
});

Then("pull request #{int} のレビューを再開する", function (this: ClaimWorld, number: number) {
  assert.equal(this.decision?.number, number);
});

Then("選んだレビューは中断後の再開として扱われる", function (this: ClaimWorld) {
  assert.equal(this.decision?.staleReclaim, true);
});

Then("レビュー占有は回収されない", function (this: ClaimWorld) {
  assert.equal(this.decision?.selected, false);
});

Then("選んだレビューは通常の開始として扱われる", function (this: ClaimWorld) {
  assert.equal(this.decision?.staleReclaim, false);
});
