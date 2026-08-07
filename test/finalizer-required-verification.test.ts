import { describe, expect, it } from "vitest";

const {
  ensureRequiredVerificationRecord,
} = require("../extensions/deadloop/automations/finalizer-required-verification.ts");

const contract = {
  repository: "owner/repo",
  command: "npm test",
  source: { kind: "repo_policy", location: "deadloop.json" },
  baseRevision: "a".repeat(40),
};
const candidate = "b".repeat(40);

function attempt(role: "review-repair" | "branch-update") {
  return { role, repository: "owner/repo", requiredVerification: contract };
}

function passedRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    binding: { ...contract, targetCommit: candidate },
    outcome: "passed",
    exitCode: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1,
    logPath: "/state/check.log",
    provenance: { kind: "host_gate_execution", recordPath: "/state/evidence.json" },
    ...overrides,
  };
}

for (const role of ["review-repair", "branch-update"] as const) {
  describe(`${role} required-verification conformance`, () => {
    it("runs required verification when the success record is missing", () => {
      let executions = 0;
      ensureRequiredVerificationRecord(
        { attempt: attempt(role), currentContract: contract, targetCommit: candidate, record: undefined },
        {
          execute: () => { executions += 1; return passedRecord(); },
          persist: (record: unknown) => record,
          authenticate: () => {},
        },
      );

      expect(executions).toBe(1);
    });

    it("does not accept command-and-result legacy evidence", () => {
      let executions = 0;
      ensureRequiredVerificationRecord(
        { attempt: attempt(role), currentContract: contract, targetCommit: candidate, record: { command: "npm test", result: "passed" } },
        {
          execute: () => { executions += 1; return passedRecord(); },
          persist: (record: unknown) => record,
          authenticate: () => {},
        },
      );

      expect(executions).toBe(1);
    });

    it("reuses an exact authenticated success record", () => {
      let executions = 0;
      ensureRequiredVerificationRecord(
        { attempt: attempt(role), currentContract: contract, targetCommit: candidate, record: passedRecord() },
        {
          execute: () => { executions += 1; return passedRecord(); },
          persist: (record: unknown) => record,
          authenticate: () => {},
        },
      );

      expect(executions).toBe(0);
    });

    it("reruns verification when exact-looking evidence is not authenticated", () => {
      let executions = 0;
      let authentications = 0;
      ensureRequiredVerificationRecord(
        { attempt: attempt(role), currentContract: contract, targetCommit: candidate, record: passedRecord() },
        {
          execute: () => { executions += 1; return passedRecord(); },
          persist: (record: unknown) => record,
          authenticate: () => { authentications += 1; if (authentications === 1) throw new Error("unauthenticated"); },
        },
      );

      expect(executions).toBe(1);
    });

    it("reruns verification when the target commit changes", () => {
      let executions = 0;
      ensureRequiredVerificationRecord(
        { attempt: attempt(role), currentContract: contract, targetCommit: "c".repeat(40), record: passedRecord() },
        {
          execute: () => { executions += 1; return passedRecord({ binding: { ...contract, targetCommit: "c".repeat(40) } }); },
          persist: (record: unknown) => record,
          authenticate: () => {},
        },
      );

      expect(executions).toBe(1);
    });

    it("reruns verification when the record source changes", () => {
      let executions = 0;
      ensureRequiredVerificationRecord(
        { attempt: attempt(role), currentContract: contract, targetCommit: candidate, record: passedRecord({ binding: { ...contract, source: { kind: "local", location: "/tmp/projects.json#project=demo" }, targetCommit: candidate } }) },
        {
          execute: () => { executions += 1; return passedRecord(); },
          persist: (record: unknown) => record,
          authenticate: () => {},
        },
      );

      expect(executions).toBe(1);
    });

    it("reruns verification when the record base revision changes", () => {
      let executions = 0;
      ensureRequiredVerificationRecord(
        { attempt: attempt(role), currentContract: contract, targetCommit: candidate, record: passedRecord({ binding: { ...contract, baseRevision: "d".repeat(40), targetCommit: candidate } }) },
        {
          execute: () => { executions += 1; return passedRecord(); },
          persist: (record: unknown) => record,
          authenticate: () => {},
        },
      );

      expect(executions).toBe(1);
    });
  });
}
