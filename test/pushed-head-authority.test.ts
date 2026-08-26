import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { pushedHeadTransition } = require("../extensions/deadloop/automations/reconcile-pr-work-authority.cts");

const originalHead = "a".repeat(40);
const pushedHead = "b".repeat(40);
const baseHead = "c".repeat(40);
const checks = [{ command: "npm run check", result: "passed" }];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** An attempt whose finalizer receipt and bound report both prove it pushed `pushedHead`. */
function provenAttempt() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-pushed-head-authority-"));
  roots.push(runDir);
  const finalizer = {
    action: "pushed", reason: "branch_update_pushed", originalHeadOid: originalHead,
    baseHeadOid: baseHead, headOid: pushedHead, checks,
  };
  const record = {
    attemptId: "branch-update-31", launchUuid: "launch-31", project: "demo", repository: "owner/repo",
    role: "branch-update", target: { kind: "pull-request", number: 31 },
    inputRevision: { head: originalHead, base: baseHead }, branch: "agent/issue-31",
    worktreePath: runDir, agentName: "dl-b-31-abcdef123456", workspaceLabel: "branch-update",
    promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"),
    phase: "agent_started", lastSuccessfulPhase: "agent_started",
  };
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value));
  write("attempt.json", record);
  write("finalizer-result.json", finalizer);
  write("promise.json", {
    schemaVersion: 1,
    attemptId: record.attemptId,
    role: record.role,
    status: "complete",
    target: { kind: "pull-request", number: 31, repository: "owner/repo" },
    inputRevision: record.inputRevision,
    summary: "merged the base head into the PR branch",
    result: { outcome: "branch_update_pushed", outputRevision: pushedHead },
    evidence: { finalizer, validations: checks },
  });
  return { ...record, runDir };
}

describe("pushed head authority transition", () => {
  it("keeps the transition whose head the pull request still carries", () => {
    expect(pushedHeadTransition(provenAttempt(), { headRefOid: pushedHead })).toEqual({
      originalHeadOid: originalHead,
      headOid: pushedHead,
    });
  });

  it("keeps no transition once the pull request moved past the proven head", () => {
    expect(pushedHeadTransition(provenAttempt(), { headRefOid: "d".repeat(40) })).toBeNull();
  });
});
