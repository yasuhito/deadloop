import { describe, expect, it } from "vitest";

const {
  assertBranchUpdateRequestConsumed,
  assertBranchUpdateRequestSelectable,
} = require("../extensions/deadloop/automations/pr-reviewer-driver.ts");
const { renderBranchUpdateMarker } = require("../extensions/deadloop/automations/pr-branch-update-state.ts");

const head = "a".repeat(40);
const base = "b".repeat(40);

function env(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "demo", githubRepo: "owner/repo", githubRepositoryId: "R_repo",
    reviewLabel: "agent:review", implementLabel: "agent:implement",
    updateBranchLabel: "agent:update-branch", inProgressLabel: "agent:in-progress",
    blockedLabel: "agent:blocked", automationLogin: "deadloop-bot",
    authorizedAutomationLogins: ["deadloop-bot"], stateDir: "/state",
    autoMerge: false, externalReviewEnabled: false, externalReviewWaitSeconds: "1800", now: "",
    ...overrides,
  };
}

/** The pull request as GitHub shows it once the branch-update request has been consumed. */
const consumedPr = {
  number: 31, state: "OPEN", headRefName: "agent/issue-31", headRefOid: head,
  isDraft: false, mergeable: "CONFLICTING",
  labels: [{ name: "agent:in-progress" }],
  comments: [{ body: renderBranchUpdateMarker(head, base) }],
};

const selectablePr = {
  ...consumedPr,
  labels: [{ name: "agent:update-branch" }],
  comments: [],
};

const delegating = { action: "delegate_worker", reason: "merge_conflict", headOid: head, baseOid: base };

describe("branch update launch revalidation", () => {
  it("accepts the waiting request before the claim consumes it", () => {
    expect(() => assertBranchUpdateRequestSelectable(selectablePr, env(), head, base, {
      livePrs: () => [selectablePr], agents: () => ({ result: { agents: [] } }), decisionFor: () => delegating,
    })).not.toThrow();
  });

  it("rejects a pull request whose branch-update target moved before the claim", () => {
    expect(() => assertBranchUpdateRequestSelectable(selectablePr, env(), head, base, {
      livePrs: () => [selectablePr], agents: () => ({ result: { agents: [] } }),
      decisionFor: () => ({ ...delegating, baseOid: "c".repeat(40) }),
    })).toThrow("branch-update target changed");
  });

  it("rejects a repeated attempt for the same head and base before the claim", () => {
    const attempted = { ...selectablePr, comments: consumedPr.comments };

    expect(() => assertBranchUpdateRequestSelectable(attempted, env(), head, base, {
      livePrs: () => [attempted], agents: () => ({ result: { agents: [] } }), decisionFor: () => delegating,
    })).toThrow("branch-update target changed");
  });

  it("accepts the consumed pull request after its own consumption removed the request label", () => {
    expect(() => assertBranchUpdateRequestConsumed(consumedPr, env(), head, base, "request-22", {
      request: () => ({ id: "request-22" }), reauthorize: () => consumedPr, decisionFor: () => delegating,
    })).not.toThrow();
  });

  it("rejects a consumed pull request that lost its active workflow state", () => {
    const released = { ...consumedPr, labels: [{ name: "agent:review" }] };

    expect(() => assertBranchUpdateRequestConsumed(consumedPr, env(), head, base, "request-22", {
      request: () => ({ id: "request-22" }), reauthorize: () => released, decisionFor: () => delegating,
    })).toThrow("consumed branch-update state");
  });

  it("rejects a consumed pull request whose branch-update target moved", () => {
    expect(() => assertBranchUpdateRequestConsumed(consumedPr, env(), head, base, "request-22", {
      request: () => ({ id: "request-22" }), reauthorize: () => consumedPr, decisionFor: () => ({ ...delegating, headOid: "c".repeat(40) }),
    })).toThrow("branch-update target changed");
  });
});
