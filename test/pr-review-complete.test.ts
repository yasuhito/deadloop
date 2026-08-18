import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const dispatched: Record<string, unknown>[] = [];
const ops = {
  dispatch: (args: Record<string, unknown>) => {
    dispatched.push(args);
    return { action: "done", driverAction: "review_human_handoff" };
  },
};

const { completion } = require("../extensions/deadloop/automations/pr-review-complete.cts");

const head = "a".repeat(40);
const otherHead = "b".repeat(40);
const roots: string[] = [];

afterEach(() => {
  dispatched.length = 0;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function stoppedReview(outcome = "human_required", reviewedHead = head) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-complete-"));
  roots.push(runDir);
  const promiseFile = path.join(runDir, "promise.json");
  const record = {
    attemptId: "attempt-31", launchUuid: "launch-31", project: "demo", repository: "owner/repo",
    role: "reviewer", target: { kind: "pull-request", number: 31 }, inputRevision: { head },
    branch: "agent/issue-31", worktreePath: runDir, agentName: "dl-r-31-abcdef123456",
    workspaceLabel: "reviewer", promptFile: path.join(runDir, "prompt.md"), promiseFile,
    phase: "agent_started", lastSuccessfulPhase: "agent_started",
  };
  fs.writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify(record));
  fs.writeFileSync(promiseFile, JSON.stringify({
    schemaVersion: 1, attemptId: record.attemptId, role: "reviewer", status: "complete",
    target: { kind: "pull-request", number: 31, repository: "owner/repo" }, inputRevision: { head },
    summary: "a person has to decide",
    result: {
      outcome, reviewedHead,
      findings: outcome === "approved"
        ? []
        : [{ title: "Race", body: "Re-observe the head", path: "src/a.ts", line: 1, severity: "major" }],
      ...(outcome === "changes_requested" ? { priorRequiredFindings: "all_resolved" } : {}),
    },
    evidence: { reviewed: ["the exact diff"] },
  }));
  return { record, runDir, promiseFile };
}

function run(review: ReturnType<typeof stoppedReview>, overrides: Record<string, unknown> = {}) {
  return completion({
    promise: review.promiseFile,
    attemptRecord: path.join(review.runDir, "attempt.json"),
    projectId: "demo", projectRepo: "/repo", githubRepo: "owner/repo", stateDir: "/state", enabledAt: 1,
    pr: 31, expectedHead: head,
    reviewLabel: "agent:review", implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch",
    inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    ...overrides,
  }, ops);
}

describe("completing a stopped review", () => {
  it("returns the dispatcher's result for a human-required review", () => {
    expect(run(stoppedReview()).driverAction).toBe("review_human_handoff");
  });

  it("dispatches against the head the review reported reading", () => {
    run(stoppedReview());

    expect(dispatched[0].expectedHead).toBe(head);
  });

  it("passes the configured update-branch label into the handoff", () => {
    run(stoppedReview());

    expect(dispatched[0].updateBranchLabel).toBe("agent:update-branch");
  });

  it("refuses a repairing review, which completes by launching another agent", () => {
    expect(() => run(stoppedReview("changes_requested"))).toThrow(/repair review completes through its monitor/);
  });

  it("refuses an approved review, which completes under merge or handoff gates", () => {
    expect(() => run(stoppedReview("approved"))).toThrow(/approve review completes through its monitor/);
  });

  it("refuses a review whose report read a different head", () => {
    expect(() => run(stoppedReview("human_required", otherHead))).toThrow(/does not prove a completed review/);
  });

  it("refuses a review the caller expects at another head", () => {
    expect(() => run(stoppedReview(), { expectedHead: otherHead })).toThrow(/did not read the expected head/);
  });
});
