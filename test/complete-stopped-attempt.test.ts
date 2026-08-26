import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { completeProvenStoppedAttempt } = require("../extensions/deadloop/automations/reconcile-pr-work-authority.cts");

const startHead = "a".repeat(40);
const pushedHead = "b".repeat(40);
const baseHead = "c".repeat(40);
const checks = [{ command: "npm run check", result: "passed" }];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const workflowLabels = {
  reviewLabel: "agent:review",
  implementLabel: "agent:implement",
  updateBranchLabel: "agent:update-branch",
  inProgressLabel: "agent:in-progress",
  blockedLabel: "agent:blocked",
};

const reconcilerArgs = {
  projectId: "demo",
  projectRepo: "/repo",
  githubRepo: "owner/repo",
  stateDir: "/state",
  enabledAt: 1,
};

/** An attempt that stopped after its finalizer pushed and its report was written. */
function stoppedAttempt(overrides: { role?: string; reason?: string; receipt?: unknown } = {}) {
  const role = overrides.role || "branch-update";
  const reason = overrides.reason || "branch_update_pushed";
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-complete-stopped-"));
  roots.push(runDir);
  const finalizer = {
    action: "pushed", reason, originalHeadOid: startHead, baseHeadOid: baseHead, headOid: pushedHead, checks,
  };
  const record = {
    attemptId: "attempt-31", launchUuid: "launch-31", project: "demo", repository: "owner/repo",
    role, target: { kind: "pull-request", number: 31 },
    inputRevision: { head: startHead, base: baseHead }, branch: "agent/issue-31",
    worktreePath: runDir, agentName: "dl-u-31-abcdef123456", workspaceLabel: role,
    promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"),
    phase: "agent_started", lastSuccessfulPhase: "agent_started", requestEventId: "22",
    runDir,
  };
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value));
  write("attempt.json", record);
  write("promise.json", {
    schemaVersion: 1,
    attemptId: record.attemptId,
    role,
    status: "complete",
    target: { kind: "pull-request", number: 31, repository: "owner/repo" },
    inputRevision: record.inputRevision,
    summary: "merged the base head into the pull request branch",
    result: {
      outcome: reason,
      outputRevision: pushedHead,
      ...(role === "review-repair" ? { repairs: [{ title: "Lint", summary: "formatted", paths: ["src/a.ts"] }] } : {}),
    },
    evidence: { finalizer, validations: checks },
  });
  if (overrides.receipt !== null) write("finalizer-result.json", overrides.receipt ?? finalizer);
  return record;
}

/** A review that stopped after writing its report. It pushes nothing, so it leaves no receipt. */
function stoppedReview(outcome = "human_required", summary = "two required findings need a person") {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-complete-stopped-review-"));
  roots.push(runDir);
  const record = {
    attemptId: "attempt-31", launchUuid: "launch-31", project: "demo", repository: "owner/repo",
    role: "reviewer", target: { kind: "pull-request", number: 31 },
    inputRevision: { head: startHead }, branch: "agent/issue-31",
    worktreePath: runDir, agentName: "dl-r-31-abcdef123456", workspaceLabel: "reviewer",
    promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"),
    phase: "agent_started", lastSuccessfulPhase: "agent_started", requestEventId: "22",
    runDir,
  };
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(runDir, name), JSON.stringify(value));
  write("attempt.json", record);
  write("promise.json", {
    schemaVersion: 1,
    attemptId: record.attemptId,
    role: "reviewer",
    status: "complete",
    target: { kind: "pull-request", number: 31, repository: "owner/repo" },
    inputRevision: record.inputRevision,
    summary,
    result: {
      outcome,
      reviewedHead: startHead,
      findings: [{ title: "Race", body: "Re-observe the head", path: "src/a.ts", line: 1, severity: "major" }],
      ...(outcome === "changes_requested" ? { priorRequiredFindings: "all_resolved" } : {}),
    },
    evidence: { reviewed: ["the exact diff"] },
  });
  return record;
}

function complete(record: any, headRefOid: string, calls: any[] = []) {
  return completeProvenStoppedAttempt(
    record,
    { number: 31, headRefOid },
    reconcilerArgs,
    workflowLabels,
    { complete: (role: string, handlerArgs: Record<string, unknown>) => (calls.push({ role, handlerArgs }), { status: "done" }) },
  );
}

function refusal() {
  return completeProvenStoppedAttempt(
    stoppedAttempt(),
    { number: 31, headRefOid: pushedHead },
    reconcilerArgs,
    workflowLabels,
    { complete: () => { throw new Error("authority lost"); } },
  );
}

describe("completing a proven stopped attempt", () => {
  it("returns the completion handler's result for a proven branch update", () => {
    expect(complete(stoppedAttempt(), pushedHead)).toEqual({ kind: "completed", result: { status: "done" } });
  });

  it("waits when the pushed head has not reached the pull request snapshot", () => {
    expect(complete(stoppedAttempt(), startHead)).toEqual({ kind: "pending_head_visibility" });
  });

  it("hands the completion handler the head the attempt started from", () => {
    const calls: any[] = [];
    complete(stoppedAttempt(), pushedHead, calls);

    expect(calls[0].handlerArgs.expectedHead).toBe(startHead);
  });

  it("completes a proven review repair through its own handler", () => {
    const calls: any[] = [];
    complete(stoppedAttempt({ role: "review-repair", reason: "repair_pushed" }), pushedHead, calls);

    expect(calls[0].role).toBe("review-repair");
  });

  it("hands a review repair the finalizer receipt beside its report", () => {
    const calls: any[] = [];
    const record = stoppedAttempt({ role: "review-repair", reason: "repair_pushed" });
    complete(record, pushedHead, calls);

    expect(calls[0].handlerArgs.result).toBe(path.join(record.runDir, "finalizer-result.json"));
  });

  it("completes nothing when the finalizer left no receipt", () => {
    expect(complete(stoppedAttempt({ receipt: null }), pushedHead)).toBeNull();
  });

  it("completes nothing once the pull request moved past the proven head", () => {
    expect(complete(stoppedAttempt(), "d".repeat(40))).toBeNull();
  });

  it("completes a stopped review that proved it read the pull request's head", () => {
    const calls: any[] = [];
    complete(stoppedReview(), startHead, calls);

    expect(calls[0].role).toBe("reviewer");
  });

  it("picks up a finished review whose report mentions the storage exhaustion that killed its owner", () => {
    const calls: any[] = [];
    complete(stoppedReview("changes_requested", "review ended after ENOSPC: no space left on device"), startHead, calls);

    expect(calls).toHaveLength(1);
  });

  it("hands a stopped review the head it reported reviewing", () => {
    const calls: any[] = [];
    complete(stoppedReview(), startHead, calls);

    expect(calls[0].handlerArgs.expectedHead).toBe(startHead);
  });

  it("completes no review once the pull request moved past the reviewed head", () => {
    expect(complete(stoppedReview(), pushedHead)).toBeNull();
  });

  it("refuses rather than completing when the completion handler fails", () => {
    expect(refusal().kind).toBe("refused");
  });

  it("carries the completion handler's own reason out of a refusal", () => {
    expect(refusal().reason).toBe("authority lost");
  });
});
