import { describe, expect, it } from "vitest";

const { renderRepairMonitorPrompt } = require("../src/monitor-prompts.cts");

describe("monitor prompts for roles not yet migrated", () => {
  it("routes repair blocked handling through the enablement guard", () => {
    const prompt = renderRepairMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), branch: "agent/issue-24", automationDir: "/automation",
      promiseFile: "/state/promise.json", actorName: "review-repair worker", repoPath: "/repo",
      githubRepo: "owner/repo", stateDir: "/state", reviewLabel: "agent:review", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("if it reports that deadloop is disabled, stop without that mutation");
  });

  it("routes successful repair through its deterministic completion handler", () => {
    const prompt = renderRepairMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), branch: "agent/issue-24", automationDir: "/automation",
      promiseFile: "/state/repair-promise.json", actorName: "review-repair worker", reviewLabel: "agent:review",
      blockedLabel: "agent:blocked", attemptKey: "abcdef1234567890abcd",
    });

    expect(prompt).toContain("pr-review-repair-complete.cts");
  });
});
