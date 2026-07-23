import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateMessages } from "@cucumber/gherkin";
import { IdGenerator, SourceMediaType } from "@cucumber/messages";

type CucumberEnvelope = {
  pickle?: {
    id: string;
    uri: string;
    location?: { line: number; column?: number };
    name: string;
    steps: readonly { text: string }[];
  };
  testCase?: { id: string; pickleId?: string; testSteps: { id: string; pickleStepId?: string }[] };
  testCaseStarted?: { id: string; testCaseId: string };
  testCaseFinished?: { testCaseStartedId: string; willBeRetried: boolean };
  testStepFinished?: {
    testCaseStartedId: string;
    testStepId: string;
    testStepResult?: { status?: string };
  };
};

function pickleIdentity(
  pickle: NonNullable<CucumberEnvelope["pickle"]>,
  cwd: string,
): string {
  return JSON.stringify({
    uri: path.relative(cwd, path.resolve(cwd, pickle.uri)),
    location: pickle.location,
    name: pickle.name,
    steps: pickle.steps.map((step) => step.text),
  });
}

export function countCompletedTestCases(
  messagePath: string,
  discoveredPickles?: Set<string>,
  cwd = process.cwd(),
): number {
  if (!fs.existsSync(messagePath)) return 0;
  const envelopes = fs
    .readFileSync(messagePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CucumberEnvelope);
  const pickleIds = new Map(
    envelopes
      .filter((envelope): envelope is CucumberEnvelope & { pickle: NonNullable<CucumberEnvelope["pickle"]> } =>
        Boolean(envelope.pickle),
      )
      .filter((envelope) => !discoveredPickles || discoveredPickles.has(pickleIdentity(envelope.pickle, cwd)))
      .map((envelope) => [envelope.pickle.id, true]),
  );
  const pickleStepIdsByTestCase = new Map(
    envelopes
      .filter((envelope): envelope is CucumberEnvelope & { testCase: NonNullable<CucumberEnvelope["testCase"]> } =>
        Boolean(envelope.testCase) && (!discoveredPickles || Boolean(envelope.testCase.pickleId && pickleIds.has(envelope.testCase.pickleId))),
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

function discoveredPickleIdentities(cwd: string): Set<string> {
  const featureRoot = path.join(cwd, "acceptance/features");
  if (!fs.existsSync(featureRoot)) return new Set();
  const identities = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (file.endsWith(".feature.md")) {
        const envelopes = generateMessages(
          fs.readFileSync(file, "utf8"),
          file,
          SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_MARKDOWN,
          {
            defaultDialect: "ja",
            includeGherkinDocument: false,
            includePickles: true,
            includeSource: false,
            newId: IdGenerator.incrementing(),
          },
        );
        for (const envelope of envelopes) {
          if (envelope.pickle) identities.add(pickleIdentity(envelope.pickle, cwd));
        }
      }
    }
  };
  visit(featureRoot);
  return identities;
}

export function runAcceptanceTests(cwd = process.cwd(), options: { quiet?: boolean } = {}): number {
  const reportError = (message: string): void => {
    if (!options.quiet) process.stderr.write(message);
  };
  const discovered = discoveredPickleIdentities(cwd);
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
    if (discovered.size === 0) {
      reportError("Cucumber discovered 0 scenarios; acceptance tests cannot pass without a discovered scenario.\n");
      return 1;
    }
    const completed = countCompletedTestCases(messagePath, discovered, cwd);
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
