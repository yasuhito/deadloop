import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";

import { runScheduledAutomation } from "../../src/automation-runner";
import { normalizeProject, type NormalizedAutomation, type NormalizedProject } from "../../src/core";

type DriverWorld = {
  automation?: NormalizedAutomation;
  project?: NormalizedProject;
  configError?: Error;
  savedEntry?: Record<string, unknown>;
  driverResult: { code: number; stdout: string; stderr: string };
};

function configureAutomation(world: DriverWorld, driverResult: DriverWorld["driverResult"], hasDriver = true): void {
  world.project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",
    id: "acceptance",
    automations: [
      {
        id: "acceptance:automation",
        name: "acceptance automation",
        ...(hasDriver ? { driverFile: "driver.ts" } : {}),
      },
    ],
  });
  world.automation = world.project.automations[0];
  world.driverResult = driverResult;
}

function driverPayload(action: string, extra: Record<string, string> = {}): string {
  return JSON.stringify({ action, summary: "acceptance result", ...extra });
}

Given("Automation determines that no action is required", function (this: DriverWorld) {
  configureAutomation(this, { code: 0, stdout: driverPayload("skip"), stderr: "" });
});

Given("Automation reports that processing is complete", function (this: DriverWorld) {
  configureAutomation(this, { code: 0, stdout: driverPayload("done"), stderr: "" });
});

Given("Automation returns an invalid response", function (this: DriverWorld) {
  configureAutomation(this, { code: 0, stdout: "not json", stderr: "" });
});

Given("Automation has failed", function (this: DriverWorld) {
  configureAutomation(this, { code: 1, stdout: "", stderr: "driver failed" });
});

Given("Automation reports a stop", function (this: DriverWorld) {
  configureAutomation(this, { code: 0, stdout: driverPayload("error", { error: "stop" }), stderr: "" });
});

Given("Automation has no deterministic driver configured", function (this: DriverWorld) {
  try {
    normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",
      id: "acceptance",
      automations: [{ id: "acceptance:automation", name: "acceptance automation" }],
    });
  } catch (error) {
    this.configError = error instanceof Error ? error : new Error(String(error));
    return;
  }
  throw new Error("an automation without a driverFile must fail configuration");
});

When("deadloop runs the automation", async function (this: DriverWorld) {
  if (!this.project || !this.automation) throw new Error("automation precondition is missing");
  const state = { automations: {} as Record<string, Record<string, unknown>> };
  await runScheduledAutomation(this.project, this.automation, 123, state, {
    now: () => 456,
    prepareExecutionSupply: () => ({ codeIdentity: "a".repeat(40), lockHash: "b".repeat(64), packageRoot: "/snapshot", automationDir: "/snapshot/automations", dependencyRoot: "/dependencies" }),
    resolveAutomationFileInDir: (_kind, _automation, requested) => ({
      requested: requested || "",
      resolved: requested || "",
      found: Boolean(requested),
    }),
    runDriver: async () => this.driverResult,
    saveState: () => undefined,
  });
  this.savedEntry = Object.values(state.automations)[0];
});

When("deadloop loads the project configuration", function (this: DriverWorld) {
  if (!this.configError) throw new Error("no configuration error was recorded");
});

Then("deadloop records the driver skip result", function (this: DriverWorld) {
  assert.equal(this.savedEntry?.lastResult, "driver_skip");
});

Then("deadloop records the driver done result", function (this: DriverWorld) {
  assert.equal(this.savedEntry?.lastResult, "driver_done");
});

Then("deadloop records the driver invalid JSON failure", function (this: DriverWorld) {
  assert.equal(this.savedEntry?.lastResult, "driver_invalid_json");
});

Then("deadloop records the driver error failure", function (this: DriverWorld) {
  assert.equal(this.savedEntry?.lastResult, "driver_error");
});

Then("deadloop reports a configuration error", function (this: DriverWorld) {
  assert.match(this.configError?.message || "", /driverFile is required/);
});
