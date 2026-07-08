import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const { renderIssueWorkerPrompt } = require("../src/issue-coordinator-renderers.ts");

const contractFiles = [
  "extensions/pi-looper/automations/issue-coordinator.prompt.md",
  "extensions/pi-looper/automations/pr-reviewer.prompt.md",
  "extensions/pi-looper/automations/extract-worker-promise.ts",
  "extensions/pi-looper/automations/issue-coordinator-driver.ts",
  "src/issue-coordinator-renderers.ts",
];

function combinedContractText() {
  return contractFiles.map((file) => readFileSync(file, "utf8")).join("\n---FILE---\n");
}

function issueWorkerPrompt(): string {
  return renderIssueWorkerPrompt({
    launchReason: "medium",
    issueNumber: 1,
    issueTitle: "Demo",
    issueUrl: "https://github.com/owner/repo/issues/1",
    githubRepo: "owner/repo",
    workerInstructions: "AGENTS.md を読む。",
    checkCommand: "npm test",
    promiseFile: "<worktreePath>/.pi-looper/promise-<uuid>.json",
  });
}

describe("promise file contract", () => {
  it("removes the legacy promise text tag", () => {
    expect(combinedContractText()).not.toContain("<promise>");
  });

  it("removes JSONL session extraction", () => {
    expect(combinedContractText()).not.toContain("JSONL");
  });

  it("removes pane-id based helper input", () => {
    expect(combinedContractText()).not.toContain("--pane-id");
  });

  it("documents unique promise file allocation", () => {
    expect(issueWorkerPrompt()).toContain("<worktreePath>/.pi-looper/promise-<uuid>.json");
  });

  it("requires blocked workers to write a promise file", () => {
    expect(issueWorkerPrompt()).toContain('"status":"blocked"');
  });

  it("uses the promise file as the completion authority", () => {
    expect(readFileSync("extensions/pi-looper/automations/issue-coordinator.prompt.md", "utf8")).toContain(
      "唯一の権威",
    );
  });
});
