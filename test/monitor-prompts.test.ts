import { describe, expect, it } from "vitest";

const { renderBranchUpdateMonitorPrompt, renderIssueMonitorPrompt, renderRepairMonitorPrompt, renderReviewerMonitorPrompt } = require("../src/monitor-prompts.ts");

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
      expectedHeadOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      branch: "agent/issue-24",
      automationDir: "/automation",
      promiseFile: "/wt/.deadloop/promise-u.json",
      actorName: "reviewer",
      checkCommand: "npm test",
      humanLabel: "ready-for-human",
      reviewLabel: "agent:review",
      reviewingLabel: "agent:reviewing",
      blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("If autoMerge=false, never merge");
  });

  it("routes reviewer changes_requested through the repair dispatcher", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24,
      expectedHeadOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      branch: "agent/issue-24",
      automationDir: "/automation",
      promiseFile: "/state/promise.json",
      actorName: "reviewer",
      checkCommand: "npm test",
      humanLabel: "ready-for-human",
      reviewLabel: "agent:review",
      reviewingLabel: "agent:reviewing",
      blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("outcome=changes_requested");
  });

  it("routes issue monitor mutations through the enablement guard", () => {
    const prompt = renderIssueMonitorPrompt({
      issueNumber: 12, automationDir: "/automation", promiseFile: "/state/promise.json", actorName: "Worker",
      repoPath: "/repo", githubRepo: "owner/repo", stateDir: "/state", worktreePath: "/wt", branch: "agent/issue-12",
      checkCommand: "npm test", reviewLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("guarded-operation.ts");
  });

  it("routes approved reviewer handoff and merge through the enablement guard", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), branch: "agent/issue-24", automationDir: "/automation",
      promiseFile: "/state/promise.json", actorName: "reviewer", repoPath: "/repo", githubRepo: "owner/repo", stateDir: "/state",
      checkCommand: "npm test", humanLabel: "ready-for-human", reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("including PR creation, comments, labels, handoff, merge, and blocked paths");
  });

  it("routes branch-update blocked handling through the enablement guard", () => {
    const prompt = renderBranchUpdateMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), expectedBaseOid: "b".repeat(40), branch: "agent/issue-24",
      automationDir: "/automation", promiseFile: "/state/promise.json", actorName: "branch-update worker",
      repoPath: "/repo", githubRepo: "owner/repo", stateDir: "/state", reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("Never run those mutations directly");
  });

  it("routes repair blocked handling through the enablement guard", () => {
    const prompt = renderRepairMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), branch: "agent/issue-24", automationDir: "/automation",
      promiseFile: "/state/promise.json", actorName: "review-repair worker", repoPath: "/repo", githubRepo: "owner/repo", stateDir: "/state",
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("if it reports that deadloop is disabled, stop without that mutation");
  });

  it("keeps review labels through successful repair monitoring", () => {
    const prompt = renderRepairMonitorPrompt({
      prNumber: 24,
      expectedHeadOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      branch: "agent/issue-24",
      automationDir: "/automation",
      promiseFile: "/state/repair-promise.json",
      actorName: "review-repair worker",
      reviewLabel: "agent:review",
      reviewingLabel: "agent:reviewing",
      blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("Do not change labels; the changed head starts a new review cycle");
  });
});
