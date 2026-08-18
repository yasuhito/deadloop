import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const automationDir = path.join(process.cwd(), "extensions/deadloop/automations");
const driverScript = path.join(automationDir, "issue-coordinator-driver.ts");

function readTemplate(name: string): string {
  return fs.readFileSync(path.join(automationDir, name), "utf8");
}

function issueCoordinatorWorkerResult(): Record<string, any> {
  const result = spawnSync("node", [driverScript, "--fixture", "test/fixtures/issue-coordinator/driver-ready-worker.json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: "/repo", DEADLOOP_GITHUB_REPO: "owner/repo", DEADLOOP_STATE_DIR: deadloopTestStateDir() },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function issueCoordinatorWorkerPrompt(): string {
  return issueCoordinatorWorkerResult().prompt;
}

// A raw agent-launch branch is a `herdr agent start ... -- pi`/`-- claude`
// command that names the agent binary directly, which the launcher replaced.
const rawLaunchBranch = /agent start[^\n]*--\s+(pi|claude)\b/;


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

describe("agent launch template", () => {
  it("launches workers deterministically before issue coordinator monitoring", () => {
    expect(issueCoordinatorWorkerResult().driverAction).toBe("worker_monitor_request");
  });

  it("keeps review launch inside the deterministic driver", () => {
    expect(readTemplate("pr-reviewer.prompt.md")).toContain("deterministic driver opens one fresh Herdr workspace");
  });

  it("keeps reviewerAgent as driver configuration", () => {
    expect(readTemplate("pr-reviewer.prompt.md")).toContain("reviewerAgent: `{{reviewerAgent}}`");
  });

  it("keeps no hard-coded pi agent kind in the pr reviewer launch", () => {
    expect(readTemplate("pr-reviewer.prompt.md")).not.toMatch(/--agent\s+pi\b/);
  });

  it("keeps no raw agent-start launch branch in the issue coordinator", () => {
    expect(issueCoordinatorWorkerPrompt()).not.toMatch(rawLaunchBranch);
  });

  it("keeps no raw agent-start launch branch in the pr reviewer", () => {
    expect(readTemplate("pr-reviewer.prompt.md")).not.toMatch(rawLaunchBranch);
  });

  it("keeps issue coordinator fallback focused on the driver", () => {
    expect(readTemplate("issue-coordinator.prompt.md")).toMatch(/issue-coordinator-driver\.ts/);
  });
});
