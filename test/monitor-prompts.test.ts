import { describe, expect, it } from "vitest";

const { renderIssueMonitorPrompt } = require("../src/monitor-prompts.cts");

describe("monitor prompts for roles not yet migrated", () => {
  it("renders shared promise polling rules for Worker monitoring", () => {
    const prompt = renderIssueMonitorPrompt({
      issueNumber: 12, automationDir: "/automation", promiseFile: "/state/promise.json", actorName: "Worker",
      worktreePath: "/wt", branch: "agent/issue-12", checkCommand: "npm test", reviewLabel: "agent:review",
      inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("If the promise status is `complete` or `blocked`, break polling immediately");
  });

  it("passes the configured Worker review label to attempt persistence", () => {
    const prompt = renderIssueMonitorPrompt({
      issueNumber: 12, automationDir: "/automation", promiseFile: "/state/runs/one/promise.json", actorName: "Worker",
      worktreePath: "/wt", branch: "agent/issue-12", checkCommand: "npm test",
      implementLabel: "custom:implement", reviewLabel: "custom:review", inProgressLabel: "custom:claimed",
      blockedLabel: "custom:blocked",
    });

    expect(prompt).toMatch(/persist-attempt-result\.cts[^`]+--review-label custom:review/);
  });

  it("passes configured Worker labels to the completion proof", () => {
    const prompt = renderIssueMonitorPrompt({
      issueNumber: 12, automationDir: "/automation", promiseFile: "/state/runs/one/promise.json", actorName: "Worker",
      worktreePath: "/wt", branch: "agent/issue-12", checkCommand: "npm test",
      implementLabel: "custom:implement", reviewLabel: "custom:review", inProgressLabel: "custom:claimed",
      blockedLabel: "custom:blocked",
    });

    expect(prompt).toContain("--worker-review-label custom:review");
  });

  it("keeps manual Issue close forbidden", () => {
    const prompt = renderIssueMonitorPrompt({
      issueNumber: 12, automationDir: "/automation", promiseFile: "/state/promise.json", actorName: "Worker",
      worktreePath: "/wt", branch: "agent/issue-12", checkCommand: "npm test", reviewLabel: "agent:review",
      inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("Do not manually close the issue with GitHub commands");
  });
});
