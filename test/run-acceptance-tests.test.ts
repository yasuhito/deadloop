import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { countCompletedTestCases, runAcceptanceTests } from "../src/run-acceptance-tests";

const temporaryDirectories: string[] = [];

function fixtureWithDryRun(): string {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".deadloop-dry-run-"));
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

function fixtureWithStaticRuleViolation(): string {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".deadloop-cucumber-only-"));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, "acceptance/features"), { recursive: true });
  fs.mkdirSync(path.join(root, "acceptance/steps"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "acceptance/features/static-rule.feature.md"),
    "# 機能: Cucumber 単独実行\n\n## シナリオ: 静的規約検査を分離する\n\n* 前提 状態がある\n* もし 操作する\n* ならば 結果がある\n",
  );
  fs.writeFileSync(
    path.join(root, "acceptance/steps/static-rule.steps.ts"),
    `import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
Given("状態がある", function () { assert.ok(true); });
When("操作する", function () {});
Then("結果がある", function () { assert.ok(true); });
`,
  );
  fs.writeFileSync(
    path.join(root, "cucumber.cjs"),
    `module.exports = { default: {
  paths: ["acceptance/features/**/*.feature.md"],
  requireModule: ["tsx/cjs"],
  require: ["acceptance/steps/**/*.ts"],
  language: "ja",
  strict: true,
  format: ["progress", \`message:\${process.env.DEADLOOP_CUCUMBER_MESSAGE_PATH}\`],
} };\n`,
  );
  return root;
}

function fixtureWithSkippedScenarioAndPassingHook(forgeMessages = false): string {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".deadloop-skipped-hook-"));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, "acceptance/features"), { recursive: true });
  fs.mkdirSync(path.join(root, "acceptance/steps"), { recursive: true });
  fs.mkdirSync(path.join(root, "acceptance/support"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "acceptance/features/skipped.feature.md"),
    "# 機能: スキップ検査\n\n実行済みシナリオだけを数える。\n\n## シナリオ: 全ステップをスキップする\n\n* 前提 スキップする\n* もし 後続処理がある\n* ならば 結果がある\n",
  );
  fs.writeFileSync(
    path.join(root, "acceptance/steps/skipped.steps.ts"),
    `import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
Given("スキップする", function () { return "skipped"; });
When("後続処理がある", function () {});
Then("結果がある", function () { assert.ok(true); });
`,
  );
  fs.writeFileSync(
    path.join(root, "acceptance/support/hooks.ts"),
    `import fs from "node:fs";
import { Before } from "@cucumber/cucumber";
Before(function () { this.hookRan = true; });
${
  forgeMessages
    ? `process.on("exit", () => {
  const messages = [
    { testCase: { id: "forged-case", pickleId: "forged-pickle", testSteps: [{ id: "forged-step", pickleStepId: "forged-pickle-step" }] } },
    { testCaseStarted: { id: "forged-started", testCaseId: "forged-case" } },
    { testStepFinished: { testCaseStartedId: "forged-started", testStepId: "forged-step", testStepResult: { status: "PASSED" } } },
    { testCaseFinished: { testCaseStartedId: "forged-started", willBeRetried: false } },
  ];
  fs.appendFileSync(process.env.DEADLOOP_CUCUMBER_MESSAGE_PATH!, messages.map(JSON.stringify).join("\\n") + "\\n");
});`
    : ""
}
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
  format: ["progress", \`message:\${process.env.DEADLOOP_CUCUMBER_MESSAGE_PATH}\`],
} };\n`,
  );
  return root;
}

