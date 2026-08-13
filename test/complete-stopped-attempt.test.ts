import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { completeProvenStoppedAttempt } = require("../extensions/deadloop/automations/reconcile-pr-work-authority.ts");

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
    phase: "agent_started", lastSuccessfulPhase: "agent_started",
    reviewClaim: { binding: { repository: "owner/repo", targetNumber: 31 }, authoritySeconds: 3600 },
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

  it("hands the completion handler the head the attempt started from", () => {
    const calls: any[] = [];
    complete(stoppedAttempt(), pushedHead, calls);

    expect(calls[0].handlerArgs.expectedHead).toBe(startHead);
  });

  it("hands the completion handler the attempt's saved review claim", () => {
    const calls: any[] = [];
    const record = stoppedAttempt();
    complete(record, pushedHead, calls);

    expect(calls[0].handlerArgs.reviewClaim).toEqual(record.reviewClaim);
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

  it("refuses rather than completing when the completion handler fails", () => {
    expect(refusal().kind).toBe("refused");
  });

  it("carries the completion handler's own reason out of a refusal", () => {
    expect(refusal().reason).toBe("authority lost");
  });
});
