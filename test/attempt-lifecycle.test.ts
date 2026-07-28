import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  attemptRecordPath,
  createPreparedAttempt,
  readAttemptRecord,
  transitionAttempt,
  transitionPersistedAttempt,
  validateCompletionReportBinding,
  withPreparedAttempt,
  writeAttemptRecordAtomically,
} from "../src/attempt-lifecycle";

const roots: string[] = [];

function runDirectory(): string {
  const root = mkdtempSync(path.join(process.cwd(), ".deadloop-attempt-"));
  roots.push(root);
  return root;
}

function preparedAttempt(runDir = runDirectory()) {
  return createPreparedAttempt(runDir, {
    attemptId: "attempt-001",
    launchUuid: "launch-001",
    project: "demo",
    repository: "octo/demo",
    role: "reviewer",
    target: { kind: "pull-request", number: 42 },
    inputRevision: { head: "a".repeat(40), base: "b".repeat(40) },
    branch: "feature/review",
    baseBranch: "main",
    worktreePath: "/worktrees/review",
    agentName: "dl-r-42-123456789abc",
    workspaceLabel: "Review PR #42",
    promptFile: path.join(runDir, "reviewer-prompt.md"),
    promiseFile: path.join(runDir, "promise.json"),
  });
}

function matchingReport() {
  return {
    schemaVersion: 1 as const,
    attemptId: "attempt-001",
    role: "reviewer" as const,
    target: { repository: "octo/demo", kind: "pull-request" as const, number: 42 },
    inputRevision: { head: "a".repeat(40), base: "b".repeat(40) },
    status: "complete" as const,
    summary: "Approved.",
    result: { outcome: "approved" },
    evidence: { checks: [] },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("attempt lifecycle contract", () => {
  it("rejects a report with another attempt ID", () => {
    const record = preparedAttempt();

    expect(() => validateCompletionReportBinding(record, { ...matchingReport(), attemptId: "attempt-002" })).toThrow(
      "attemptId",
    );
  });

  it("rejects a report with another role", () => {
    const record = preparedAttempt();

    expect(() => validateCompletionReportBinding(record, { ...matchingReport(), role: "worker" })).toThrow("role");
  });

  it("rejects a report with another target", () => {
    const record = preparedAttempt();

    expect(() =>
      validateCompletionReportBinding(record, {
        ...matchingReport(),
        target: { ...matchingReport().target, number: 43 },
      }),
    ).toThrow("target");
  });

  it("rejects a report with another repository", () => {
    const record = preparedAttempt();

    expect(() =>
      validateCompletionReportBinding(record, {
        ...matchingReport(),
        target: { ...matchingReport().target, repository: "octo/other" },
      }),
    ).toThrow("repository");
  });

  it("rejects a report with another input revision", () => {
    const record = preparedAttempt();

    expect(() =>
      validateCompletionReportBinding(record, {
        ...matchingReport(),
        inputRevision: { head: "c".repeat(40), base: "b".repeat(40) },
      }),
    ).toThrow("inputRevision");
  });

  it("persists prepared before the modeled external mutation", () => {
    const runDir = runDirectory();

    const observed = withPreparedAttempt(
      runDir,
      {
        attemptId: "attempt-001",
        launchUuid: "launch-001",
        project: "demo",
        repository: "octo/demo",
        role: "reviewer",
        target: { kind: "pull-request", number: 42 },
        inputRevision: { head: "a".repeat(40) },
        branch: "feature/review",
        worktreePath: "/worktrees/review",
        agentName: "dl-r-42-123456789abc",
        workspaceLabel: "Review PR #42",
        promptFile: path.join(runDir, "reviewer-prompt.md"),
        promiseFile: path.join(runDir, "promise.json"),
      },
      () => existsSync(attemptRecordPath(runDir)),
    ).result;

    expect(observed).toBe(true);
  });

  it("only permits the next successful lifecycle phase", () => {
    const record = preparedAttempt();

    expect(() => transitionAttempt(record, "workspace_opened")).toThrow("github_claimed");
  });

  it("retains the last successful phase when launch fails", () => {
    const record = transitionAttempt(
      transitionAttempt(preparedAttempt(), "github_claimed"),
      "launch_failed",
      "Herdr unavailable",
    );

    expect(record.lastSuccessfulPhase).toBe("github_claimed");
  });

  it("persists lifecycle transitions atomically", () => {
    const runDir = runDirectory();
    preparedAttempt(runDir);
    transitionPersistedAttempt(runDir, "github_claimed");

    expect(readAttemptRecord(runDir).phase).toBe("github_claimed");
  });

  it("recovers the complete current record when an interrupted replacement leaves a temporary file", () => {
    const runDir = runDirectory();
    const record = preparedAttempt(runDir);
    writeFileSync(`${attemptRecordPath(runDir)}.tmp`, "{", "utf8");

    expect(readAttemptRecord(runDir)).toEqual(record);
  });

  it("rejects malformed persisted state without overwriting it", () => {
    const record = preparedAttempt();
    const file = attemptRecordPath(runDirectory());
    writeFileSync(file, "{", "utf8");
    try {
      writeAttemptRecordAtomically(file, record);
    } catch {}

    expect(readFileSync(file, "utf8")).toBe("{");
  });

  it("rejects a report with an invalid V1 base field", () => {
    const record = preparedAttempt();

    expect(() => validateCompletionReportBinding(record, { ...matchingReport(), status: "unknown" })).toThrow("status");
  });

  it("validates a V1 writer report against the persisted attempt record", () => {
    const runDir = runDirectory();
    preparedAttempt(runDir);

    expect(validateCompletionReportBinding(readAttemptRecord(runDir), matchingReport())).toBeUndefined();
  });

  it("writes valid JSON to the durable attempt path", () => {
    const record = preparedAttempt();

    expect(JSON.parse(readFileSync(attemptRecordPath(path.dirname(record.promptFile)), "utf8"))).toEqual(record);
  });
});
