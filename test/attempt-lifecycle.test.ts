import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  abandonPersistedAttempt,
  attemptRecordPath,
  createPreparedAttempt,
  readAttemptRecord,
  releasePersistedAttemptAuthority,
  transitionAttempt,
  transitionPersistedAttempt,
  validateCompletionReportBinding,
  validateCompletionReportV1,
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
    result: { outcome: "approved", reviewedHead: "a".repeat(40), findings: [] },
    evidence: { reviewed: ["PR diff"] },
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

  it("rejects skipping the guarded GitHub claim phase", () => {
    const record = preparedAttempt();

    expect(() => transitionAttempt(record, "workspace_opened")).toThrow("cannot transition");
  });

  it("rejects a lifecycle phase which does not advance", () => {
    const record = transitionAttempt(preparedAttempt(), "github_claimed");

    expect(() => transitionAttempt(record, "prepared")).toThrow("cannot transition");
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

  it("abandons a launch-failed attempt while preserving its failure evidence", () => {
    const runDir = runDirectory();
    preparedAttempt(runDir);
    const claimed = transitionPersistedAttempt(runDir, "github_claimed");
    writeAttemptRecordAtomically(attemptRecordPath(runDir), {
      ...claimed,
      workspaceId: "workspace-1",
      tabId: "tab-1",
      rootPaneId: "pane-1",
      phase: "workspace_opened",
      lastSuccessfulPhase: "workspace_opened",
    });
    transitionPersistedAttempt(runDir, "launch_failed", "agent start failed");

    const record = abandonPersistedAttempt(runDir, "2026-07-24T00:00:00.000Z");

    expect({ phase: record.phase, launchError: record.launchError, abandonment: record.abandonment }).toEqual({
      phase: "abandoned",
      launchError: "agent start failed",
      abandonment: { reason: "launch_failed_no_agent", abandonedAt: "2026-07-24T00:00:00.000Z" },
    });
  });

  it("refuses to abandon a launch failure before the workspace-opened boundary", () => {
    const runDir = runDirectory();
    preparedAttempt(runDir);
    transitionPersistedAttempt(runDir, "github_claimed");
    transitionPersistedAttempt(runDir, "launch_failed", "claim failed");

    expect(() => abandonPersistedAttempt(runDir, "2026-07-24T00:00:00.000Z")).toThrow("workspace_opened");
  });

  it("refuses to abandon an attempt that did not fail during launch", () => {
    const runDir = runDirectory();
    preparedAttempt(runDir);

    expect(() => abandonPersistedAttempt(runDir, "2026-07-24T00:00:00.000Z")).toThrow("launch_failed");
  });

  it("recovers the complete current record when an interrupted replacement leaves a temporary file", () => {
    const runDir = runDirectory();
    const record = preparedAttempt(runDir);
    writeFileSync(`${attemptRecordPath(runDir)}.tmp`, "{", "utf8");

    expect(readAttemptRecord(runDir)).toEqual(record);
  });

  it("refuses a temporary record whose replacement never committed", () => {
    const runDir = runDirectory();
    const record = preparedAttempt(runDir);
    rmSync(attemptRecordPath(runDir));
    writeFileSync(`${attemptRecordPath(runDir)}.tmp`, `${JSON.stringify(record)}\n`, "utf8");

    expect(() => readAttemptRecord(runDir)).toThrow("Attempt record is missing");
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

    expect(validateCompletionReportBinding(readAttemptRecord(runDir), matchingReport()).strength).toBe("strong");
  });

  it("rejects a reviewer report without exact reviewed head", () => {
    const record = preparedAttempt();

    expect(() => validateCompletionReportBinding(record, { ...matchingReport(), result: { outcome: "approved" } })).toThrow(
      "reviewedHead",
    );
  });

  it("rejects a blocked report without recovery guidance", () => {
    const record = preparedAttempt();

    expect(() =>
      validateCompletionReportBinding(record, { ...matchingReport(), status: "blocked", result: { reason: "network", explanation: "offline" } }),
    ).toThrow("recovery or informationRequest");
  });

  it("rejects empty blocked recovery guidance", () => {
    const record = preparedAttempt();

    expect(() =>
      validateCompletionReportBinding(record, {
        ...matchingReport(), status: "blocked", result: { reason: "network", explanation: "offline", recovery: "" },
      }),
    ).toThrow("recovery or informationRequest");
  });

  it("rejects malformed structured reviewer findings", () => {
    const report = matchingReport();

    expect(() => validateCompletionReportV1({
      ...report,
      result: { ...report.result, outcome: "changes_requested", findings: [{ title: "Bug", body: "", severity: "major" }] },
    })).toThrow("finding");
  });

  it("requires severity on every changes-requested finding", () => {
    const report = matchingReport();

    expect(() => validateCompletionReportV1({
      ...report,
      result: { ...report.result, outcome: "changes_requested", findings: [{ title: "Bug", body: "Fix it" }] },
    })).toThrow("severity");
  });

  it("rejects malformed Worker validation evidence", () => {
    expect(() => validateCompletionReportV1({
      ...matchingReport(),
      role: "worker",
      target: { repository: "octo/demo", kind: "issue", number: 42 },
      result: { outputRevision: "c".repeat(40) },
      evidence: { validations: [""] },
    })).toThrow("validation evidence");
  });

  it("rejects malformed reviewer evidence", () => {
    expect(() => validateCompletionReportV1({
      ...matchingReport(),
      evidence: { reviewed: [""] },
    })).toThrow("review evidence");
  });

  it("accepts a receipt-bound repair-pushed result", () => {
    const inputHead = "a".repeat(40);
    const outputHead = "c".repeat(40);

    expect(validateCompletionReportV1({
      ...matchingReport(),
      role: "review-repair",
      inputRevision: { head: inputHead },
      result: {
        outcome: "repair_pushed",
        outputRevision: outputHead,
        repairs: [{ title: "Bug", summary: "Fixed it", paths: ["src/a.ts"] }],
      },
      evidence: {
        finalizer: {
          action: "pushed",
          reason: "repair_pushed",
          originalHeadOid: inputHead,
          headOid: outputHead,
          checks: [{ command: "npm test", result: "passed" }],
        },
        validations: [{ command: "npm test", result: "passed" }],
      },
    }).result).toMatchObject({ outcome: "repair_pushed", outputRevision: outputHead });
  });

  it("requires stale repair outputRevision", () => {
    const inputHead = "a".repeat(40);

    expect(() => validateCompletionReportV1({
      ...matchingReport(),
      role: "review-repair",
      inputRevision: { head: inputHead },
      result: { outcome: "stale_head" },
      evidence: {
        finalizer: { action: "stale_head", reason: "head_sha_changed", originalHeadOid: inputHead, currentRemoteHeadOid: "d".repeat(40) },
      },
    })).toThrow("outputRevision");
  });

  it("requires repair outputRevision to match the stale finalizer receipt", () => {
    const inputHead = "a".repeat(40);

    expect(() => validateCompletionReportV1({
      ...matchingReport(),
      role: "review-repair",
      inputRevision: { head: inputHead },
      result: { outcome: "stale_head", outputRevision: "d".repeat(40) },
      evidence: {
        finalizer: { action: "stale_head", reason: "head_sha_changed", originalHeadOid: inputHead, currentRemoteHeadOid: "e".repeat(40) },
      },
    })).toThrow("current remote head");
  });

  it("accepts a receipt-bound branch update result", () => {
    const inputHead = "a".repeat(40);
    const baseHead = "b".repeat(40);
    const outputHead = "c".repeat(40);

    expect(validateCompletionReportV1({
      ...matchingReport(),
      role: "branch-update",
      inputRevision: { head: inputHead, base: baseHead },
      result: { outcome: "branch_update_pushed", outputRevision: outputHead },
      evidence: {
        finalizer: {
          action: "pushed",
          reason: "branch_update_pushed",
          originalHeadOid: inputHead,
          baseHeadOid: baseHead,
          headOid: outputHead,
          checks: [{ command: "npm test", result: "passed" }],
        },
        validations: [{ command: "npm test", result: "passed" }],
      },
    }).result).toMatchObject({ outcome: "branch_update_pushed", outputRevision: outputHead });
  });

  it("rejects the retired branch_updated outcome", () => {
    expect(() => validateCompletionReportV1({
      ...matchingReport(),
      role: "branch-update",
      result: { outcome: "branch_updated", outputRevision: "c".repeat(40) },
      evidence: { finalizer: {} },
    })).toThrow("outcome");
  });

  it("rejects a non-SHA input revision", () => {
    expect(() => validateCompletionReportV1({
      ...matchingReport(),
      inputRevision: { head: "not-a-commit" },
      result: { ...matchingReport().result, reviewedHead: "not-a-commit" },
    })).toThrow("40-hex");
  });

  it("rejects a non-SHA Worker output revision", () => {
    expect(() => validateCompletionReportV1({
      ...matchingReport(),
      role: "worker",
      target: { repository: "octo/demo", kind: "issue", number: 42 },
      result: { outputRevision: "not-a-commit" },
      evidence: { validations: ["npm test passed"] },
    })).toThrow("outputRevision");
  });

  it("accepts case-insensitive SHA equality", () => {
    const upperHead = "a".repeat(40).toUpperCase();

    expect(validateCompletionReportV1({
      ...matchingReport(),
      inputRevision: { head: upperHead, base: "b".repeat(40).toUpperCase() },
      result: { ...matchingReport().result, reviewedHead: "a".repeat(40) },
    }).status).toBe("complete");
  });

  it("requires blocked evidence to be an object", () => {
    expect(() => validateCompletionReportV1({
      ...matchingReport(),
      status: "blocked",
      result: { reason: "unsafe", explanation: "cannot continue", recovery: "inspect" },
      evidence: [],
    })).toThrow("evidence");
  });

  it.each([
    ["attemptId", { attemptId: "   " }],
    ["repository", { target: { ...matchingReport().target, repository: "   " } }],
  ])("rejects whitespace-only %s", (_name, replacement) => {
    expect(() => validateCompletionReportV1({ ...matchingReport(), ...replacement })).toThrow("non-empty string");
  });

  it("rejects whitespace-only canonical attempt-record identity", () => {
    const record = { ...preparedAttempt(), project: "   " };

    expect(() => validateCompletionReportBinding(record, matchingReport())).toThrow("project");
  });

  it("writes valid JSON to the durable attempt path", () => {
    const record = preparedAttempt();

    expect(JSON.parse(readFileSync(attemptRecordPath(path.dirname(record.promptFile)), "utf8"))).toEqual(record);
  });

  it("releases local ownership after GitHub authority is lost", () => {
    const record = preparedAttempt();

    expect(releasePersistedAttemptAuthority(path.dirname(record.promptFile), "2026-08-01T10:00:00Z", "cutoff-1").phase).toBe("authority_released");
  });
});
