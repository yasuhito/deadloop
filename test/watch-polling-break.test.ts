import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const automationDir = path.join(process.cwd(), "extensions/deadloop/automations");
const driverScript = path.join(automationDir, "issue-coordinator-driver.ts");


// The dispatch lock writes under the state directory, so a fixture run needs one of its own rather
// than the operator's live deadloop state.
const testStateDirs: string[] = [];

afterEach(() => {
  for (const stateDir of testStateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

function deadloopTestStateDir(): string {
  const stateDir = mkdtempSync(path.join(tmpdir(), "deadloop-fixture-state-"));
  testStateDirs.push(stateDir);
  return stateDir;
}

function issueCoordinatorWorkerPrompt(): string {
  const result = spawnSync("node", [driverScript, "--fixture", "test/fixtures/issue-coordinator/driver-ready-worker.json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: "/repo", DEADLOOP_GITHUB_REPO: "owner/repo", DEADLOOP_STATE_DIR: deadloopTestStateDir() },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout).prompt;
}

function promptTemplate(promptFile: string): string {
  return fs.readFileSync(path.join(automationDir, promptFile), "utf8");
}

describe("watch polling break instruction", () => {
  it("tells issue-coordinator watch to break polling once the promise settles", () => {
    expect(issueCoordinatorWorkerPrompt()).toMatch(/break polling immediately/);
  });

  it("tells pr-reviewer watch to break polling once the promise settles", () => {
    expect(promptTemplate("pr-reviewer.prompt.md")).toMatch(/Break polling immediately/);
  });

  it("shows issue-coordinator watch a break-early instruction", () => {
    expect(issueCoordinatorWorkerPrompt()).toMatch(/complete.*blocked.*break/s);
  });

  it("shows pr-reviewer watch a break-early loop example", () => {
    expect(promptTemplate("pr-reviewer.prompt.md")).toMatch(/complete.*blocked/);
  });
});
