import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
function reject(script: string, args: string[] = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-preflight-entry-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const githubCalled = path.join(root, "github-called");
  const agentStarted = path.join(root, "agent-started");
  writeFileSync(path.join(bin, "herdr"), `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'herdr 0.7.4\\n'
elif [ "$1 $2" = "status server" ]; then printf 'version: 0.7.5\\ncompatible: yes\\n'
elif [ "$1 $2" = "agent start" ]; then touch ${JSON.stringify(agentStarted)}
fi
`);
  writeFileSync(path.join(bin, "gh"), `#!/bin/sh\ntouch ${JSON.stringify(githubCalled)}\nprintf '{}\\n'\n`);
  chmodSync(path.join(bin, "herdr"), 0o755);
  chmodSync(path.join(bin, "gh"), 0o755);
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const output = result.stdout.trim() ? JSON.parse(result.stdout) : {};
  return {
    rejected: result.status !== 0 || output.driverAction === "exception" || output.error === "herdr_incompatible",
    githubCalled: existsSync(githubCalled), agentStarted: existsSync(agentStarted),
  };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const repairArgs = ["--promise", "/missing/promise.json", "--pr", "1", "--expected-head", "a".repeat(40), "--branch", "feature"];
const completionArgs = [
  "--promise", "/missing/promise.json", "--result", "/missing/result.json", "--contract", "/missing/contract.json",
  "--project-repo", "/repo", "--github-repo", "owner/repo", "--state-dir", "/state", "--enabled-at", "1",
  "--pr", "1", "--branch", "feature", "--expected-head", "a".repeat(40), "--attempt-key", "key",
  "--review-label", "review", "--reviewing-label", "reviewing", "--blocked-label", "blocked",
];
const attemptArgs = [
  "--attempt-record", "/state/runs/one/attempt.json", "--project-id", "demo", "--project-repo", "/repo", "--github-repo", "owner/repo",
  "--state-dir", "/state", "--enabled-at", "1", "--review-label", "custom:review",
];

describe("direct mutation and launch entrypoint compatibility gates", () => {
  it("rejects issue coordination before Issue selection or mutation", () => {
    expect(reject("extensions/deadloop/automations/issue-coordinator-driver.ts")).toEqual({ rejected: true, githubCalled: false, agentStarted: false });
  });
  it("rejects PR review before PR selection or mutation", () => {
    expect(reject("extensions/deadloop/automations/pr-reviewer-driver.ts")).toEqual({ rejected: true, githubCalled: false, agentStarted: false });
  });
  it("rejects review-repair dispatch before GitHub reads or worker launch", () => {
    expect(reject("extensions/deadloop/automations/pr-review-repair-dispatch.ts", repairArgs)).toEqual({ rejected: true, githubCalled: false, agentStarted: false });
  });
  it("rejects review-repair completion before GitHub reads or comments", () => {
    expect(reject("extensions/deadloop/automations/pr-review-repair-complete.ts", completionArgs)).toEqual({ rejected: true, githubCalled: false, agentStarted: false });
  });
  it("rejects the native launch entrypoint before reading launch inputs or starting an agent", () => {
    expect(reject("extensions/deadloop/automations/launch-agent.ts")).toEqual({ rejected: true, githubCalled: false, agentStarted: false });
  });
  it("rejects attempt result persistence before GitHub reads or comments", () => {
    expect(reject("extensions/deadloop/automations/persist-attempt-result.ts", attemptArgs)).toEqual({ rejected: true, githubCalled: false, agentStarted: false });
  });
  it("rejects attempt workspace completion before GitHub reads or workspace closure", () => {
    expect(reject("extensions/deadloop/automations/complete-attempt-workspace.ts", attemptArgs)).toEqual({ rejected: true, githubCalled: false, agentStarted: false });
  });
  it("rejects direct cleanup apply before GitHub reads or destructive worktree removal", () => {
    expect(reject("extensions/deadloop/automations/cleanup-completed-worker-worktrees.ts", ["--apply", "--json"])).toEqual({ rejected: true, githubCalled: false, agentStarted: false });
  });
});
