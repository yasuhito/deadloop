import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderIssueBlockedComment, renderIssueWorkerPrompt } from "../src/issue-coordinator-renderers";

const blockedInput = {
  issueNumber: 72,
  githubRepo: "owner/repo with space",
  repoPath: "/tmp/repo path",
  automationDir: "/tmp/auto dir",
  blockedLabel: "agent:blocked label",
  implementLabel: "agent:implement label",
  summary: "Worker 起動に失敗しました。",
  confirmed: ["workspace trust が未承認です。"],
  nextDecision: "operator が trust を受け入れる必要があります。",
  promiseFile: "/tmp/worktree/.pi-looper/promise weird.json",
  workspaceId: "workspace-1",
  worktreePath: "/tmp/work tree",
  branch: "agent/issue-72-renderers",
};

const issueCoordinatorPrompt = readFileSync("extensions/pi-looper/automations/issue-coordinator.prompt.md", "utf8");

const workerInput = {
  launchReason: "medium: 通常の実装です。",
  issueNumber: 72,
  issueTitle: "Render worker prompt\nwith `tricky` title",
  issueUrl: "https://github.com/owner/repo/issues/72",
  githubRepo: "owner/repo",
  workerInstructions: "AGENTS.md を読む。```危険な fence``` を貼らない。",
  checkCommand: "npm test && echo ```not a fence```",
  promiseFile: "/tmp/worktree/.pi-looper/promise-123.json",
};

describe("issue coordinator renderers", () => {
  it("renders the blocked issue incident section", () => {
    expect(renderIssueBlockedComment(blockedInput)).toContain("## 何が起きたか");
  });

  it("renders the blocked issue recovery section", () => {
    expect(renderIssueBlockedComment(blockedInput)).toContain("## 復旧手順");
  });

  it("orders the blocked incident section before recovery", () => {
    expect(renderIssueBlockedComment(blockedInput).indexOf("## 何が起きたか")).toBeLessThan(
      renderIssueBlockedComment(blockedInput).indexOf("## 復旧手順"),
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
      "この issue の `Agent Brief` または `What to build` と `Acceptance criteria` を実装契約として扱ってください。",
    );
  });

  it("renders worker prohibitions", () => {
    expect(renderIssueWorkerPrompt(workerInput)).toContain("- push しない。");
  });

  it("renders the worker validation command", () => {
    expect(renderIssueWorkerPrompt(workerInput)).toContain("~~~bash\n  npm test && echo ```not a fence```\n  ~~~");
  });

  it("uses a safe worker validation fence for longer backtick runs", () => {
    expect(renderIssueWorkerPrompt({ ...workerInput, checkCommand: "echo ````" })).toContain(
      "~~~bash\n  echo ````\n  ~~~",
    );
  });

  it("renders the worker promise file contract", () => {
    expect(renderIssueWorkerPrompt(workerInput)).toContain(
      '{"status":"blocked","reason":"日本語の理由","summary":"3文要約(何をした・何が分かった・何が残っている)"}',
    );
  });

  it("keeps the prompt-based coordinator pointed at the deterministic renderers", () => {
    expect(issueCoordinatorPrompt).toContain("src/issue-coordinator-renderers.ts");
  });
});
