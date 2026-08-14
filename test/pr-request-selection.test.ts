import { describe, expect, it } from "vitest";

const { blockedPrLabelMove, orderedPrRequestLabels, selectPrRequest } = require("../src/pr-request-selection.ts");

const requestLabels = {
  updateBranch: "agent:update-branch",
  implement: "agent:implement",
  review: "agent:review",
};

describe("pull request Agent request selection", () => {
  it("selects the branch update before every other pending request", () => {
    expect(
      selectPrRequest(["agent:review", "agent:implement", "agent:update-branch"], requestLabels)?.role,
    ).toBe("branch-update");
  });

  it("selects the repair before a pending review request", () => {
    expect(selectPrRequest(["agent:review", "agent:implement"], requestLabels)?.role).toBe("review-repair");
  });

  it("selects the review when it is the only pending request", () => {
    expect(selectPrRequest(["agent:review"], requestLabels)?.role).toBe("reviewer");
  });

  it("reports the request label the selected role consumes", () => {
    expect(selectPrRequest(["agent:review", "agent:implement"], requestLabels)?.label).toBe("agent:implement");
  });

  it("selects nothing when the pull request carries no request label", () => {
    expect(selectPrRequest(["ready-for-agent", "agent:in-progress"], requestLabels)).toBeNull();
  });

  it("honours a project that renamed its request labels", () => {
    expect(selectPrRequest(["review-please"], { ...requestLabels, review: "review-please" })?.role).toBe("reviewer");
  });

  it("lists the request labels in the order they are processed", () => {
    expect(orderedPrRequestLabels(requestLabels)).toEqual([
      "agent:update-branch",
      "agent:implement",
      "agent:review",
    ]);
  });

  it("leaves a stopped pull request no waiting request", () => {
    expect(blockedPrLabelMove(requestLabels, "agent:in-progress", "agent:blocked").remove).toEqual([
      "agent:update-branch",
      "agent:implement",
      "agent:review",
      "agent:in-progress",
    ]);
  });

  it("marks a stopped pull request blocked", () => {
    expect(blockedPrLabelMove(requestLabels, "agent:in-progress", "agent:blocked").add).toEqual(["agent:blocked"]);
  });

  it("removes the renamed request labels of a project that configured its own", () => {
    expect(
      blockedPrLabelMove({ ...requestLabels, review: "review-please" }, "agent:in-progress", "agent:blocked").remove,
    ).toContain("review-please");
  });
});
