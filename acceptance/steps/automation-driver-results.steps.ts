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

Given("自動化が処理不要と判断している", function (this: DriverWorld) {
  configureAutomation(this, { code: 0, stdout: driverPayload("skip"), stderr: "" });
});

Given("自動化が処理完了と報告している", function (this: DriverWorld) {
  configureAutomation(this, { code: 0, stdout: driverPayload("done"), stderr: "" });
});

Given("自動化が判断を必要としている", function (this: DriverWorld) {
  configureAutomation(this, { code: 0, stdout: driverPayload("needs_llm", { prompt: "decision prompt" }), stderr: "" });
});

Given("自動化の応答が不正である", function (this: DriverWorld) {
  configureAutomation(this, { code: 0, stdout: "not json", stderr: "" });
});

Given("自動化が失敗している", function (this: DriverWorld) {
  configureAutomation(this, { code: 1, stdout: "", stderr: "driver failed" });
});

Given("自動化が停止を報告している", function (this: DriverWorld) {
  configureAutomation(this, { code: 0, stdout: driverPayload("error", { error: "stop" }), stderr: "" });
});

Given("決定論的な判断を設定していない自動化がある", function (this: DriverWorld) {
  configureAutomation(this, { code: 0, stdout: "", stderr: "" }, false);
});

When("deadloop が自動化を実行する", async function (this: DriverWorld) {
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

Then("deadloop はプロンプトを送信しない", function (this: DriverWorld) {
  assert.deepEqual(this.sent, []);
});

Then("deadloop は判断用プロンプトだけを送信する", function (this: DriverWorld) {
  assert.deepEqual(this.sent, ["decision prompt"]);
});

Then("deadloop は通常のプロンプトを送信する", function (this: DriverWorld) {
  assert.deepEqual(this.sent, ["normal prompt"]);
});
