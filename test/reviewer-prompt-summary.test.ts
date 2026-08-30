import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const {
  branchUpdateWorkerPrompt,
  envConfig,
  reviewAgentPrompt,
} = require("../extensions/deadloop/automations/pr-reviewer-driver.cts");

const HEAD = "b".repeat(40);
const pr = {
  number: 22,
  title: "Reviewer prompt summary field",
  url: "https://github.com/octo/demo/pull/22",
  headRefOid: HEAD,
  headRefName: "agent/pr-22",
};

function env() {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-reviewer-prompt-"));
  return envConfig({
    DEADLOOP_GITHUB_REPO: "octo/demo",
    DEADLOOP_REPO_PATH: repoPath,
    DEADLOOP_PROJECT_ID: "demo",
    DEADLOOP_ENABLED_AT: "1",
    DEADLOOP_STATE_DIR: "/state",
  });
}

describe("reviewer and branch-update report templates", () => {
  it("requires a three-sentence summary in the reviewer report template", () => {
    const prompt = reviewAgentPrompt(
      pr,
      env(),
      "/state/runs/attempt-1/promise.json",
      "review request",
      "/worktree",
      "attempt-1",
      "/state/runs/attempt-1/history.json",
      "history-1",
    );

    expect(prompt).toContain('"summary":"<three sentences>"');
  });

  it("requires a three-sentence summary in the branch-update report template", () => {
    const prompt = branchUpdateWorkerPrompt(
      pr,
      env(),
      "/state/runs/attempt-2/promise.json",
      "/worktree",
      HEAD,
      "c".repeat(40),
      "attempt-2",
    );

    expect(prompt).toContain('"summary":"<three sentences>"');
  });
});
