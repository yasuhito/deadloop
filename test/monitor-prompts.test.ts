import { describe, expect, it } from "vitest";

const { renderIssueMonitorPrompt, renderRepairMonitorPrompt } = require("../src/monitor-prompts.cts");

describe("monitor prompts for roles not yet migrated", () => {
  it("renders shared promise polling rules for Worker monitoring", () => {
    const prompt = renderIssueMonitorPrompt({
      issueNumber: 12, automationDir: "/automation", promiseFile: "/state/promise.json", actorName: "Worker",
      worktreePath: "/wt", branch: "agent/issue-12", checkCommand: "npm test", reviewLabel: "agent:review",
      inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("If the promise status is `complete` or `blocked`, break polling immediately");
  });

  it("passes configured Worker labels to the completion proof", () => {
    const prompt = renderIssueMonitorPrompt({
      issueNumber: 12, automationDir: "/automation", promiseFile: "/state/promise.json", actorName: "Worker",
      worktreePath: "/wt", branch: "agent/issue-12", checkCommand: "npm test", readyLabel: "custom:ready",
      implementLabel: "custom:implement", reviewLabel: "custom:review", inProgressLabel: "custom:claimed",
      blockedLabel: "custom:blocked",
    });

    expect(prompt).toContain("--worker-ready-label custom:ready --worker-implement-label custom:implement --worker-review-label custom:review");
  });

  it("keeps manual Issue close forbidden", () => {
    const prompt = renderIssueMonitorPrompt({
      issueNumber: 12, automationDir: "/automation", promiseFile: "/state/promise.json", actorName: "Worker",
      worktreePath: "/wt", branch: "agent/issue-12", checkCommand: "npm test", reviewLabel: "agent:review",
      inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("Do not manually close the issue with GitHub commands");
  });

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
