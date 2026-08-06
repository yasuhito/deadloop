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

Given("CI fallback verification is not explicitly configured", function (this: CiFallbackWorld) {
  configureCiFallback(this, "qorraq-all-jobs-immediate-failure.json");
});

Given("CI fallback verification is explicitly enabled", function (this: CiFallbackWorld) {
  this.enabled = true;
});

Given("Every CI job fails immediately before execution", function (this: CiFallbackWorld) {
  configureCiFallback(this, "qorraq-all-jobs-immediate-failure.json");
});

Given("An ordinary test fails in CI", function (this: CiFallbackWorld) {
  configureCiFallback(this, "qorraq-test-failure.json");
});

Given("Billing restrictions prevent CI from running", function (this: CiFallbackWorld) {
  configureCiFallback(this, "explicit-billing-message.json");
});

Given("Only some CI jobs fail", function (this: CiFallbackWorld) {
  configureCiFallback(this, "mixed-success-immediate-failure.json");
});

Given("A CI job fails after execution starts", function (this: CiFallbackWorld) {
  configureCiFallback(this, "immediate-failure-with-successful-step.json");
});

When("deadloop decides whether CI fallback verification is allowed", function (this: CiFallbackWorld) {
  decideCiFallback(this);
});

Then("CI fallback verification is not allowed", function (this: CiFallbackWorld) {
  assert.equal(decisionFrom(this).fallbackAllowed, false);
});

Then("CI fallback verification is allowed", function (this: CiFallbackWorld) {
  assert.equal(decisionFrom(this).fallbackAllowed, true);
});

Then("The failure is classified as a CI infrastructure failure", function (this: CiFallbackWorld) {
  assert.equal(decisionFrom(this).classification, "ci_infrastructure_failure");
});

Then("The failure is classified as an ordinary CI failure", function (this: CiFallbackWorld) {
  assert.equal(decisionFrom(this).classification, "ordinary_ci_failure");
});
