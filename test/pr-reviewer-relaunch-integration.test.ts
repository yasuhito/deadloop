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

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("PR reviewer relaunch integration", () => {
  it("retires the finished reviewer before relaunching the same PR after it is requeued", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-reviewer-relaunch-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    const worktree = path.join(root, "worktree");
    const state = path.join(root, "state");
    const log = path.join(root, "herdr.log");
    fs.mkdirSync(bin);
    fs.mkdirSync(worktree);

    executable(
      path.join(bin, "gh"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{
    number: 44,
    title: "Requeued review",
    url: "https://github.com/owner/repo/pull/44",
    headRefName: "agent/issue-44-fix",
    headRefOid: "feed44",
    updatedAt: "2026-07-13T00:00:00Z",
    isDraft: false,
    labels: [{name: "agent:review"}],
    statusCheckRollup: [],
    comments: [],
    reviewRequests: []
  }]));
}
`,
    );
    executable(
      path.join(bin, "herdr"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_TEST_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "agent" && args[1] === "list") {
  process.stdout.write(JSON.stringify({result:{agents:[{
    name:"demo-pr-44-reviewer", agent_status:"Done", cwd:process.env.HERDR_TEST_WORKTREE, pane_id:"pane-old"
  }]}}));
} else if (args[0] === "worktree" && args[1] === "open") {
  process.stdout.write(JSON.stringify({workspace_id:"workspace-1", path:process.env.HERDR_TEST_WORKTREE}));
} else if (args[0] === "tab" && args[1] === "create") {
  process.stdout.write(JSON.stringify({tab_id:"tab-new"}));
}
`,
    );

    const result = spawnSync("node", ["extensions/deadloop/automations/pr-reviewer-driver.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DEADLOOP_PROJECT_ID: "demo",
        DEADLOOP_REPO_PATH: root,
        DEADLOOP_GITHUB_REPO: "owner/repo",
        DEADLOOP_STATE_DIR: state,
        HERDR_TEST_LOG: log,
        HERDR_TEST_WORKTREE: worktree,
      },
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);

    const actions = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .map((args) => args.slice(0, args[0] === "pane" || (args[0] === "agent" && args[1] === "start") ? 3 : 2).join(" "));

    expect(actions).toEqual([
      "agent list",
      "worktree open",
      "agent list",
      "pane close pane-old",
      "tab create",
      "agent start demo-pr-44-reviewer",
    ]);
  });
});
