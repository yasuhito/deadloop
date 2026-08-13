import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const issueDriver = readFileSync("extensions/deadloop/automations/issue-coordinator-driver.ts", "utf8");
const reviewerDriver = readFileSync("extensions/deadloop/automations/pr-reviewer-driver.ts", "utf8");
const repairDriver = readFileSync("extensions/deadloop/automations/pr-review-repair-dispatch.ts", "utf8");
const extension = readFileSync("extensions/deadloop/index.ts", "utf8");

function namedFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("Herdr 0.8.0 activation boundary", () => {
  it("activates the Worker role through the selected disposable launch flow", () => {
    expect(namedFunction(issueDriver, "launchIssueWorker")).toContain("launchAgentFlow");
  });

  it("activates the reviewer role through the selected disposable launch flow", () => {
    expect(namedFunction(reviewerDriver, "launchPrReviewer")).toContain("launchWithAdapters");
  });

  it("selects launchBranchUpdate for the branch-update role", () => {
    expect(namedFunction(reviewerDriver, "drive")).toContain("launchBranchUpdate(");
  });

  it("selects launchRepair for the review-repair role", () => {
    expect(namedFunction(repairDriver, "dispatch")).toContain("launchRepair(");
  });

  it("keeps the startup preflight selected", () => {
    expect(namedFunction(extension, "startScheduler")).toContain("preflight()");
  });
});
