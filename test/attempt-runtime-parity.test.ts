import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateCompletionPersistence } from "../src/attempt-workspace-lifecycle";
import { branchUpdateFixture, repairFixture, reviewerFixture, workerFixture } from "./fixtures/attempt-workspace";
const runtime = require("../src/attempt-workspace-predicates.cjs");
const lifecycleRuntime = require("../src/attempt-lifecycle-runtime.cjs");
import { readAttemptRecord, transitionAttempt, validateCompletionReportBinding } from "../src/attempt-lifecycle";

const fixtures = [workerFixture(), reviewerFixture("approved"), reviewerFixture("changes_requested"), repairFixture(), repairFixture("stale_head"), branchUpdateFixture(), branchUpdateFixture("stale_head")];

describe("direct Node runtime parity", () => {
  it.each(fixtures.map((fixture, index) => [index, fixture] as const))("matches the typed completion predicate for fixture %s", (_index, fixture) => {
    const input = { record: fixture.record, report: { kind: "v1" as const, promisePath: fixture.record.promiseFile, report: fixture.report }, github: fixture.github, context: "context" in fixture ? fixture.context : {} };
    expect(runtime.evaluateCompletionPersistence(input)).toEqual(evaluateCompletionPersistence(input));
  });

  const successfulPhases = ["prepared", "github_claimed", "workspace_opened", "agent_started", "report_received", "github_persisted", "workspace_closed"] as const;
  const transitionCases = successfulPhases.flatMap((from) => [...successfulPhases, "launch_failed" as const].map((to) => [from, to] as const));
  it.each(transitionCases)("matches the typed transition result from %s to %s", (from, to) => {
    const fixture = workerFixture().record;
    const record = {
      ...fixture,
      phase: from,
      lastSuccessfulPhase: from,
      ...(from === "prepared" || from === "github_claimed" ? { workspaceId: undefined, tabId: undefined, rootPaneId: undefined } : {}),
      ...(from === "prepared" || from === "github_claimed" || from === "workspace_opened" || from === "agent_started" ? { outputRevision: undefined } : {}),
    };
    const outcome = (operation: () => unknown) => { try { return { value: operation() }; } catch (error) { return { error: String(error).replace(/^Error: /, "") }; } };
    expect(outcome(() => lifecycleRuntime.transitionAttempt(record, to, to === "launch_failed" ? "failed" : undefined))).toEqual(
      outcome(() => transitionAttempt(record, to, to === "launch_failed" ? "failed" : undefined)),
    );
  });

  it.each([
    ["missing report", (input: any) => ({ ...input, report: { kind: "missing" } })],
    ["legacy report", (input: any) => ({ ...input, report: { kind: "legacy", promisePath: input.record.promiseFile, report: {} } })],
    ["malformed report", (input: any) => ({ ...input, report: { ...input.report, report: { schemaVersion: 1 } } })],
    ["blocked evidence", (input: any) => ({ ...input, report: { ...input.report, report: { ...input.report.report, status: "blocked", result: { reason: "stop", explanation: "blocked" }, evidence: [] } } })],
    ["attempt identity", (input: any) => ({ ...input, report: { ...input.report, report: { ...input.report.report, attemptId: "other" } } })],
    ["repository identity", (input: any) => ({ ...input, report: { ...input.report, report: { ...input.report.report, target: { ...input.report.report.target, repository: "other/repo" } } } })],
    ["target identity", (input: any) => ({ ...input, report: { ...input.report, report: { ...input.report.report, target: { ...input.report.report.target, number: 99 } } } })],
    ["revision identity", (input: any) => ({ ...input, report: { ...input.report, report: { ...input.report.report, inputRevision: { ...input.report.report.inputRevision, head: "f".repeat(40) } } } })],
    ["role identity", (input: any) => ({ ...input, report: { ...input.report, report: { ...input.report.report, role: "reviewer" } } })],
    ["role evidence", (input: any) => ({ ...input, report: { ...input.report, report: { ...input.report.report, evidence: { validations: [] } } } })],
    ["mismatched report path", (input: any) => ({ ...input, report: { ...input.report, promisePath: "/other/promise.json" } })],
    ["uncertain GitHub state", (input: any) => ({ ...input, github: { kind: "uncertain", reason: "timeout", detail: "timeout" } })],
    ["missing persistence marker", (input: any) => ({ ...input, github: { ...input.github, pullRequests: input.github.pullRequests.map((pr: any) => ({ ...pr, marker: undefined })) } })],
    ["wrong target kind", (input: any) => ({ ...input, record: { ...input.record, target: { ...input.record.target, kind: "pull-request" } } })],
  ] as const)("matches typed preservation for %s", (_name, mutate) => {
    const fixture = workerFixture();
    const input = { record: fixture.record, report: { kind: "v1" as const, promisePath: fixture.record.promiseFile, report: fixture.report }, github: fixture.github };
    const changed = mutate(input);
    expect(runtime.evaluateCompletionPersistence(changed)).toEqual(evaluateCompletionPersistence(changed));
  });

  it.each(fixtures.map((fixture, index) => [index, fixture] as const))("matches typed V1 completion binding for fixture %s", (_index, fixture) => {
    expect(lifecycleRuntime.validateCompletionReportBinding(fixture.record, fixture.report)).toEqual(
      validateCompletionReportBinding(fixture.record, fixture.report),
    );
  });

  it("accepts the built-in required-verification source in both parsers", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-attempt-parity-"));
    try {
      const fixture = workerFixture().record;
      const record = { ...fixture, requiredVerification: { ...fixture.requiredVerification!, source: { kind: "default" as const, location: "deadloop" } } };
      writeFileSync(path.join(root, "attempt.json"), JSON.stringify(record));
      expect(lifecycleRuntime.readAttemptRecord(root)).toEqual(readAttemptRecord(root));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("normalizes unknown record fields identically to the typed parser", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-attempt-parity-"));
    try {
      const record = { ...workerFixture().record, unknown: "drop", target: { ...workerFixture().record.target, unknown: true }, inputRevision: { ...workerFixture().record.inputRevision, unknown: true } };
      writeFileSync(path.join(root, "attempt.json"), JSON.stringify(record));
      expect(lifecycleRuntime.readAttemptRecord(root)).toEqual(readAttemptRecord(root));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(successfulPhases)("normalizes the complete %s phase fixture identically", (phase) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-attempt-parity-"));
    try {
      const record = { ...workerFixture().record, phase, lastSuccessfulPhase: phase };
      writeFileSync(path.join(root, "attempt.json"), JSON.stringify(record));
      expect(lifecycleRuntime.readAttemptRecord(root)).toEqual(readAttemptRecord(root));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("normalizes the launch_failed phase fixture identically", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-attempt-parity-"));
    try {
      const record = { ...workerFixture().record, phase: "launch_failed", lastSuccessfulPhase: "agent_started", launchError: "failed" };
      writeFileSync(path.join(root, "attempt.json"), JSON.stringify(record));
      expect(lifecycleRuntime.readAttemptRecord(root)).toEqual(readAttemptRecord(root));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ["array record", []],
    ["invalid target", { ...workerFixture().record, target: { kind: "issue", number: 0 } }],
    ["short output revision", { ...workerFixture().record, outputRevision: "abc" }],
    ["successful phase mismatch", { ...workerFixture().record, phase: "report_received", lastSuccessfulPhase: "agent_started" }],
  ] as const)("matches typed rejection for malformed %s fixture", (_name, record) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-attempt-parity-"));
    try {
      writeFileSync(path.join(root, "attempt.json"), JSON.stringify(record));
      const rejected = (operation: () => unknown) => { try { operation(); return false; } catch { return true; } };
      expect(rejected(() => lifecycleRuntime.readAttemptRecord(root))).toBe(rejected(() => readAttemptRecord(root)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ["attempt identity", (report: any) => ({ ...report, attemptId: "other" })],
    ["target identity", (report: any) => ({ ...report, target: { ...report.target, number: 99 } })],
    ["input revision", (report: any) => ({ ...report, inputRevision: { ...report.inputRevision, head: "f".repeat(40) } })],
    ["worker evidence", (report: any) => ({ ...report, evidence: { validations: [] } })],
  ] as const)("rejects the same malformed %s binding as typed validation", (_name, mutate) => {
    const fixture = workerFixture();
    const rejected = (operation: () => unknown) => { try { operation(); return false; } catch { return true; } };
    expect(rejected(() => lifecycleRuntime.validateCompletionReportBinding(fixture.record, mutate(fixture.report)))).toBe(
      rejected(() => validateCompletionReportBinding(fixture.record, mutate(fixture.report))),
    );
  });
});
