import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const issueCoordinatorPrompt = readFileSync(
  "extensions/pi-looper/automations/generic-issue-coordinator.prompt.md",
  "utf8",
);
const prReviewerPrompt = readFileSync("extensions/pi-looper/automations/generic-pr-reviewer.prompt.md", "utf8");

describe("blocked report format prompts", () => {
  it("requires the issue coordinator blocked report recovery section", () => {
    expect(issueCoordinatorPrompt).toContain("## 復旧手順");
  });

  it("requires the issue coordinator blocked report requeue command", () => {
    expect(issueCoordinatorPrompt).toContain(
      'gh issue edit <N> -R {{githubRepo}} --remove-label "{{blockedLabel}}" --add-label "{{implementLabel}}"',
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
