import { describe, expect, it } from "vitest";

const { renderBranchUpdateMonitorPrompt, renderIssueMonitorPrompt, renderRepairMonitorPrompt, renderReviewerMonitorPrompt } = require("../src/monitor-prompts.cts");

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

  it("passes the configured Worker review label to attempt persistence", () => {
    const prompt = renderIssueMonitorPrompt({
      issueNumber: 12, automationDir: "/automation", promiseFile: "/state/runs/one/promise.json", actorName: "Worker",
      worktreePath: "/wt", branch: "agent/issue-12", checkCommand: "npm test", readyLabel: "custom:ready",
      implementLabel: "custom:implement", reviewLabel: "custom:review", inProgressLabel: "custom:claimed",
      blockedLabel: "custom:blocked",
    });

    expect(prompt).toMatch(/persist-attempt-result\.ts[^`]+--review-label custom:review/);
  });

  it("passes configured Worker labels to the completion proof", () => {
    const prompt = renderIssueMonitorPrompt({
      issueNumber: 12, automationDir: "/automation", promiseFile: "/state/runs/one/promise.json", actorName: "Worker",
      worktreePath: "/wt", branch: "agent/issue-12", checkCommand: "npm test", readyLabel: "custom:ready",
      implementLabel: "custom:implement", reviewLabel: "custom:review", inProgressLabel: "custom:claimed",
      blockedLabel: "custom:blocked",
    });

    expect(prompt).toContain("--worker-ready-label custom:ready --worker-implement-label custom:implement --worker-review-label custom:review");
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
      implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch",
      reviewLabel: "agent:review",

      blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("If autoMerge=false, never merge");
  });

  it("keeps legacy reviewer reports out of public recording and successful handoff", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), branch: "agent/issue-24", automationDir: "/automation",
      promiseFile: "/state/runs/one/promise.json", actorName: "reviewer", projectId: "demo", repoPath: "/repo",
      githubRepo: "owner/repo", stateDir: "/state", autoMerge: false, checkCommand: "npm test",
      implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch", inProgressLabel: "agent:in-progress",
      reviewLabel: "agent:review", blockedLabel: "agent:blocked", worktreeRoot: "/worktrees",
    });
    expect(prompt).toContain("Legacy complete promises are inspection-only evidence: do not dispatch, comment, change labels, or report successful handoff for them");
  });

  it("routes ready handoff through accepted-history revalidation", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), branch: "agent/issue-24", automationDir: "/automation",
      promiseFile: "/state/runs/one/promise.json", actorName: "reviewer", projectId: "demo", repoPath: "/repo",
      githubRepo: "owner/repo", stateDir: "/state", enabledAt: 123, autoMerge: false, checkCommand: "npm test",
      implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch", reviewLabel: "agent:review", blockedLabel: "agent:blocked",
    });
    expect(prompt).toContain("handoff-reviewed-pr.ts --project-repo /repo --github-repo owner/repo --state-dir /state --enabled-at 123 --pr 24 --expected-head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --review-promise /state/runs/one/promise.json --history-observation /state/runs/one/pr-review-history-accepted.json");
  });

  it("renders no completion label when automatic merge is disabled", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), branch: "agent/issue-24", automationDir: "/automation",
      promiseFile: "/state/runs/one/promise.json", actorName: "reviewer", projectId: "demo", repoPath: "/repo",
      githubRepo: "owner/repo", stateDir: "/state", autoMerge: false, checkCommand: "npm test",
      implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch", reviewLabel: "agent:review", blockedLabel: "agent:blocked",
    });
    expect(prompt.split("After an approved result")[1]?.split("`")[1] || "").not.toContain("--expected-label");
  });

  it("renders in-progress claim completion label when automatic merge is enabled", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), branch: "agent/issue-24", automationDir: "/automation",
      promiseFile: "/state/runs/one/promise.json", actorName: "reviewer", projectId: "demo", repoPath: "/repo",
      githubRepo: "owner/repo", stateDir: "/state", autoMerge: true, checkCommand: "npm test",
      implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch", reviewLabel: "agent:review",
      inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    });
    expect(prompt).toMatch(/complete-attempt-workspace\.ts[^`]+--expected-label agent:in-progress(?![^`]+--expected-label)/);
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
      worktreeRoot: "/custom worktrees",
      githubRepo: "owner/repo",
      stateDir: "/state dir",
      checkCommand: "npm run test -- --grep 'repair'",
      dispatcherCheckCommand: "npm run test -- --grep 'repair'",
      workerAgent: "claude",
      workerModel: "model with spaces",
      remote: "fork remote",
      implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch",
      reviewLabel: "custom review",
            blockedLabel: "custom blocked",
    });

    expect(prompt).toContain("--github-repo owner/repo --repo-path '/repo path' --worktree-root '/custom worktrees' --project-id 'demo project' --state-dir '/state dir' --check-command 'npm run test -- --grep '\"'\"'repair'\"'\"'' --worker-agent claude --worker-model 'model with spaces' --remote 'fork remote' --review-label 'custom review' --blocked-label 'custom blocked' --implement-label agent:implement --update-branch-label agent:update-branch");
  });

  it("renders the reviewer dispatcher with its complete authorization context", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), branch: "agent/issue-24", automationDir: "/automation",
      promiseFile: "/state/promise.json", actorName: "reviewer", projectId: "demo", repoPath: "/repo path",
      worktreeRoot: "/custom worktrees", githubRepo: "owner/repo", stateDir: "/state", enabledAt: 123, projectCheckCommand: "npm test",
      workerAgent: "pi", workerModel: "model", repairRemote: "origin", checkCommand: "npm test",
      implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch", reviewLabel: "agent:review", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("DEADLOOP_WORKTREE_ROOT='/custom worktrees' DEADLOOP_STATE_DIR=/state");
  });

  it("binds reviewer dispatch to the consumed request generation", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), requestEventId: "review-22", branch: "agent/issue-24",
      automationDir: "/automation", promiseFile: "/state/promise.json", actorName: "reviewer",
      repoPath: "/repo", worktreeRoot: "/worktrees", githubRepo: "owner/repo", stateDir: "/state",
      checkCommand: "npm test", implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch",
      reviewLabel: "agent:review", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("--request-event-id review-22");
  });

  it("routes issue monitor mutations through the enablement guard", () => {
    const prompt = renderIssueMonitorPrompt({
      issueNumber: 12, automationDir: "/automation", promiseFile: "/state/promise.json", actorName: "Worker",
      repoPath: "/repo", githubRepo: "owner/repo", stateDir: "/state", worktreePath: "/wt", branch: "agent/issue-12",
      checkCommand: "npm test", reviewLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("guarded-operation.ts");
  });

  it("routes only approved non-merge reviewer mutations through the generic enablement guard", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), branch: "agent/issue-24", automationDir: "/automation",
      promiseFile: "/state/promise.json", actorName: "reviewer", repoPath: "/repo", githubRepo: "owner/repo", stateDir: "/state",
      checkCommand: "npm test", implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch", reviewLabel: "agent:review", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("Never pass merge, push, branch deletion, `gh api`, or arbitrary commands through `guarded-operation.ts`");
  });

  it("binds ready handoff to the reviewed PR head and approval evidence", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), branch: "agent/issue-24", automationDir: "/automation",
      promiseFile: "/state/promise.json", actorName: "reviewer", repoPath: "/repo", githubRepo: "owner/repo", stateDir: "/state",
      enabledAt: 123, autoMerge: false, checkCommand: "npm test", reviewLabel: "agent:review",
      implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("handoff-reviewed-pr.ts --project-repo /repo --github-repo owner/repo --state-dir /state --enabled-at 123 --pr 24 --expected-head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --review-promise /state/promise.json --history-observation /state/pr-review-history-accepted.json --review-label agent:review --implement-label agent:implement --update-branch-label agent:update-branch --in-progress-label agent:in-progress --blocked-label agent:blocked");
  });

  it("binds guarded reviewer mutations to configured active-state labels", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), branch: "agent/issue-24", automationDir: "/automation",
      promiseFile: "/state/promise.json", actorName: "reviewer", repoPath: "/repo", githubRepo: "owner/repo", stateDir: "/state",
      checkCommand: "npm test", implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch", reviewLabel: "agent:review",
      inProgressLabel: "custom:active", blockedLabel: "custom:blocked",
    });

    expect(prompt).toContain("--target-kind pull-request --attempt-record /state/attempt.json --in-progress-label custom:active --blocked-label custom:blocked --");
  });

  it("binds auto-merge to the reviewed PR head", () => {
    const prompt = renderReviewerMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), branch: "agent/issue-24", automationDir: "/automation",
      promiseFile: "/state/promise.json", actorName: "reviewer", repoPath: "/repo", githubRepo: "owner/repo", stateDir: "/state",
      enabledAt: 123, checkCommand: "npm test", implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch", reviewLabel: "agent:review",
      blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("merge-reviewed-pr.ts --attempt-record /state/attempt.json --project-repo /repo --github-repo owner/repo --state-dir /state --enabled-at 123 --pr 24 --expected-head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa --review-promise /state/promise.json --history-observation /state/pr-review-history-accepted.json --in-progress-label agent:in-progress --blocked-label agent:blocked");
  });

  it("prohibits branch-update monitor mutations outside deterministic completion", () => {    const prompt = renderBranchUpdateMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), expectedBaseOid: "b".repeat(40), branch: "agent/issue-24",
      automationDir: "/automation", promiseFile: "/state/promise.json", actorName: "branch-update worker",
      repoPath: "/repo", githubRepo: "owner/repo", stateDir: "/state", reviewLabel: "agent:review", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("no mutation authority");
  });

  it("routes repair blocked handling through the enablement guard", () => {
    const prompt = renderRepairMonitorPrompt({
      prNumber: 24, expectedHeadOid: "a".repeat(40), branch: "agent/issue-24", automationDir: "/automation",
      promiseFile: "/state/promise.json", actorName: "review-repair worker", repoPath: "/repo", githubRepo: "owner/repo", stateDir: "/state",
      reviewLabel: "agent:review", blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("if it reports that deadloop is disabled, stop without that mutation");
  });

  it("keeps review labels through successful repair monitoring", () => {
    const prompt = renderRepairMonitorPrompt({
      prNumber: 24,
      expectedHeadOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      branch: "agent/issue-24",
      githubRepo: "owner/repo",
      attemptKey: "abcdef1234567890abcd",
      automationDir: "/automation",
      promiseFile: "/state/repair-promise.json",
      actorName: "review-repair worker",
      reviewLabel: "agent:review",

      blockedLabel: "agent:blocked",
    });

    expect(prompt).toContain("pr-review-repair-complete.ts");
  });
});
