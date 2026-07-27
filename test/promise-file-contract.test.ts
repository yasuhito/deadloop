import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const { renderIssueWorkerPrompt } = require("../src/issue-coordinator-renderers.ts");

function issueWorkerPrompt(): string {
  return renderIssueWorkerPrompt({
    launchReason: "medium",
    issueNumber: 1,
    issueTitle: "Demo",
    issueUrl: "https://github.com/owner/repo/issues/1",
    githubRepo: "owner/repo",
    automationDir: "/automation",
    workerInstructions: "Read AGENTS.md.",
    checkCommand: "npm test",
    promiseFile: "<deadloopStateDir>/runs/<uuid>/promise.json",
  });
}

describe("promise file contract", () => {
  it("documents unique promise file allocation outside the worktree", () => {
    expect(issueWorkerPrompt()).toContain("<deadloopStateDir>/runs/<uuid>/promise.json");
  });

  it("requires blocked workers to write a promise file", () => {
    expect(issueWorkerPrompt()).toContain('"status":"blocked"');
  });

  it("uses the promise file as the completion authority", () => {
    expect(readFileSync("extensions/deadloop/automations/issue-coordinator.prompt.md", "utf8")).toContain(
      "only completion authority",
    );
  });
});
