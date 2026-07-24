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

describe("review repair dispatch integration", () => {
  it("launches a dedicated repair worker and returns its bounded monitor", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-repair-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    const worktree = path.join(root, "worktree");
    const state = path.join(root, "state");
    const promise = path.join(root, "review-promise.json");
    fs.mkdirSync(bin);
    fs.mkdirSync(worktree);
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
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:"${"a".repeat(40)}",isCrossRepository:false,labels:[],comments:[]
}));
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
        },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);

    expect({ action: output.action, driverAction: output.driverAction, monitored: output.prompt.includes("review-repair worker") }).toEqual({
      action: "needs_llm",
      driverAction: "review_repair_monitor_request",
      monitored: true,
    });
  });

  it("recovers a crash-window retry from the active Herdr worker when local launch evidence is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-repair-active-recovery-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    const state = path.join(root, "state");
    const worktree = path.join(root, "worktree");
    const promise = path.join(root, "review-promise.json");
    const launchAttempted = path.join(root, "launch-attempted");
    const head = "a".repeat(40);
    const finding = { title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" };
    const { renderRepairMarker, reviewResultFingerprint } = require("../extensions/deadloop/automations/pr-review-repair-state.ts");
    const fingerprint = reviewResultFingerprint([finding]);
    const marker = renderRepairMarker(head, fingerprint);
    const attemptKey = marker.match(/key=([0-9a-f]+)/)?.[1];
    fs.mkdirSync(bin);
    fs.mkdirSync(worktree);
    fs.writeFileSync(
      promise,
      JSON.stringify({ status: "complete", outcome: "changes_requested", reason: "", summary: "Repair it.", findings: [finding] }),
    );
    executable(
      path.join(bin, "gh"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:"${head}",isCrossRepository:false,labels:[{name:"agent:reviewing"}],comments:[{body:${JSON.stringify(marker)}}]
}));
`,
    );
    executable(
      path.join(bin, "herdr"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "worktree" && args[1] === "list") process.stdout.write(JSON.stringify({result:{worktrees:[{branch:"agent/issue-243",path:process.env.TEST_WORKTREE}]}}));
else if (args[0] === "agent" && args[1] === "list") process.stdout.write(JSON.stringify({result:{agents:[{name:"demo-pr-243-review-repair-${attemptKey}",agent_status:"working",cwd:process.env.TEST_WORKTREE,pane_id:"pane-1"}]}}));
else if (args[0] === "agent" && args[1] === "start") fs.writeFileSync(process.env.LAUNCH_ATTEMPTED, "yes");
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
        head,
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
          LAUNCH_ATTEMPTED: launchAttempted,
        },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);

    expect({ driverAction: output.driverAction, launchAttempted: fs.existsSync(launchAttempted) }).toEqual({
      driverAction: "review_repair_duplicate",
      launchAttempted: false,
    });
  });

  it("recovers a marker-only retry when no launch evidence exists", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-repair-marker-only-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    const state = path.join(root, "state");
    const promise = path.join(root, "review-promise.json");
    const herdrCalled = path.join(root, "herdr-called");
    const head = "a".repeat(40);
    const finding = { title: "Lint contract", body: "Format src/a.ts", path: "src/a.ts", severity: "major" };
    const { renderRepairMarker, reviewResultFingerprint } = require("../extensions/deadloop/automations/pr-review-repair-state.ts");
    const marker = renderRepairMarker(head, reviewResultFingerprint([finding]));
    fs.mkdirSync(bin);
    fs.writeFileSync(
      promise,
      JSON.stringify({ status: "complete", outcome: "changes_requested", reason: "", summary: "Repair it.", findings: [finding] }),
    );
    executable(
      path.join(bin, "gh"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "pr" && args[1] === "view") process.stdout.write(JSON.stringify({
  number:243,state:"OPEN",headRefName:"agent/issue-243",headRefOid:"${head}",isCrossRepository:false,labels:[{name:"agent:reviewing"}],comments:[{body:${JSON.stringify(marker)}}]
}));
`,
    );
    executable(path.join(bin, "herdr"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "worktree" && args[1] === "list") process.stdout.write(JSON.stringify({result:{worktrees:[]}}));
else if (args[0] === "agent" && args[1] === "list") process.stdout.write(JSON.stringify({result:{agents:[]}}));
else if (args[0] === "agent" && args[1] === "start") fs.writeFileSync(process.env.HERDR_CALLED, "yes");
`);

    const result = spawnSync(
      "node",
      [
        "extensions/deadloop/automations/pr-review-repair-dispatch.ts",
        "--promise",
        promise,
        "--pr",
        "243",
        "--expected-head",
        head,
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
          HERDR_CALLED: herdrCalled,
        },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);

    expect({ driverAction: output.driverAction, launchAttempted: fs.existsSync(herdrCalled) }).toEqual({
      driverAction: "review_repair_dispatch_interrupted",
      launchAttempted: false,
    });
  });

  it("human-blocks when the attempt comment succeeds but label mutation fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-repair-label-failure-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    const state = path.join(root, "state");
    const promise = path.join(root, "review-promise.json");
    const editCount = path.join(root, "edit-count");
    const herdrCalled = path.join(root, "herdr-called");
    fs.mkdirSync(bin);
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
if (args[0] === "pr" && args[1] === "edit") {
  const count = fs.existsSync(process.env.EDIT_COUNT) ? Number(fs.readFileSync(process.env.EDIT_COUNT, "utf8")) : 0;
  fs.writeFileSync(process.env.EDIT_COUNT, String(count + 1));
  if (count === 0) process.exit(1);
}
`,
    );
    executable(
      path.join(bin, "herdr"),
      `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.HERDR_CALLED, "yes");
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
          EDIT_COUNT: editCount,
          HERDR_CALLED: herdrCalled,
        },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);

    expect({ driverAction: output.driverAction, launchAttempted: fs.existsSync(herdrCalled) }).toEqual({
      driverAction: "review_repair_launch_failed",
      launchAttempted: false,
    });
  });
});
