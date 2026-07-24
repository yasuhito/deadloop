import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const prReviewerPrompt = readFileSync("extensions/deadloop/automations/pr-reviewer.prompt.md", "utf8");

describe("PR reviewer blocked report prompt", () => {
  it("requires the recovery section", () => {
    expect(prReviewerPrompt).toContain("## Recovery steps");
  });

  it("requires the safe requeue command", () => {
    expect(prReviewerPrompt).toContain(
      'gh issue edit <issueNumber> -R {{githubRepo}} --remove-label "{{blockedLabel}}" --add-label "{{implementLabel}}"',
    );
  });
});
