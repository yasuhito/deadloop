import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const issueDriver = readFileSync("extensions/deadloop/automations/issue-coordinator-driver.cts", "utf8");
const reviewerDriver = readFileSync("extensions/deadloop/automations/pr-reviewer-driver.cts", "utf8");

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

  it("passes launch revalidation through the non-replaceable guarded reviewer launch boundary", () => {
    expect(launchWithAdapters).toMatch(/return withEnabledDriverLaunch\(env, mutate, launch, \{[\s\S]*revalidate,[\s\S]*prepareAttempt/);
  });

  it("revalidates PR eligibility inside the reviewer launch guard", () => {
    expect(launchPrReviewer).toMatch(/launchWithAdapters[\s\S]*planPrRequestAction/);
  });

  it("revalidates the branch-update target on both sides of request consumption inside the launch guard", () => {
    expect(launchBranchUpdate).toMatch(
      /launchWithAdapters[\s\S]*assertBranchUpdateRequestSelectable[\s\S]*assertBranchUpdateRequestConsumed/,
    );
  });

  it("revalidates the exact persisted contract inside the repair launch guard", () => {
    const launchPrRepair = namedFunction(reviewerDriver, "launchPrRepair");
    expect(launchPrRepair).toMatch(/launchWithAdapters[\s\S]*persistedRepairContract/);
  });
});
