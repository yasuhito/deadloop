import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const { renderIssueBlockedComment } = require("../src/issue-coordinator-renderers.ts");

const issueBlockedComment = renderIssueBlockedComment({
  issueNumber: 1,
  githubRepo: "owner/repo",
  repoPath: "/repo",
  automationDir: "/auto",
  blockedLabel: "agent:blocked",
  implementLabel: "agent:implement",
  summary: "blocked",
});
const prReviewerPrompt = readFileSync("extensions/pi-looper/automations/pr-reviewer.prompt.md", "utf8");

describe("blocked report format prompts", () => {
  it("requires the issue coordinator blocked report recovery section", () => {
    expect(issueBlockedComment).toContain("## 復旧手順");
  });

  it("requires the issue coordinator blocked report requeue command", () => {
    expect(issueBlockedComment).toContain(
      'gh issue edit 1 -R owner/repo --remove-label agent:blocked --add-label agent:implement',
    );
  });

  it("requires the PR reviewer blocked report recovery section", () => {
    expect(prReviewerPrompt).toContain("## 復旧手順");
  });

  it("requires the PR reviewer blocked report requeue command", () => {
    expect(prReviewerPrompt).toContain(
      'gh issue edit <issueNumber> -R {{githubRepo}} --remove-label "{{blockedLabel}}" --add-label "{{implementLabel}}"',
    );
  });
});
