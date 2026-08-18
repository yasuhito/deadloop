import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { provenPushedHeadTransition } = require("../extensions/deadloop/automations/pushed-head-proof.ts");

const originalHead = "a".repeat(40);
const pushedHead = "b".repeat(40);
const baseHead = "c".repeat(40);
const checks = [{ command: "npm run check", result: "passed" }];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    action: "pushed", reason: "branch_update_pushed", originalHeadOid: originalHead,
    baseHeadOid: baseHead, headOid: pushedHead, checks, ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    attemptId: "branch-update-31",
    role: "branch-update",
    status: "complete",
    target: { kind: "pull-request", number: 31, repository: "owner/repo" },
    inputRevision: { head: originalHead, base: baseHead },
    summary: "merged the base head into the PR branch",
    result: { outcome: "branch_update_pushed", outputRevision: pushedHead },
    evidence: { finalizer: receipt(), validations: checks },
    ...overrides,
  };
}

type RunParts = {
  receipt?: Record<string, unknown> | null;
  report?: Record<string, unknown> | null;
  journal?: Record<string, unknown> | null;
};

function attemptRun(parts: RunParts = {}) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-pushed-head-"));
  roots.push(runDir);
  const record = {
    attemptId: "branch-update-31", launchUuid: "launch-31", project: "demo", repository: "owner/repo",
    role: "branch-update", target: { kind: "pull-request", number: 31 },
    inputRevision: { head: originalHead, base: baseHead }, branch: "agent/issue-31",
    worktreePath: runDir, agentName: "dl-b-31-abcdef123456", workspaceLabel: "branch-update",
    promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"),
    phase: "agent_started", lastSuccessfulPhase: "agent_started",
  };
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value));
  if (parts.journal !== null) write("attempt.json", { ...record, ...parts.journal });
  if (parts.report !== null) write("promise.json", parts.report ?? report());
  if (parts.receipt !== null) write("finalizer-result.json", parts.receipt ?? receipt());
  return { runDir, record };
}

describe("proven pushed head transition", () => {
  it("proves the transition the receipt and the bound report agree on", () => {
    const { runDir, record } = attemptRun();

    expect(provenPushedHeadTransition(runDir, record)).toEqual({ originalHeadOid: originalHead, headOid: pushedHead });
  });

  it("proves nothing when the finalizer left no receipt", () => {
    const { runDir, record } = attemptRun({ receipt: null });

    expect(provenPushedHeadTransition(runDir, record)).toBeNull();
  });

  it("proves nothing when the receipt records no push", () => {
    const { runDir, record } = attemptRun({
      receipt: receipt({ action: "stale_head", reason: "head_sha_changed", currentRemoteHeadOid: pushedHead }),
    });

    expect(provenPushedHeadTransition(runDir, record)).toBeNull();
  });

  it("proves nothing when the receipt starts from a head the attempt did not launch on", () => {
    const { runDir, record } = attemptRun({ receipt: receipt({ originalHeadOid: "d".repeat(40) }) });

    expect(provenPushedHeadTransition(runDir, record)).toBeNull();
  });

  it("proves nothing when the report names a head the receipt did not push", () => {
    const { runDir, record } = attemptRun({
      report: report({ result: { outcome: "branch_update_pushed", outputRevision: "d".repeat(40) } }),
    });

    expect(provenPushedHeadTransition(runDir, record)).toBeNull();
  });

  it("proves nothing when the receipt names another role's push", () => {
    const { runDir, record } = attemptRun({ receipt: receipt({ reason: "repair_pushed" }) });

    expect(provenPushedHeadTransition(runDir, record)).toBeNull();
  });

  it("proves nothing from a report no attempt journal binds", () => {
    const { runDir, record } = attemptRun({ journal: null });

    expect(provenPushedHeadTransition(runDir, record)).toBeNull();
  });

  it("proves nothing from a report bound to another attempt", () => {
    const { runDir, record } = attemptRun({ report: report({ attemptId: "someone-else" }) });

    expect(provenPushedHeadTransition(runDir, record)).toBeNull();
  });

  it("proves nothing from a blocked report", () => {
    const { runDir, record } = attemptRun({
      report: report({
        status: "blocked",
        result: { reason: "merge_conflict", explanation: "unresolved", recovery: "resolve by hand" },
      }),
    });

    expect(provenPushedHeadTransition(runDir, record)).toBeNull();
  });

  it("proves nothing when the completion report is missing", () => {
    const { runDir, record } = attemptRun({ report: null });

    expect(provenPushedHeadTransition(runDir, record)).toBeNull();
  });
});
