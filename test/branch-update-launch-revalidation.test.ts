import { describe, expect, it } from "vitest";

const {
  assertBranchUpdateClaimHeld,
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

/** The pull request as GitHub shows it once the branch-update request has been claimed. */
const claimedPr = {
  number: 31, state: "OPEN", headRefName: "agent/issue-31", headRefOid: head,
  isDraft: false, mergeable: "CONFLICTING",
  labels: [{ name: "agent:in-progress" }],
  comments: [{ body: renderBranchUpdateMarker(head, base) }],
};

const selectablePr = {
  ...claimedPr,
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
    const attempted = { ...selectablePr, comments: claimedPr.comments };

    expect(() => assertBranchUpdateRequestSelectable(attempted, env(), head, base, {
      livePrs: () => [attempted], agents: () => ({ result: { agents: [] } }), decisionFor: () => delegating,
    })).toThrow("branch-update target changed");
  });

  it("accepts the claimed pull request after its own claim consumed the request label", () => {
    expect(() => assertBranchUpdateClaimHeld(claimedPr, env(), head, base, { binding: {} }, {
      reauthorize: () => claimedPr, decisionFor: () => delegating,
    })).not.toThrow();
  });

  it("rejects a claimed pull request that lost its active claim state", () => {
    const released = { ...claimedPr, labels: [{ name: "agent:review" }] };

    expect(() => assertBranchUpdateClaimHeld(claimedPr, env(), head, base, { binding: {} }, {
      reauthorize: () => released, decisionFor: () => delegating,
    })).toThrow("claimed branch-update state");
  });

  it("rejects a claimed pull request whose branch-update target moved", () => {
    expect(() => assertBranchUpdateClaimHeld(claimedPr, env(), head, base, { binding: {} }, {
      reauthorize: () => claimedPr, decisionFor: () => ({ ...delegating, headOid: "c".repeat(40) }),
    })).toThrow("branch-update target changed");
  });
});
