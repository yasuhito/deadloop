import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const issueDriver = readFileSync("extensions/deadloop/automations/issue-coordinator-driver.ts", "utf8");
const reviewerDriver = readFileSync("extensions/deadloop/automations/pr-reviewer-driver.ts", "utf8");
const repairDriver = readFileSync("extensions/deadloop/automations/pr-review-repair-dispatch.ts", "utf8");

function namedFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

const launchWithAdapters = namedFunction(reviewerDriver, "launchWithAdapters");
const launchPrReviewer = namedFunction(reviewerDriver, "launchPrReviewer");
const launchBranchUpdate = namedFunction(reviewerDriver, "launchBranchUpdate");

describe("guarded launch revalidation wiring", () => {
  it("revalidates issue eligibility inside the issue-worker launch guard", () => {
    expect(issueDriver).toMatch(/withEnabledDriverLaunch[\s\S]*revalidate:[\s\S]*planIssueCoordinatorAction/);
  });

  it("bounds launch revalidation to the exact selected issue", () => {
    expect(issueDriver).toMatch(/revalidate:[\s\S]*issueDecisionDeadline\(\)[\s\S]*getIssue\(env\.githubRepo, number\)/);
  });

  it("passes launch revalidation through the shared reviewer launch adapter", () => {
    expect(launchWithAdapters).toMatch(/withEnabledDriverLaunch\(env, mutate, launch, \{ revalidate \}\)/);
  });

  it("revalidates PR eligibility inside the reviewer launch guard", () => {
    expect(launchPrReviewer).toMatch(/launchWithAdapters[\s\S]*planPrReviewerAction/);
  });

  it("revalidates the exact head, base, and attempt marker inside the branch-update launch guard", () => {
    expect(launchBranchUpdate).toMatch(/launchWithAdapters[\s\S]*branchUpdateDecision[\s\S]*branchUpdateAttemptExists/);
  });

  it("revalidates the exact review-repair attempt inside the repair launch guard", () => {
    expect(repairDriver).toMatch(/withEnabledDriverLaunch[\s\S]*revalidate:[\s\S]*selectRepairAttempt/);
  });
});
