import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runAcceptanceTests } from "../src/run-acceptance-tests";

const temporaryDirectories: string[] = [];

function fixtureWithUnmatchedCucumberPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-zero-scenarios-"));
  temporaryDirectories.push(root);
  fs.mkdirSync(path.join(root, "acceptance/features"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "acceptance/features/present.feature.md"),
    "# 機能: 検出確認\n\n## シナリオ: 対象が存在する\n\n* 前提 状態がある\n* もし 操作する\n* ならば 結果が見える\n",
  );
  fs.writeFileSync(
    path.join(root, "cucumber.cjs"),
    `module.exports = { default: {
  paths: ["acceptance/features/missing/**/*.feature.md"],
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
  it("fails when the configured discovery path executes zero scenarios", () => {
    expect(runAcceptanceTests(fixtureWithUnmatchedCucumberPath(), { quiet: true })).toBe(1);
  });
});
