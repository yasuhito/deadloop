import { describe, expect, it } from "vitest";

import type { AttemptRecord, CompletionReportV1 } from "../src/attempt-lifecycle";
import {
  assertWorkerCompletionAuthorized,
  type RequiredVerificationRecord,
} from "../src/worker-required-verification";
const runtime = require("../src/worker-required-verification-runtime.cjs");

const inputHead = "a".repeat(40);
const outputHead = "b".repeat(40);
const contract = {
  repository: "octo/demo",
  command: "npm run check",
  source: { kind: "repo_policy" as const, location: "deadloop.json" },
  baseRevision: inputHead,
};
const attempt: AttemptRecord = {
  attemptId: "attempt-1",
  launchUuid: "launch-1",
  project: "demo",
  repository: "octo/demo",
  role: "worker",
  target: { kind: "issue", number: 12 },
  inputRevision: { head: inputHead },
  requiredVerification: contract,
  branch: "agent/issue-12-task",
  baseBranch: "origin/main",
  worktreePath: "/worktree",
  agentName: "dl-w-12-abcdef123456",
  workspaceLabel: "worker",
  promptFile: "/runs/attempt-1/prompt.md",
  promiseFile: "/runs/attempt-1/promise.json",
  phase: "agent_started",
  lastSuccessfulPhase: "agent_started",
};
const report: CompletionReportV1 = {
  schemaVersion: 1,
  attemptId: attempt.attemptId,
  role: "worker",
  target: { repository: attempt.repository, ...attempt.target },
  inputRevision: attempt.inputRevision,
  status: "complete",
  summary: "Implemented and checked the requested change.",
  result: { outputRevision: outputHead },
  evidence: { validations: ["npm run check passed"] },
};
const verification: RequiredVerificationRecord = {
  version: 1,
  binding: {
    repository: contract.repository,
    targetCommit: outputHead,
    command: contract.command,
    source: contract.source,
    baseRevision: contract.baseRevision,
  },
  outcome: "passed",
  exitCode: 0,
  startedAt: "2026-08-06T00:00:00.000Z",
  durationMs: 10,
  logPath: "/state/check.log",
};

describe("Worker required-verification completion gate", () => {
  it("accepts an exact passed record for the Worker output commit", () => {
    expect(assertWorkerCompletionAuthorized(attempt, report, verification, contract).outputRevision).toBe(outputHead);
  });

  it("rejects a missing persisted contract even when verification exited zero", () => {
    expect(() => assertWorkerCompletionAuthorized({ ...attempt, requiredVerification: undefined } as unknown as AttemptRecord, report, verification, contract)).toThrow("persisted contract");
  });

  it("rejects an empty persisted command even when verification exited zero", () => {
    expect(() => assertWorkerCompletionAuthorized({ ...attempt, requiredVerification: { ...contract, command: "" } }, report, verification, contract)).toThrow("zero_targets");
  });

  it("rejects a passed record for another output commit", () => {
    expect(() => assertWorkerCompletionAuthorized(attempt, report, { ...verification, binding: { ...verification.binding, targetCommit: "c".repeat(40) } }, contract)).toThrow("output commit");
  });

  it("does not promote agent validation prose without a required-verification record", () => {
    expect(() => assertWorkerCompletionAuthorized(attempt, report, undefined, contract)).toThrow("record");
  });

  it("stops when current trusted policy differs from the fixed attempt contract", () => {
    expect(() => assertWorkerCompletionAuthorized(attempt, report, verification, { ...contract, command: "npm run stricter-check" })).toThrow("stale_policy");
  });

  it("accepts the same fixed contract in TypeScript and the direct Node runtime", () => {
    expect(runtime.assertWorkerCompletionAuthorized(attempt, report, verification, contract)).toEqual(
      assertWorkerCompletionAuthorized(attempt, report, verification, contract),
    );
  });

  it("trusts a non-empty explicit command without interpreting output counts", () => {
    const explicit = { ...contract, command: "printf '0 tests\\n'" };
    const exact = { ...verification, binding: { ...verification.binding, command: explicit.command } };
    expect(assertWorkerCompletionAuthorized({ ...attempt, requiredVerification: explicit }, report, exact, explicit).outputRevision).toBe(outputHead);
  });
});
