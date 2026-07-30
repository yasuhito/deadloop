import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPreparedAttempt, readAttemptRecord } from "../src/attempt-lifecycle";

const { hasExactClaim, reconcileLocked } = require("../extensions/deadloop/automations/reconcile-prepared-attempt.ts");

const roots: string[] = [];
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-claim-reconcile-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const runDir = path.join(stateDir, "runs", "launch-1");
  createPreparedAttempt(runDir, {
    attemptId: "launch-1", launchUuid: "launch-1", project: "demo", repository: "owner/repo", role: "worker",
    target: { kind: "issue", number: 12 }, inputRevision: { head: "a".repeat(40) }, branch: "agent/issue-12",
    baseBranch: "origin/main", worktreePath: path.join(root, "worktree"), agentName: "dl-w-12-123456789abc",
    workspaceLabel: "Issue 12", promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"),
  });
  const args = {
    attemptRecord: path.join(runDir, "attempt.json"), projectId: "demo", projectRepo: root, githubRepo: "owner/repo", stateDir,
    enabledAt: "1", readyLabel: "custom:ready", implementLabel: "custom:implement", inProgressLabel: "custom:claimed",
    reviewLabel: "custom:review", reviewingLabel: "custom:reviewing", blockedLabel: "custom:blocked",
  };
  return { args, runDir };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("prepared attempt claim reconciliation", () => {
  it("durably advances a crash-left prepared Worker attempt when the configured exact claim is present", () => {
    const data = setup();
    const runner = { runJson: () => ({ state: "OPEN", labels: [{ name: "custom:ready" }, { name: "custom:claimed" }] }) };
    reconcileLocked(data.args, runner);
    expect(readAttemptRecord(data.runDir).phase).toBe("github_claimed");
  });

  it("preserves a prepared Worker attempt when its configured claim is absent", () => {
    const data = setup();
    const runner = { runJson: () => ({ state: "OPEN", labels: [{ name: "custom:ready" }, { name: "custom:implement" }] }) };
    reconcileLocked(data.args, runner);
    expect(readAttemptRecord(data.runDir).phase).toBe("prepared");
  });

  it("does not require a workspace identity to reconcile a prepared crash record", () => {
    const data = setup();
    const runner = { runJson: () => ({ state: "OPEN", labels: [{ name: "custom:ready" }, { name: "custom:claimed" }] }) };
    const result = reconcileLocked(data.args, runner);
    expect(result.driverAction).toBe("prepared_claim_reconciled");
  });

  it("rejects a reviewer claim when the selected PR head changed", () => {
    const data = setup();
    const record = { ...readAttemptRecord(data.runDir), role: "reviewer", target: { kind: "pull-request", number: 12 } };
    const item = { state: "OPEN", headRefName: record.branch, headRefOid: "b".repeat(40), labels: [{ name: "custom:review" }, { name: "custom:reviewing" }], comments: [] };
    expect(hasExactClaim(record, item, data.args)).toBe(false);
  });

  it("requires the exact repair-attempt marker for a review-repair claim", () => {
    const data = setup();
    const record = { ...readAttemptRecord(data.runDir), role: "review-repair", target: { kind: "pull-request", number: 12 } };
    const item = { state: "OPEN", headRefName: record.branch, headRefOid: record.inputRevision.head, labels: [{ name: "custom:review" }, { name: "custom:reviewing" }], comments: [{ body: `<!-- deadloop:review-repair-attempt key=${record.attemptId} head=${record.inputRevision.head} review=abc -->` }] };
    expect(hasExactClaim(record, item, data.args)).toBe(true);
  });

  it("is idempotent after restart once the exact claim was durably reconciled", () => {
    const data = setup();
    const runner = { runJson: () => ({ state: "OPEN", labels: [{ name: "custom:ready" }, { name: "custom:claimed" }] }) };
    reconcileLocked(data.args, runner);
    const result = reconcileLocked(data.args, runner);
    expect(result.driverAction).toBe("claim_already_reconciled");
  });
});
