import { describe, expect, it } from "vitest";

const { parseArgs } = require("../extensions/deadloop/automations/pr-branch-update-complete.ts");

const originalHead = "a".repeat(40);

describe("branch update completion", () => {
  it("requires the review claim argument", () => {
    expect(() => parseArgs([
      "--promise", "/p", "--attempt-record", "/a", "--project-id", "demo", "--project-repo", "/repo",
      "--github-repo", "owner/repo", "--state-dir", "/state", "--enabled-at", "1", "--pr", "31",
      "--expected-head", originalHead, "--review-label", "agent:review",
      "--in-progress-label", "agent:in-progress", "--blocked-label", "agent:blocked",
    ])).toThrow("--review-claim is required");
  });
});
