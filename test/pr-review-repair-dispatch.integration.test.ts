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
  const state = path.join(root, "state");
  const promise = path.join(root, "review-promise.json");
  const eventLog = path.join(root, "events.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(worktree);
  fs.mkdirSync(state);
  fs.writeFileSync(
    path.join(state, "enabled-projects.json"),
    JSON.stringify({
      projects: enabled
        ? [{ repoPath: root, githubRepo: "owner/repo", enabledAt: 1, enabled: true }]
        : [{ repoPath: root, githubRepo: "owner/repo", enabledAt: 1, enabled: false }],
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
if (process.argv[2] === "check-ref-format") process.exit(0);
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
        DEADLOOP_PROJECT_ID: "demo",
        DEADLOOP_REPO_PATH: root,
        DEADLOOP_GITHUB_REPO: "owner/repo",
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
  it("launches a dedicated repair worker and returns its bounded monitor", () => {
    const { output } = runDispatch(true);

    expect({ action: output.action, driverAction: output.driverAction, monitored: output.prompt.includes("review-repair worker") }).toEqual({
      action: "needs_llm",
      driverAction: "review_repair_monitor_request",
      monitored: true,
    });
  });

  it("does not mutate GitHub or launch a repair after disable", () => {
    const { output, events } = runDispatch(false);

    expect({ action: output.action, summary: output.summary, events }).toEqual({
      action: "error",
      summary: "deadloop is disabled for this repository",
      events: [],
    });
  });
});
