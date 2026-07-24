import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

type CiFallbackWorld = {
  enabled?: boolean;
  fixtureName?: string;
  decision?: Record<string, unknown>;
};

const fixtureDirectory = path.join(process.cwd(), "test/fixtures/ci-fallback");

function configureCiFallback(world: CiFallbackWorld, fixtureName: string): void {
  world.fixtureName = fixtureName;
}

function decideCiFallback(world: CiFallbackWorld): void {
  if (!world.fixtureName) throw new Error("CI fallback precondition is missing");
  const enabledArgs = world.enabled === undefined ? [] : ["--enabled", String(world.enabled)];
  const result = spawnSync(
    "node",
    [
      "extensions/deadloop/automations/ci-fallback-decision.ts",
      "--input",
      path.join(fixtureDirectory, world.fixtureName),
      ...enabledArgs,
      "--mode",
      "billing-only",
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  world.decision = JSON.parse(result.stdout);
}

function decisionFrom(world: CiFallbackWorld): Record<string, unknown> {
  if (!world.decision) throw new Error("CI fallback decision is missing");
  return world.decision;
}

Given("CI 代替検証を明示設定していない", function (this: CiFallbackWorld) {
  configureCiFallback(this, "qorraq-all-jobs-immediate-failure.json");
});

Given("CI 代替検証を明示的に有効にしている", function (this: CiFallbackWorld) {
  this.enabled = true;
});

Given("すべての CI ジョブが実行前にすぐ失敗している", function (this: CiFallbackWorld) {
  configureCiFallback(this, "qorraq-all-jobs-immediate-failure.json");
});

Given("通常のテストが CI で失敗している", function (this: CiFallbackWorld) {
  configureCiFallback(this, "qorraq-test-failure.json");
});

Given("CI が課金制限により実行できない", function (this: CiFallbackWorld) {
  configureCiFallback(this, "explicit-billing-message.json");
});

Given("一部の CI ジョブだけが失敗している", function (this: CiFallbackWorld) {
  configureCiFallback(this, "mixed-success-immediate-failure.json");
});

Given("CI ジョブが実行後に失敗している", function (this: CiFallbackWorld) {
  configureCiFallback(this, "immediate-failure-with-successful-step.json");
});

When("deadloop が CI 代替検証の可否を判定する", function (this: CiFallbackWorld) {
  decideCiFallback(this);
});

Then("CI 代替検証は許可されない", function (this: CiFallbackWorld) {
  assert.equal(decisionFrom(this).fallbackAllowed, false);
});

Then("CI 代替検証は許可される", function (this: CiFallbackWorld) {
  assert.equal(decisionFrom(this).fallbackAllowed, true);
});

Then("CI 障害として分類される", function (this: CiFallbackWorld) {
  assert.equal(decisionFrom(this).classification, "ci_infrastructure_failure");
});

Then("通常の CI 失敗として分類される", function (this: CiFallbackWorld) {
  assert.equal(decisionFrom(this).classification, "ordinary_ci_failure");
});
