import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const automationDir = path.join(process.cwd(), "extensions/pi-looper/automations");
const driverScript = path.join(automationDir, "issue-coordinator-driver.ts");

function issueCoordinatorWorkerPrompt(): string {
  const result = spawnSync("node", [driverScript, "--fixture", "test/fixtures/issue-coordinator/driver-ready-worker.json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PI_LOOPER_PROJECT_ID: "demo", PI_LOOPER_REPO_PATH: "/repo", PI_LOOPER_GITHUB_REPO: "owner/repo" },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout).prompt;
}

function watchSection(promptFile: string, heading: string): string {
  const template = fs.readFileSync(path.join(automationDir, promptFile), "utf8");
  const start = template.indexOf(heading);
  if (start === -1) {
    throw new Error(`heading not found: ${heading} in ${promptFile}`);
  }
  const next = template.indexOf("\n### ", start + heading.length);
  return template.slice(start, next === -1 ? undefined : next);
}

describe("watch polling break instruction", () => {
  it("tells issue-coordinator watch to break polling once the promise settles", () => {
    expect(issueCoordinatorWorkerPrompt()).toMatch(/break polling immediately/);
  });

  it("tells pr-reviewer watch to break polling once the promise settles", () => {
    const section = watchSection("pr-reviewer.prompt.md", "### 9. レビューエージェントの監視");
    expect(section).toMatch(/直ちにポーリングを打ち切/);
  });

  it("shows issue-coordinator watch a break-early loop example", () => {
    expect(issueCoordinatorWorkerPrompt()).toMatch(/complete\|blocked\) break/);
  });

  it("shows pr-reviewer watch a break-early loop example", () => {
    const section = watchSection("pr-reviewer.prompt.md", "### 9. レビューエージェントの監視");
    expect(section).toMatch(/complete\|blocked\) break/);
  });
});
