import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const { renderIssueBlockedComment, renderIssueWorkerPrompt } = require("../src/issue-coordinator-renderers.ts");

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

const issueCoordinatorPrompt = readFileSync("extensions/deadloop/automations/issue-coordinator.prompt.md", "utf8");

const workerInput = {
  launchReason: "medium: ordinary implementation.",
  issueNumber: 72,
  issueTitle: "Render worker prompt\nwith `tricky` title",
  issueUrl: "https://github.com/owner/repo/issues/72",
  githubRepo: "owner/repo",
  workerInstructions: "Read AGENTS.md. Do not paste unsafe fences.",
  checkCommand: "npm test && echo ```not a fence```",
  promiseFile: "/tmp/worktree/.deadloop/promise-123.json",
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

  it("renders the worker validation command", () => {
    expect(renderIssueWorkerPrompt(workerInput)).toContain("~~~bash\n  npm test && echo ```not a fence```\n  ~~~");
  });

  it("renders the isolated project validation command when provided", () => {
    expect(
      renderIssueWorkerPrompt({
        ...workerInput,
        validationCommand: "node /automation/run-project-check.ts --cwd /wt --command 'npm test'",
      }),
    ).toContain("node /automation/run-project-check.ts --cwd /wt --command 'npm test'");
  });

  it("uses a safe worker validation fence for longer backtick runs", () => {
    expect(renderIssueWorkerPrompt({ ...workerInput, checkCommand: "echo ````" })).toContain(
      "~~~bash\n  echo ````\n  ~~~",
    );
  });

  it("renders the worker promise file contract", () => {
    expect(renderIssueWorkerPrompt(workerInput)).toContain(
      '{"status":"blocked","reason":"clear reason","summary":"three-sentence summary"}',
    );
  });

  it("keeps the prompt-based coordinator pointed at the deterministic renderers", () => {
    expect(issueCoordinatorPrompt).toContain("src/issue-coordinator-renderers.ts");
  });
});
