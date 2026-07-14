import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { countCompletedTestCases, runAcceptanceTests } from "../src/run-acceptance-tests";

const temporaryDirectories: string[] = [];

function fixtureWithDryRun(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-dry-run-"));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, "acceptance/features"), { recursive: true });
  fs.mkdirSync(path.join(root, "acceptance/steps"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "acceptance/features/dry-run.feature.md"),
    "# 機能: dry-run 検査\n\n## シナリオ: ステップを実行する\n\n* 前提 必ず失敗する\n* もし 実行する\n* ならば 結果がある\n",
  );
  fs.writeFileSync(
    path.join(root, "acceptance/steps/dry-run.steps.ts"),
    `import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
Given("必ず失敗する", function () { throw new Error("must execute"); });
When("実行する", function () {});
Then("結果がある", function () { assert.ok(true); });
`,
  );
  fs.writeFileSync(
    path.join(root, "cucumber.cjs"),
    `module.exports = { default: {
  paths: ["acceptance/features/**/*.feature.md"],
  requireModule: ["tsx/cjs"],
  require: ["acceptance/steps/**/*.ts", "acceptance/support/**/*.ts"],
  language: "ja",
  strict: true,
  dryRun: true,
  format: ["progress", \`message:\${process.env.DEADLOOP_CUCUMBER_MESSAGE_PATH}\`],
} };\n`,
  );
  return root;
}

function fixtureWithUnmatchedFeatureLanguage(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-zero-scenarios-"));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, "acceptance/features"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "acceptance/features/present.feature.md"),
    "# Feature: discovery check\n\n## Scenario: a target exists\n\n* Given a state\n* When an action occurs\n* Then a result is visible\n",
  );
  fs.writeFileSync(
    path.join(root, "cucumber.cjs"),
    `module.exports = { default: {
  paths: ["acceptance/features/**/*.feature.md"],
  requireModule: ["tsx/cjs"],
  require: ["acceptance/steps/**/*.ts", "acceptance/support/**/*.ts"],
  language: "ja",
  strict: true,
  format: ["progress", \`message:\${process.env.DEADLOOP_CUCUMBER_MESSAGE_PATH}\`],
} };\n`,
  );
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("acceptance test runner", () => {
  it("fails when the configured language executes zero scenarios", () => {
    expect(runAcceptanceTests(fixtureWithUnmatchedFeatureLanguage(), { quiet: true })).toBe(1);
  });

  it("rejects a dry-run fixture whose Given would throw", () => {
    expect(runAcceptanceTests(fixtureWithDryRun(), { quiet: true })).toBe(1);
  });

  it("does not count a skipped test case as completed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-skipped-messages-"));
    temporaryDirectories.push(root);
    const messagePath = path.join(root, "messages.ndjson");
    fs.writeFileSync(
      messagePath,
      [
        { testStepFinished: { testCaseStartedId: "started", testStepResult: { status: "SKIPPED" } } },
        { testCaseFinished: { testCaseStartedId: "started", willBeRetried: false } },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n"),
    );
    expect(countCompletedTestCases(messagePath)).toBe(0);
  });
});