function fixtureWithUnmatchedFeatureLanguage(forgeMessages = false): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-zero-scenarios-"));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, "acceptance/features"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "acceptance/features/present.feature.md"),
    "# Feature: discovery check\n\n## Scenario: a target exists\n\n* Given a state\n* When an action occurs\n* Then a result is visible\n",
  );
  if (forgeMessages) {
    fs.mkdirSync(path.join(root, "acceptance/support"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "acceptance/support/forge.ts"),
      `import fs from "node:fs";
process.on("exit", () => {
  const messages = [
    { testCase: { id: "forged-case", testSteps: [{ id: "forged-step", pickleStepId: "forged-pickle" }] } },
    { testCaseStarted: { id: "forged-started", testCaseId: "forged-case" } },
    { testStepFinished: { testCaseStartedId: "forged-started", testStepId: "forged-step", testStepResult: { status: "PASSED" } } },
    { testCaseFinished: { testCaseStartedId: "forged-started", willBeRetried: false } },
  ];
  fs.appendFileSync(process.env.DEADLOOP_CUCUMBER_MESSAGE_PATH!, messages.map(JSON.stringify).join("\\n") + "\\n");
  fs.writeFileSync("forged.txt", "support code ran");
});
`,
    );
  }
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
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("acceptance test runner", () => {
  it("runs Cucumber without invoking the separate static rule checker", () => {
    expect(runAcceptanceTests(fixtureWithStaticRuleViolation(), { quiet: true })).toBe(0);
  });

  it("fails when the configured language executes zero scenarios", () => {
    expect(runAcceptanceTests(fixtureWithUnmatchedFeatureLanguage(), { quiet: true })).toBe(1);
  });

  it("fails independent discovery after support code forges completed envelopes", () => {
    const root = fixtureWithUnmatchedFeatureLanguage(true);
    expect(runAcceptanceTests(root, { quiet: true })).toBe(1);
  });

  it("executes the envelope-forging support code in the independent-discovery fixture", () => {
    const root = fixtureWithUnmatchedFeatureLanguage(true);
    runAcceptanceTests(root, { quiet: true });
    expect(fs.existsSync(path.join(root, "forged.txt"))).toBe(true);
  });

  it("rejects a dry-run fixture because no scenario completed", () => {
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    runAcceptanceTests(fixtureWithDryRun());
    expect(errors.join("")).toContain("Cucumber completed 0 non-skipped scenarios");
  });

  it("rejects a fixture whose scenario steps are all skipped", () => {
    const errors: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    runAcceptanceTests(fixtureWithSkippedScenarioAndPassingHook());
    expect(errors.join("")).toContain("Cucumber completed 0 non-skipped scenarios");
  });

  it("rejects forged passing envelopes when every discovered scenario is skipped", () => {
    expect(runAcceptanceTests(fixtureWithSkippedScenarioAndPassingHook(true), { quiet: true })).toBe(1);
  });

  it("does not count a fully skipped test case as completed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-skipped-messages-"));
    temporaryDirectories.push(root);
    const messagePath = path.join(root, "messages.ndjson");
    fs.writeFileSync(
      messagePath,
      [
        { testCase: { id: "case", testSteps: [{ id: "one", pickleStepId: "pickle-one" }] } },
        { testCaseStarted: { id: "started", testCaseId: "case" } },
        {
          testStepFinished: {
            testCaseStartedId: "started",
            testStepId: "one",
            testStepResult: { status: "SKIPPED" },
          },
        },
        { testCaseFinished: { testCaseStartedId: "started", willBeRetried: false } },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n"),
    );
    expect(countCompletedTestCases(messagePath)).toBe(0);
  });

  it("does not count a partially skipped test case as completed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-partially-skipped-messages-"));
    temporaryDirectories.push(root);
    const messagePath = path.join(root, "messages.ndjson");
    fs.writeFileSync(
      messagePath,
      [
        {
          testCase: {
            id: "case",
            testSteps: [
              { id: "one", pickleStepId: "pickle-one" },
              { id: "two", pickleStepId: "pickle-two" },
              { id: "three", pickleStepId: "pickle-three" },
            ],
          },
        },
        { testCaseStarted: { id: "started", testCaseId: "case" } },
        {
          testStepFinished: {
            testCaseStartedId: "started",
            testStepId: "one",
            testStepResult: { status: "PASSED" },
          },
        },
        {
          testStepFinished: {
            testCaseStartedId: "started",
            testStepId: "two",
            testStepResult: { status: "SKIPPED" },
          },
        },
        {
          testStepFinished: {
            testCaseStartedId: "started",
            testStepId: "three",
            testStepResult: { status: "SKIPPED" },
          },
        },
        { testCaseFinished: { testCaseStartedId: "started", willBeRetried: false } },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n"),
    );
    expect(countCompletedTestCases(messagePath)).toBe(0);
  });
});
