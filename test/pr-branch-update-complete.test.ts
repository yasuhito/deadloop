import { describe, expect, it } from "vitest";

const {
  assertBranchUpdateCompletionObservation,
  parseArgs,
} = require("../extensions/deadloop/automations/pr-branch-update-complete.ts");
const head = "a".repeat(40);

function args() {
  return [
    "--promise", "/state/runs/one/promise.json", "--attempt-record", "/state/runs/one/attempt.json",
    "--project-id", "demo", "--project-repo", "/repo", "--github-repo", "owner/repo",
    "--state-dir", "/state", "--enabled-at", "1", "--pr", "24", "--expected-head", head,
    "--review-label", "agent:review", "--implement-label", "agent:implement",
    "--update-branch-label", "agent:update-branch", "--in-progress-label", "agent:in-progress",
    "--blocked-label", "agent:blocked",
  ];
}

function idempotentObservation(overrides: Record<string, unknown> = {}) {
  return {
    pr: { state: "OPEN", headRefOid: "b".repeat(40), ...overrides },
    labels: ["agent:review"],
    revision: "b".repeat(40),
    authenticatedLogin: "deadloop-bot",
    enabledLogin: "deadloop-bot",
    reviewLabel: "agent:review",
    implementLabel: "agent:implement",
    updateBranchLabel: "agent:update-branch",
    inProgressLabel: "agent:in-progress",
    blockedLabel: "agent:blocked",
    mode: "already-applied",
  };
}

describe("branch update completion arguments", () => {
  it("does not require a review claim", () => {
    expect(parseArgs(args()).pr).toBe("24");
  });

  it("still requires the exact expected head", () => {
    const values = args();
    const index = values.indexOf("--expected-head");
    expect(() => parseArgs(values.filter((_value, item) => item !== index && item !== index + 1))).toThrow("--expected-head is required");
  });
});

describe("idempotent branch update completion", () => {
  it("accepts an exact already-applied retry", () => {
    expect(() => assertBranchUpdateCompletionObservation(idempotentObservation())).not.toThrow();
  });

  it("rejects an already-applied retry on a changed head", () => {
    expect(() => assertBranchUpdateCompletionObservation(
      idempotentObservation({ headRefOid: "c".repeat(40) }),
    )).toThrow("target changed");
  });

  it("rejects an already-applied retry under a changed authenticated login", () => {
    expect(() => assertBranchUpdateCompletionObservation({
      ...idempotentObservation(), authenticatedLogin: "other-bot",
    })).toThrow("identity lost");
  });

  it("rejects an already-applied retry after the pull request closes", () => {
    expect(() => assertBranchUpdateCompletionObservation(
      idempotentObservation({ state: "CLOSED" }),
    )).toThrow("target changed");
  });

  it("rejects an already-applied retry carrying the blocked label", () => {
    expect(() => assertBranchUpdateCompletionObservation({
      ...idempotentObservation(), labels: ["agent:review", "agent:blocked"],
    })).toThrow("managed state");
  });

  it("rejects an already-applied retry carrying in-progress too", () => {
    expect(() => assertBranchUpdateCompletionObservation({
      ...idempotentObservation(), labels: ["agent:review", "agent:in-progress"],
    })).toThrow("managed state");
  });

  it("rejects an already-applied retry carrying another managed request", () => {
    expect(() => assertBranchUpdateCompletionObservation({
      ...idempotentObservation(), labels: ["agent:review", "agent:implement"],
    })).toThrow("managed state");
  });
});
