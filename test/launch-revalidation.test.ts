import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const issueDriver = readFileSync("extensions/deadloop/automations/issue-coordinator-driver.ts", "utf8");
const reviewerDriver = readFileSync("extensions/deadloop/automations/pr-reviewer-driver.ts", "utf8");
const repairDriver = readFileSync("extensions/deadloop/automations/pr-review-repair-dispatch.ts", "utf8");

describe("guarded launch revalidation wiring", () => {
  it("revalidates issue eligibility inside the issue-worker launch guard", () => {
    expect(issueDriver).toMatch(/withEnabledDriverLaunch[\s\S]*revalidate:[\s\S]*planIssueCoordinatorAction/);
  });

  it("revalidates PR eligibility inside the reviewer launch guard", () => {
    expect(reviewerDriver).toMatch(/function launchPrReviewer[\s\S]*withEnabledDriverLaunch[\s\S]*revalidate:[\s\S]*planPrReviewerAction/);
  });

  it("revalidates the exact head, base, and attempt marker inside the branch-update launch guard", () => {
    expect(reviewerDriver).toMatch(/function launchBranchUpdate[\s\S]*revalidate:[\s\S]*branchUpdateDecision[\s\S]*branchUpdateAttemptExists/);
  });

  it("revalidates the exact review-repair attempt inside the repair launch guard", () => {
    expect(repairDriver).toMatch(/withEnabledDriverLaunch[\s\S]*revalidate:[\s\S]*selectRepairAttempt/);
  });
});
