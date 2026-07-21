import { describe, expect, it } from "vitest";

const { renderIssueMonitorPrompt, renderRepairMonitorPrompt, renderReviewerMonitorPrompt } = require("../src/monitor-prompts.ts");

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
      projectId: "demo",
      repoPath: "/repo",
      githubRepo: "owner/repo",
      stateDir: "/state",
      checkCommand: "npm test",
      dispatcherCheckCommand: "npm test",
      workerAgent: "pi",
      workerModel: "",
      remote: "origin",
      humanLabel: "ready-for-human",
      reviewLabel: "agent:review",
      reviewingLabel: "agent:reviewing",
      blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("If autoMerge=false, never merge");
  });

  it("routes reviewer changes_requested through a self-contained repair dispatcher command", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24,
      expectedHeadOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      branch: "agent/issue-24",
      automationDir: "/automation path",
      promiseFile: "/state/promise.json",
      actorName: "reviewer",
      projectId: "demo project",
      repoPath: "/repo path",
      githubRepo: "owner/repo",
      stateDir: "/state dir",
      checkCommand: "npm run test -- --grep 'repair'",
      dispatcherCheckCommand: "npm run test -- --grep 'repair'",
      workerAgent: "claude",
      workerModel: "model with spaces",
      remote: "fork remote",
      humanLabel: "ready-for-human",
      reviewLabel: "custom review",
      reviewingLabel: "custom reviewing",
      blockedLabel: "custom blocked",
    });

    expect(prompt).toContain("--github-repo owner/repo --repo-path '/repo path' --project-id 'demo project' --state-dir '/state dir' --check-command 'npm run test -- --grep '\"'\"'repair'\"'\"'' --worker-agent claude --worker-model 'model with spaces' --remote 'fork remote' --review-label 'custom review' --reviewing-label 'custom reviewing' --blocked-label 'custom blocked'");
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
