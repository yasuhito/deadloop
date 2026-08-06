import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";

import { runScheduledAutomation } from "../../src/automation-runner";
import { normalizeProject, type NormalizedAutomation, type NormalizedProject } from "../../src/core";

type DriverWorld = {
  automation?: NormalizedAutomation;
  project?: NormalizedProject;
  sent: string[];
  driverResult: { code: number; stdout: string; stderr: string };
};

function configureAutomation(world: DriverWorld, driverResult: DriverWorld["driverResult"], hasDriver = true): void {
  world.project = normalizeProject({
    id: "acceptance",
    automations: [
      {
        id: "acceptance:automation",
        name: "acceptance automation",
        precheckFile: "precheck.sh",
        promptFile: "normal.md",
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

Given("Automation requires judgment", function (this: DriverWorld) {
  configureAutomation(this, { code: 0, stdout: driverPayload("needs_llm", { prompt: "decision prompt" }), stderr: "" });
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
  configureAutomation(this, { code: 0, stdout: "", stderr: "" }, false);
});

When("deadloop runs the automation", async function (this: DriverWorld) {
  if (!this.project || !this.automation) throw new Error("automation precondition is missing");
  this.sent = [];
  await runScheduledAutomation(this.project, this.automation, 123, { automations: {} }, {
    isIdle: () => true,
    now: () => 456,
    readPrompt: () => "normal prompt",
    resolveAutomationFileInDir: (_kind, _automation, requested) => ({
      requested: requested || "",
      resolved: requested || "",
      found: Boolean(requested),
    }),
    runDriver: async () => {
      if (!this.automation?.driverFile) throw new Error("a prompt-only automation must not run a driver");
      return this.driverResult;
    },
    runPrecheck: async () => ({ code: 0, stdout: "", stderr: "" }),
    saveState: () => undefined,
    sendUserMessage: (prompt) => this.sent.push(prompt),
  });
});

Then("deadloop does not send a prompt", function (this: DriverWorld) {
  assert.deepEqual(this.sent, []);
});

Then("deadloop sends only the decision prompt", function (this: DriverWorld) {
  assert.deepEqual(this.sent, ["decision prompt"]);
});

Then("deadloop sends the normal prompt", function (this: DriverWorld) {
  assert.deepEqual(this.sent, ["normal prompt"]);
});
