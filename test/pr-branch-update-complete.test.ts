import { describe, expect, it } from "vitest";

const { parseArgs } = require("../extensions/deadloop/automations/pr-branch-update-complete.ts");
const head = "a".repeat(40);

function args() {
  return [
    "--promise", "/state/runs/one/promise.json", "--attempt-record", "/state/runs/one/attempt.json",
    "--project-id", "demo", "--project-repo", "/repo", "--github-repo", "owner/repo",
    "--state-dir", "/state", "--enabled-at", "1", "--pr", "24", "--expected-head", head,
    "--review-label", "agent:review", "--in-progress-label", "agent:in-progress", "--blocked-label", "agent:blocked",
  ];
}

describe("branch update completion arguments", () => {
  it("does not require a review claim", () => {
    expect(parseArgs(args()).pr).toBe("24");
  });

  it("still requires the exact expected head", () => {
    const values = args();
    const index = values.indexOf("--expected-head");
    expect(() => parseArgs(values.filter((_value, item) => item !== index && item !== index + 1))).toThrow("--expected-head is required");
  });
});
