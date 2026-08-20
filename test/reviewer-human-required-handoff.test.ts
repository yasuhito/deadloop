import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewerFixture } from "./fixtures/attempt-workspace";

const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-review-handoff-"));
const stateDir = path.join(root, "deadloop");
let reconcilePersistedAttemptJournals: (...args: any[]) => Promise<boolean>;

beforeAll(async () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.resetModules();
  // @ts-expect-error Vitest transforms this runtime extension import.
  ({ reconcilePersistedAttemptJournals } = await import("../extensions/deadloop/index"));
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const project = {
  id: "demo",
  githubRepo: "octo/demo",
  repoPath: "/repo",
  enabledAt: 1,
  autoMerge: false,
  labels: { ready: "ready", implement: "implement", inProgress: "progress", review: "review", blocked: "blocked", human: "human" },
};

// A review that ran to completion and reported human_required, as measured on PR #228: the agent
// stopped after writing its report, so the journal is still at agent_started and the workspace is
// still open.
function writeCompletedHumanRequiredReview() {
  rmSync(path.join(stateDir, "runs"), { recursive: true, force: true });
  const runDir = path.join(stateDir, "runs", "one");
  mkdirSync(runDir, { recursive: true });
  const promiseFile = path.join(runDir, "promise.json");
  const fixture = reviewerFixture("human_required");
  writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
    ...fixture.record,
    project: project.id,
    promiseFile,
    phase: "agent_started",
    lastSuccessfulPhase: "agent_started",
    autoMergePolicy: false,
  }));
  writeFileSync(promiseFile, JSON.stringify({
    ...fixture.report,
    result: {
      ...fixture.report.result,
      findings: [{ title: "Retract stale markers", body: "Re-observe the head", path: "src/a.ts", line: 1, severity: "major" }],
      advisories: [],
      priorRequiredFindings: "mixed",
    },
  }));
}

async function reconcileWithRecordedCommands() {
  const commands: string[][] = [];
  await reconcilePersistedAttemptJournals(
    { exec: async (_command: string, args: string[]) => { commands.push(args); return { code: 0, stdout: '{"action":"done"}' }; } },
    project,
  );
  return commands;
}

describe("completed human_required review handoff", () => {
  it("runs the completion handler for a review that completed with human_required", async () => {
    writeCompletedHumanRequiredReview();
    const commands = await reconcileWithRecordedCommands();
    expect(commands.some((args) => String(args[0]).endsWith("complete-attempt-workspace.cts"))).toBe(true);
  });
});
