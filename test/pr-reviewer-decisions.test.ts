import { describe, expect, it } from "vitest";

const { defaultDecisionConfig, selectPrRequestTarget } = require("../extensions/deadloop/automations/pr-reviewer-decisions.ts");

type AnyRecord = Record<string, any>;

function pr(number: number, labels: string[], overrides: AnyRecord = {}): AnyRecord {
  return {
    number,
    headRefOid: "a".repeat(40),
    isDraft: false,
    labels: labels.map((name) => ({ name })),
    ...overrides,
  };
}

const config = defaultDecisionConfig({ projectId: "demo", automationLogin: "deadloop-bot" });

describe("pull request request-target selection", () => {
  it("selects a branch update request as the branch-update role", () => {
    expect(selectPrRequestTarget([pr(7, ["agent:update-branch"])], config).role).toBe("branch-update");
  });

  it("selects a repair request as the review-repair role", () => {
    expect(selectPrRequestTarget([pr(7, ["agent:implement"])], config).role).toBe("review-repair");
  });

  it("selects a review request as the reviewer role", () => {
    expect(selectPrRequestTarget([pr(7, ["agent:review"])], config).role).toBe("reviewer");
  });

  it("selects the branch update first when one pull request carries every request", () => {
    expect(
      selectPrRequestTarget([pr(7, ["agent:review", "agent:implement", "agent:update-branch"])], config).role,
    ).toBe("branch-update");
  });

  it("selects the repair first when one pull request carries both implement and review", () => {
    expect(selectPrRequestTarget([pr(7, ["agent:review", "agent:implement"])], config).role).toBe("review-repair");
  });

  it("reports the request label the selection consumes", () => {
    expect(selectPrRequestTarget([pr(7, ["agent:review", "agent:implement"])], config).requestLabel).toBe("agent:implement");
  });

  it("selects a draft pull request that carries a review request", () => {
    expect(selectPrRequestTarget([pr(7, ["agent:review"], { isDraft: true })], config).selected).toBe(true);
  });

  it("does not select a pull request handed to a human", () => {
    expect(selectPrRequestTarget([pr(7, ["ready-for-human"])], config).selected).toBe(false);
  });

  it("does not select a pull request handed to a human when automatic merge is enabled", () => {
    expect(
      selectPrRequestTarget([pr(7, ["ready-for-human"])], defaultDecisionConfig({ autoMerge: true })).selected,
    ).toBe(false);
  });

  it("does not select a blocked pull request that still carries a request", () => {
    expect(selectPrRequestTarget([pr(7, ["agent:review", "agent:blocked"])], config).selected).toBe(false);
  });

  it("selects a branch update while checks are still running", () => {
    const conflicted = pr(7, ["agent:update-branch"], { statusCheckRollup: [{ status: "IN_PROGRESS" }] });

    expect(selectPrRequestTarget([conflicted], config).selected).toBe(true);
  });

  it("does not select a review request while checks are still running", () => {
    const running = pr(7, ["agent:review"], { statusCheckRollup: [{ status: "IN_PROGRESS" }] });

    expect(selectPrRequestTarget([running], config).selected).toBe(false);
  });
});
