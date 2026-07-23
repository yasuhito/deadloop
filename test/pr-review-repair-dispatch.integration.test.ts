import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function executable(file: string, content: string): void {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function runDispatch(enabled: boolean): { output: Record<string, any>; events: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-repair-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  const worktree = path.join(root, "worktree");
  const configDir = path.join(root, "config");
  const state = path.join(configDir, "deadloop");
  const promise = path.join(root, "review-promise.json");
  const eventLog = path.join(root, "events.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(worktree);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(
    path.join(state, "enabled-projects.json"),
    JSON.stringify({
      projects: [{
        repoPath: root,
        githubRepo: "owner/repo",
        enabledAt: 1,
        firstEnableAutoMerge: false,
        firstStartPending: false,
        lastObservedAutoMerge: false,
        autoMergeAcknowledged: false,
        enabled,
      }],
    }),
  );
  fs.writeFileSync(
    promise,
    JSON.stringify({
      status: "complete",
      outcome: "changes_requested",
      reason: "",
      summary: "A lint contract finding needs repair.",
      findings: [{ title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" }],
    }),
  );

  executable(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:"${"a".repeat(40)}",isCrossRepository:false,labels:[],comments:[]
}));
else fs.appendFileSync(process.env.EVENT_LOG, "github-mutation\\n");
`,
  );
  executable(
    path.join(bin, "git"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("get-url")) process.stdout.write("https://github.com/owner/repo.git\\n");
process.exit(0);
`,
  );
  executable(
    path.join(bin, "herdr"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.EVENT_LOG, "agent-launch\\n");
const args = process.argv.slice(2);
if (args[0] === "worktree" && args[1] === "open") process.stdout.write(JSON.stringify({workspace_id:"workspace-1",path:process.env.TEST_WORKTREE}));
else if (args[0] === "agent" && args[1] === "list") process.stdout.write(JSON.stringify({result:{agents:[]}}));
else if (args[0] === "tab" && args[1] === "create") process.stdout.write(JSON.stringify({tab_id:"tab-1"}));
else if (args[0] === "agent" && args[1] === "start") process.stdout.write(JSON.stringify({ok:true}));
`,
  );

  const result = spawnSync(
    "node",
    [
      "extensions/deadloop/automations/pr-review-repair-dispatch.ts",
      "--promise",
      promise,
      "--pr",
      "243",
      "--expected-head",
      "a".repeat(40),
      "--branch",
      "agent/issue-243",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        PI_CODING_AGENT_DIR: configDir,
        DEADLOOP_PROJECT_ID: "demo",
        DEADLOOP_REPO_PATH: root,
        DEADLOOP_GITHUB_REPO: "owner/repo",
        DEADLOOP_ENABLED_AT: "1",
        DEADLOOP_STATE_DIR: state,
        TEST_WORKTREE: worktree,
        EVENT_LOG: eventLog,
      },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return {
    output: JSON.parse(result.stdout),
    events: fs.existsSync(eventLog) ? fs.readFileSync(eventLog, "utf8").trim().split("\n").filter(Boolean) : [],
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("review repair dispatch integration", () => {
  it("requests LLM monitoring after launching a repair", () => {
    expect(runDispatch(true).output.action).toBe("needs_llm");
  });

  it("identifies the bounded repair monitor action", () => {
    expect(runDispatch(true).output.driverAction).toBe("review_repair_monitor_request");
  });

  it("returns the dedicated repair monitor prompt", () => {
    expect(runDispatch(true).output.prompt).toContain("review-repair worker");
  });

  it("returns an error after disable", () => {
    expect(runDispatch(false).output.action).toBe("error");
  });

  it("reports disable as the dispatch failure", () => {
    expect(runDispatch(false).output.summary).toBe("deadloop is disabled for this repository");
  });

  it("does not mutate GitHub or launch a repair after disable", () => {
    expect(runDispatch(false).events).toEqual([]);
  });
});
