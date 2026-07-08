import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const automationDir = path.join(process.cwd(), "extensions/pi-looper/automations");
const driverScript = path.join(automationDir, "issue-coordinator-driver.ts");

function readTemplate(name: string): string {
  return fs.readFileSync(path.join(automationDir, name), "utf8");
}

function issueCoordinatorWorkerPrompt(): string {
  const result = spawnSync("node", [driverScript, "--fixture", "test/fixtures/issue-coordinator/driver-ready-worker.json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PI_LOOPER_PROJECT_ID: "demo", PI_LOOPER_REPO_PATH: "/repo", PI_LOOPER_GITHUB_REPO: "owner/repo" },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout).prompt;
}

// A raw agent-launch branch is a `herdr agent start ... -- pi`/`-- claude`
// command that names the agent binary directly, which the launcher replaced.
const rawLaunchBranch = /agent start[^\n]*--\s+(pi|claude)\b/;

describe("agent launch template migration", () => {
  it("launches workers through launch-agent in the issue coordinator", () => {
    expect(issueCoordinatorWorkerPrompt()).toMatch(/launch-agent\.ts/);
  });

  it("launches the review agent through launch-agent in the pr reviewer", () => {
    expect(readTemplate("pr-reviewer.prompt.md")).toMatch(/launch-agent\.ts/);
  });

  it("selects the review agent kind from the reviewerAgent template value", () => {
    expect(readTemplate("pr-reviewer.prompt.md")).toMatch(/--agent\s+"?\{\{reviewerAgent\}\}"?/);
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
