import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runAcceptanceTests } from "../src/run-acceptance-tests";

const temporaryDirectories: string[] = [];

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
});
