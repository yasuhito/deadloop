import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AttemptRecord,
  validateCompletionReportBinding,
  validateCompletionReportV1,
} from "../src/attempt-lifecycle";

const { validatePromise } = require("../extensions/deadloop/automations/extract-worker-promise.ts");

const head = "a".repeat(40);
const base = "b".repeat(40);
const output = "c".repeat(40);

function acceptedByLifecycle(report: unknown): boolean {
  try {
    validateCompletionReportV1(report);
    return true;
  } catch {
    return false;
  }
}

function acceptedByExecutable(report: unknown): boolean {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-validator-parity-"));
  const file = path.join(root, "promise.json");
  try {
    writeFileSync(file, JSON.stringify(report));
    return ["complete", "blocked"].includes(validatePromise(file).status);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const common = {
  schemaVersion: 1,
  attemptId: "attempt",
  target: { repository: "octo/demo", kind: "pull-request", number: 1 },
  inputRevision: { head },
  status: "complete",
  summary: "done",
};

const cases: Array<[string, unknown]> = [
  ["valid reviewer", {
    ...common,
    role: "reviewer",
    result: { outcome: "changes_requested", reviewedHead: head, requiredFindings: [{ title: "Bug", body: "Fix it", severity: "major" }], advisoryObservations: [], priorFindingDisposition: { status: "none", summary: "No prior required findings." }, repairProgress: "initial_required_findings" },
    evidence: { reviewed: ["diff"] },
  }],
  ["reviewer finding without severity", {
    ...common,
    role: "reviewer",
    result: { outcome: "changes_requested", reviewedHead: head, requiredFindings: [{ title: "Bug", body: "Fix it" }], advisoryObservations: [], priorFindingDisposition: { status: "none", summary: "No prior required findings." }, repairProgress: "initial_required_findings" },
    evidence: { reviewed: ["diff"] },
  }],
  ["valid stale repair", {
    ...common,
    role: "review-repair",
    result: { outcome: "stale_head", outputRevision: output },
    evidence: { finalizer: { action: "stale_head", reason: "head_sha_changed", originalHeadOid: head, currentRemoteHeadOid: output } },
  }],
  ["stale repair whose output still matches its input", {
    ...common,
    role: "review-repair",
    result: { outcome: "stale_head", outputRevision: head },
    evidence: { finalizer: { action: "stale_head", reason: "head_sha_changed", originalHeadOid: head, currentRemoteHeadOid: head } },
  }],
  ["valid pushed branch update", {
    ...common,
    role: "branch-update",
    inputRevision: { head, base },
    result: { outcome: "branch_update_pushed", outputRevision: output },
    evidence: {
      finalizer: { action: "pushed", reason: "branch_update_pushed", originalHeadOid: head, baseHeadOid: base, headOid: output, checks: [{ command: "npm test", result: "passed" }] },
      validations: [{ command: "npm test", result: "passed" }],
    },
  }],
  ["pushed branch update whose output still matches its input", {
    ...common,
    role: "branch-update",
    inputRevision: { head, base },
    result: { outcome: "branch_update_pushed", outputRevision: head },
    evidence: {
      finalizer: { action: "pushed", reason: "branch_update_pushed", originalHeadOid: head, baseHeadOid: base, headOid: head, checks: [{ command: "npm test", result: "passed" }] },
      validations: [{ command: "npm test", result: "passed" }],
    },
  }],
  ["retired branch outcome", {
    ...common,
    role: "branch-update",
    inputRevision: { head, base },
    result: { outcome: "branch_updated", outputRevision: output },
    evidence: { finalizer: {} },
  }],
  ["typed blocked result without guidance", {
    ...common,
    role: "worker",
    status: "blocked",
    result: { reason: "unsafe", explanation: "cannot continue" },
    evidence: {},
  }],
  ["valid blocked result with object evidence", {
    ...common,
    role: "worker",
    status: "blocked",
    result: { reason: "unsafe", explanation: "cannot continue", recovery: "inspect" },
    evidence: {},
  }],
  ["blocked result with array evidence", {
    ...common,
    role: "worker",
    status: "blocked",
    result: { reason: "unsafe", explanation: "cannot continue", recovery: "inspect" },
    evidence: [],
  }],
  ["whitespace-only attempt identity", {
    ...common,
    attemptId: "   ",
    role: "reviewer",
    result: { outcome: "approved", reviewedHead: head, requiredFindings: [], advisoryObservations: [], priorFindingDisposition: { status: "none", summary: "No prior required findings." } },
    evidence: { reviewed: ["diff"] },
  }],
  ["symbolic input revision", {
    ...common,
    role: "reviewer",
    inputRevision: { head: "origin/main" },
    result: { outcome: "approved", reviewedHead: "origin/main", requiredFindings: [], advisoryObservations: [], priorFindingDisposition: { status: "none", summary: "No prior required findings." } },
    evidence: { reviewed: ["diff"] },
  }],
  ["case-insensitive reviewed SHA", {
    ...common,
    role: "reviewer",
    inputRevision: { head: head.toUpperCase() },
    result: { outcome: "approved", reviewedHead: head, requiredFindings: [], advisoryObservations: [], priorFindingDisposition: { status: "none", summary: "No prior required findings." } },
    evidence: { reviewed: ["diff"] },
  }],
  ["symbolic Worker output revision", {
    ...common,
    role: "worker",
    target: { repository: "octo/demo", kind: "issue", number: 1 },
    result: { outputRevision: "output" },
    evidence: { validations: ["npm test passed"] },
  }],
  ["symbolic reviewed revision", {
    ...common,
    role: "reviewer",
    result: { outcome: "approved", reviewedHead: "HEAD", requiredFindings: [], advisoryObservations: [], priorFindingDisposition: { status: "none", summary: "No prior required findings." } },
    evidence: { reviewed: ["diff"] },
  }],
  ["symbolic stale finalizer revision", {
    ...common,
    role: "review-repair",
    result: { outcome: "stale_head", outputRevision: output },
    evidence: { finalizer: { action: "stale_head", reason: "head_sha_changed", originalHeadOid: head, currentRemoteHeadOid: "origin/main" } },
  }],
];

describe("V1 validator parity", () => {
  it.each(cases)("keeps lifecycle and executable validation aligned for %s", (_name, report) => {
    expect(acceptedByExecutable(report)).toBe(acceptedByLifecycle(report));
  });
});

const pushedNoops: Array<[string, unknown]> = [
  ["review-repair", {
    ...common,
    role: "review-repair",
    result: {
      outcome: "repair_pushed",
      outputRevision: head,
      repairs: [{ title: "Bug", summary: "Fixed it", paths: ["src/a.ts"] }],
    },
    evidence: {
      finalizer: { action: "pushed", reason: "repair_pushed", originalHeadOid: head, headOid: head, checks: [{ command: "npm test", result: "passed" }] },
      validations: [{ command: "npm test", result: "passed" }],
    },
  }],
  ["branch-update", {
    ...common,
    role: "branch-update",
    inputRevision: { head, base },
    result: { outcome: "branch_update_pushed", outputRevision: head },
    evidence: {
      finalizer: { action: "pushed", reason: "branch_update_pushed", originalHeadOid: head, baseHeadOid: base, headOid: head, checks: [{ command: "npm test", result: "passed" }] },
      validations: [{ command: "npm test", result: "passed" }],
    },
  }],
];

describe("pushed V1 output revisions", () => {
  it.each(pushedNoops)("rejects a no-op %s report through the lifecycle validator", (_role, report) => {
    expect(acceptedByLifecycle(report)).toBe(false);
  });

  it.each(pushedNoops)("rejects a no-op %s report through the executable validator", (_role, report) => {
    expect(acceptedByExecutable(report)).toBe(false);
  });
});

function bindingReport() {
  return {
    schemaVersion: 1 as const,
    attemptId: "attempt",
    role: "worker" as const,
    target: { repository: "octo/demo", kind: "issue" as const, number: 1 },
    inputRevision: { head },
    status: "complete" as const,
    summary: "done",
    result: { outputRevision: output },
    evidence: { validations: ["npm test passed"] },
  };
}

function canonicalRecord(promiseFile: string): AttemptRecord {
  return {
    attemptId: "attempt",
    launchUuid: "launch-001",
    project: "demo",
    repository: "octo/demo",
    role: "worker",
    target: { kind: "issue", number: 1 },
    inputRevision: { head },
    branch: "agent/issue-1",
    baseBranch: "main",
    worktreePath: "/worktrees/issue-1",
    agentName: "dl-w-1-123456789abc",
    workspaceLabel: "Issue #1",
    promptFile: path.join(path.dirname(promiseFile), "worker-prompt.md"),
    promiseFile,
    phase: "agent_started",
    lastSuccessfulPhase: "agent_started",
  };
}

function acceptedBindingByLifecycle(record: AttemptRecord): boolean {
  try {
    validateCompletionReportBinding(record, bindingReport());
    return true;
  } catch {
    return false;
  }
}

function promotedByExecutable(mutate: (record: AttemptRecord) => AttemptRecord): boolean {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-binding-parity-"));
  const file = path.join(root, "promise.json");
  try {
    const record = mutate(canonicalRecord(file));
    writeFileSync(file, JSON.stringify(bindingReport()));
    writeFileSync(path.join(root, "attempt.json"), JSON.stringify(record));
    return validatePromise(file).evidenceStrength === "strong";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const bindingCases: Array<[string, (record: AttemptRecord) => AttemptRecord]> = [
  ["canonical record", (record) => record],
  ["partial record", (record) => ({ ...record, launchUuid: undefined } as unknown as AttemptRecord)],
  ["invalid phase relationship", (record) => ({ ...record, lastSuccessfulPhase: "prepared" })],
  ["whitespace identity", (record) => ({ ...record, project: "   " })],
  ["symbolic recorded output revision", (record) => ({ ...record, outputRevision: "HEAD" })],
];

describe("AttemptRecord validator parity", () => {
  it.each(bindingCases)("keeps lifecycle and executable promotion aligned for %s", (_name, mutate) => {
    const lifecycleRecord = mutate(canonicalRecord("/runs/attempt/promise.json"));

    expect(promotedByExecutable(mutate)).toBe(acceptedBindingByLifecycle(lifecycleRecord));
  });
});
