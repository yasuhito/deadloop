import { describe, expect, it } from "vitest";

const {
  renderIssueBlockedComment,
  renderIssueExplorerPrompt,
  renderIssuePlanningComment,
  renderIssueWorkerPrompt,
} = require("../src/issue-coordinator-renderers.cts");

const blockedInput = {
  issueNumber: 72,
  githubRepo: "owner/repo with space",
  repoPath: "/tmp/repo path",
  automationDir: "/tmp/auto dir",
  blockedLabel: "agent:blocked label",
  implementLabel: "agent:implement label",
  summary: "Worker launch failed.",
  confirmed: ["Workspace trust has not been accepted."],
  nextDecision: "An operator must accept workspace trust.",
  promiseFile: "/tmp/worktree/.deadloop/promise weird.json",
  workspaceId: "workspace-1",
  worktreePath: "/tmp/work tree",
  branch: "agent/issue-72-renderers",
};

const workerInput = {
  launchReason: "medium: ordinary implementation.",
  issueNumber: 72,
  issueTitle: "Render worker prompt\nwith `tricky` title",
  issueUrl: "https://github.com/owner/repo/issues/72",
  githubRepo: "owner/repo",
  automationDir: "/automation",
  workerInstructions: "Read AGENTS.md. Do not paste unsafe fences.",
  checkCommand: "npm test && echo ```not a fence```",
  promiseFile: "/tmp/worktree/.deadloop/promise-123.json",
};

const explorerInput = {
  issueNumber: 72,
  issueTitle: "Explore the issue",
  issueUrl: "https://github.com/owner/repo/issues/72",
  githubRepo: "owner/repo",
  automationDir: "/automation",
  workerInstructions: "Read AGENTS.md. Do not paste unsafe fences.",
  promiseFile: "/tmp/worktree/.deadloop/promise-124.json",
};

describe("issue coordinator renderers", () => {
  it("renders the blocked issue incident section", () => {
    expect(renderIssueBlockedComment(blockedInput)).toContain("## What happened");
  });

  it("renders the blocked issue recovery section", () => {
    expect(renderIssueBlockedComment(blockedInput)).toContain("## Recovery steps");
  });

  it("orders the blocked incident section before recovery", () => {
    expect(renderIssueBlockedComment(blockedInput).indexOf("## What happened")).toBeLessThan(
      renderIssueBlockedComment(blockedInput).indexOf("## Recovery steps"),
    );
  });

  it("quotes blocked comment shell arguments that contain spaces", () => {
    expect(renderIssueBlockedComment(blockedInput)).toContain("gh issue view 72 -R 'owner/repo with space' --comments");
  });

  it("renders the blocked issue requeue command", () => {
    expect(renderIssueBlockedComment(blockedInput)).toContain(
      "gh issue edit 72 -R 'owner/repo with space' --remove-label 'agent:blocked label' --add-label 'agent:implement label'",
    );
  });

  it("targets the implementable issue in planning recovery", () => {
    const comment = renderIssuePlanningComment({
      githubRepo: "owner/repo",
      blockedLabel: "custom-blocked",
      readyLabel: "custom-ready",
      implementLabel: "custom-implement",
    });

    expect(comment).toContain('gh issue edit "$implementable_issue_number"');
  });

  it("does not target the selected planning issue in planning recovery", () => {
    const comment = renderIssuePlanningComment({
      issueNumber: 72,
      githubRepo: "owner/repo",
      blockedLabel: "custom-blocked",
      readyLabel: "custom-ready",
      implementLabel: "custom-implement",
    });

    expect(comment).not.toContain("gh issue edit 72");
  });

  it("renders configured labels in planning recovery", () => {
    const comment = renderIssuePlanningComment({
      githubRepo: "owner/repo",
      blockedLabel: "custom-blocked",
      readyLabel: "custom-ready",
      implementLabel: "custom-implement",
    });

    expect(comment).toContain("--remove-label custom-blocked --add-label custom-ready --add-label custom-implement");
  });

  it("renders the worker issue target", () => {
    expect(renderIssueWorkerPrompt(workerInput)).toContain("Issue: #72 Render worker prompt with `tricky` title");
  });

  it("renders the worker implementation contract", () => {
    expect(renderIssueWorkerPrompt(workerInput)).toContain(
      "Treat the issue's `Agent Brief` or `What to build` plus `Acceptance criteria` as the implementation contract.",
    );
  });

  it("renders worker prohibitions", () => {
    expect(renderIssueWorkerPrompt(workerInput)).toContain("- Do not push.");
  });

  it("renders the worker validation command through the isolation helper", () => {
    expect(renderIssueWorkerPrompt(workerInput)).toContain(
      "node /automation/run-project-check.ts --command 'npm test && echo ```not a fence```'",
    );
  });

  it("shell-quotes longer backtick runs passed to the isolation helper", () => {
    expect(renderIssueWorkerPrompt({ ...workerInput, checkCommand: "echo ````" })).toContain(
      "--command 'echo ````'",
    );
  });

  it("hands the semantic payload to the launch-time code snapshot writer", () => {
    expect(renderIssueWorkerPrompt(workerInput)).toContain("node /automation/write-worker-report.cts");
  });

  it("targets the attempt record beside the promise file", () => {
    expect(renderIssueWorkerPrompt(workerInput)).toContain("--attempt-record /tmp/worktree/.deadloop/attempt.json");
  });

  it("does not ask the worker to hand-write the exact V1 identity", () => {
    expect(renderIssueWorkerPrompt(workerInput)).not.toContain('"schemaVersion":1');
  });

  it("does not ask the worker to transcribe git rev-parse HEAD output", () => {
    expect(renderIssueWorkerPrompt(workerInput)).not.toContain("outputRevision");
  });

  it("requires confirming the writer succeeded before stopping", () => {
    expect(renderIssueWorkerPrompt(workerInput)).toContain("exits 0");
  });

  it("requires a three-sentence summary in the worker payload template", () => {
    expect(renderIssueWorkerPrompt(workerInput)).toContain('"summary":"<three sentences>"');
  });

  it("requires a three-sentence summary in the explorer report template", () => {
    expect(renderIssueExplorerPrompt(explorerInput)).toContain('"summary":"<three sentences>"');
  });

  it("hands the explorer semantic payload to the launch-time writer", () => {
    expect(renderIssueExplorerPrompt(explorerInput)).toContain("node /automation/write-explorer-report.cts");
  });

  it("does not ask the explorer to hand-write V1 identity", () => {
    expect(renderIssueExplorerPrompt(explorerInput)).not.toContain('"schemaVersion":1');
  });

  it("requires the explorer to confirm writer success", () => {
    expect(renderIssueExplorerPrompt(explorerInput)).toContain("exits 0");
  });
});
