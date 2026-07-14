import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkAcceptanceRules, loadAcceptanceSources } from "./check-acceptance-rules";

export function countStartedTestCases(messagePath: string): number {
  if (!fs.existsSync(messagePath)) return 0;
  return fs
    .readFileSync(messagePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { testCaseStarted?: unknown })
    .filter((envelope) => envelope.testCaseStarted).length;
}

export function runAcceptanceTests(cwd = process.cwd(), options: { quiet?: boolean } = {}): number {
  const reportError = (message: string): void => {
    if (!options.quiet) process.stderr.write(message);
  };
  const ruleErrors = checkAcceptanceRules(loadAcceptanceSources(cwd));
  if (ruleErrors.length) {
    reportError(`${ruleErrors.join("\n")}\n`);
    return 1;
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-cucumber-"));
  const messagePath = path.join(temporaryDirectory, "messages.ndjson");
  try {
    const executable = path.resolve(path.dirname(require.resolve("@cucumber/cucumber")), "../bin/cucumber.js");
    const result = spawnSync(process.execPath, [executable], {
      cwd,
      env: { ...process.env, DEADLOOP_CUCUMBER_MESSAGE_PATH: messagePath },
      stdio: options.quiet ? "ignore" : "inherit",
    });
    if (result.error) {
      reportError(`Cucumber could not start: ${result.error.message}\n`);
      return 1;
    }
    if ((result.status ?? 1) !== 0) return result.status ?? 1;
    const started = countStartedTestCases(messagePath);
    if (started === 0) {
      reportError("Cucumber executed 0 scenarios; acceptance tests cannot pass without an executed scenario.\n");
      return 1;
    }
    return 0;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) process.exitCode = runAcceptanceTests();
