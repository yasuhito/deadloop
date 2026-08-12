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

  it("selects a review request as the reviewer role", () => {
    expect(selectPrRequestTarget([pr(7, ["agent:review"])], config).role).toBe("reviewer");
  });

  it("selects the branch update first when one pull request carries every request", () => {
    expect(
      selectPrRequestTarget([pr(7, ["agent:review", "agent:implement", "agent:update-branch"])], config).role,
    ).toBe("branch-update");
  });

  it("reports the request label the selection consumes", () => {
    expect(selectPrRequestTarget([pr(7, ["agent:review", "agent:update-branch"])], config).requestLabel).toBe("agent:update-branch");
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

  it("does not let a pull request whose next request has no launcher hide the next candidate", () => {
    expect(selectPrRequestTarget([pr(7, ["agent:implement"]), pr(9, ["agent:review"])], config).number).toBe(9);
  });

  it("reports why a request with no launcher was skipped", () => {
    expect(selectPrRequestTarget([pr(7, ["agent:implement"])], config).skipped).toEqual([
      { number: 7, reason: "unserved_request" },
    ]);
  });

  it("does not fall back to the review request behind a request with no launcher", () => {
    expect(selectPrRequestTarget([pr(7, ["agent:implement", "agent:review"])], config).selected).toBe(false);
  });

  it("does not select a review request while checks are still running", () => {
    const running = pr(7, ["agent:review"], { statusCheckRollup: [{ status: "IN_PROGRESS" }] });

    expect(selectPrRequestTarget([running], config).selected).toBe(false);
  });
});
