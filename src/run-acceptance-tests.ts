import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type CucumberEnvelope = {
  testCase?: { id: string; testSteps: { id: string; pickleStepId?: string }[] };
  testCaseStarted?: { id: string; testCaseId: string };
  testCaseFinished?: { testCaseStartedId: string; willBeRetried: boolean };
  testStepFinished?: {
    testCaseStartedId: string;
    testStepId: string;
    testStepResult?: { status?: string };
  };
};

export function countCompletedTestCases(messagePath: string): number {
  if (!fs.existsSync(messagePath)) return 0;
  const envelopes = fs
    .readFileSync(messagePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CucumberEnvelope);
  const pickleStepIdsByTestCase = new Map(
    envelopes
      .filter((envelope): envelope is CucumberEnvelope & { testCase: NonNullable<CucumberEnvelope["testCase"]> } =>
        Boolean(envelope.testCase),
      )
      .map((envelope) => [
        envelope.testCase.id,
        new Set(envelope.testCase.testSteps.filter((step) => step.pickleStepId).map((step) => step.id)),
      ]),
  );
  const testCaseIdByStartedId = new Map(
    envelopes
      .filter(
        (envelope): envelope is CucumberEnvelope & {
          testCaseStarted: NonNullable<CucumberEnvelope["testCaseStarted"]>;
        } => Boolean(envelope.testCaseStarted),
      )
      .map((envelope) => [envelope.testCaseStarted.id, envelope.testCaseStarted.testCaseId]),
  );
  const pickleStepStatusesByStartedId = new Map<string, Map<string, string>>();
  for (const envelope of envelopes) {
    const finished = envelope.testStepFinished;
    if (!finished?.testStepResult?.status) continue;
    const testCaseId = testCaseIdByStartedId.get(finished.testCaseStartedId);
    if (!testCaseId || !pickleStepIdsByTestCase.get(testCaseId)?.has(finished.testStepId)) continue;
    const statuses = pickleStepStatusesByStartedId.get(finished.testCaseStartedId) ?? new Map<string, string>();
    statuses.set(finished.testStepId, finished.testStepResult.status);
    pickleStepStatusesByStartedId.set(finished.testCaseStartedId, statuses);
  }
  return envelopes.filter((envelope) => {
    const finished = envelope.testCaseFinished;
    if (!finished || finished.willBeRetried) return false;
    const testCaseId = testCaseIdByStartedId.get(finished.testCaseStartedId);
    const pickleStepIds = testCaseId ? pickleStepIdsByTestCase.get(testCaseId) : undefined;
    const statuses = pickleStepStatusesByStartedId.get(finished.testCaseStartedId);
    return Boolean(
      pickleStepIds?.size &&
        statuses &&
        [...pickleStepIds].every((stepId) => statuses.get(stepId) === "PASSED"),
    );
  }).length;
}

export function runAcceptanceTests(cwd = process.cwd(), options: { quiet?: boolean } = {}): number {
  const reportError = (message: string): void => {
    if (!options.quiet) process.stderr.write(message);
  };
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
    const completed = countCompletedTestCases(messagePath);
    if (completed === 0) {
      reportError("Cucumber completed 0 non-skipped scenarios; acceptance tests cannot pass without an executed scenario.\n");
      return 1;
    }
    return 0;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) process.exitCode = runAcceptanceTests();
