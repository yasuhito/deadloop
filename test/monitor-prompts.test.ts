import { describe, expect, it } from "vitest";

const { renderIssueMonitorPrompt, renderReviewerMonitorPrompt } = require("../src/monitor-prompts.ts");

describe("monitor prompts", () => {
  it("renders shared promise polling rules for Worker monitoring", () => {
    const prompt = renderIssueMonitorPrompt({
      issueNumber: 12,
      automationDir: "/automation",
      promiseFile: "/wt/.deadloop/promise-u.json",
      actorName: "Worker",
      worktreePath: "/wt",
      branch: "agent/issue-12-demo",
      checkCommand: "npm test",
      reviewLabel: "agent:review",
      inProgressLabel: "agent:in-progress",
      blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("If the promise status is `complete` or `blocked`, break polling immediately");
  });

  it("renders issue-specific completion instructions", () => {
    const prompt = renderIssueMonitorPrompt({
      issueNumber: 12,
      automationDir: "/automation",
      promiseFile: "/wt/.deadloop/promise-u.json",
      actorName: "Worker",
      worktreePath: "/wt",
      branch: "agent/issue-12-demo",
      checkCommand: "npm test",
      reviewLabel: "agent:review",
      inProgressLabel: "agent:in-progress",
      blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("create a reviewable PR whose body includes `Closes #12`");
  });

  it("keeps manual issue close forbidden", () => {
    const prompt = renderIssueMonitorPrompt({
      issueNumber: 12,
      automationDir: "/automation",
      promiseFile: "/wt/.deadloop/promise-u.json",
      actorName: "Worker",
      worktreePath: "/wt",
      branch: "agent/issue-12-demo",
      checkCommand: "npm test",
      reviewLabel: "agent:review",
      inProgressLabel: "agent:in-progress",
      blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("Do not manually close the issue with GitHub commands");
  });

  it("renders reviewer-specific completion instructions", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24,
      automationDir: "/automation",
      promiseFile: "/wt/.deadloop/promise-u.json",
      actorName: "reviewer",
      reviewerTabId: "workspace:review-tab",
      checkCommand: "npm test",
      humanLabel: "ready-for-human",
      reviewingLabel: "agent:reviewing",
      blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("If autoMerge=false, never merge");
  });

  it("closes the dedicated reviewer tab after persisting a completed review outcome", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24,
      automationDir: "/automation",
      promiseFile: "/wt/.deadloop/promise-u.json",
      actorName: "reviewer",
      reviewerTabId: "workspace:review-tab",
      checkCommand: "npm test",
      humanLabel: "ready-for-human",
      reviewingLabel: "agent:reviewing",
      blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("herdr tab close workspace:review-tab");
  });

  it("retains the reviewer tab when persisting its outcome fails", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24,
      automationDir: "/automation",
      promiseFile: "/wt/.deadloop/promise-u.json",
      actorName: "reviewer",
      reviewerTabId: "workspace:review-tab",
      checkCommand: "npm test",
      humanLabel: "ready-for-human",
      reviewingLabel: "agent:reviewing",
      blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("If outcome persistence fails, keep the tab open");
  });
});
