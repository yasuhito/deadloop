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

function runStaleWorktreeDispatch(
  expectedHead: string,
  currentHead: string,
  options: {
    dirty?: boolean;
    duplicateWorktree?: boolean;
    hasWorktree?: boolean;
    initialHead?: string;
    worktreeHead?: string;
    worktreeName?: string;
  } = {},
): { output: Record<string, unknown>; ghLog: string; herdrLog: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-stale-review-repair-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  const worktree = path.join(root, options.worktreeName || "worktree");
  const worktreeHead = options.worktreeHead || currentHead;
  const promise = path.join(root, "review-promise.json");
  const ghCount = path.join(root, "gh-count");
  const ghLog = path.join(root, "gh.log");
  const herdrLog = path.join(root, "herdr.log");
  fs.mkdirSync(bin);
  fs.mkdirSync(worktree);
  fs.writeFileSync(
    promise,
    JSON.stringify({
      status: "complete",
      outcome: "changes_requested",
      reason: "",
      summary: "The reviewed worktree moved after the selected PR observation.",
      findings: [{ title: "Bound finding", body: "Repair one finding", severity: "major" }],
    }),
  );

  executable(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_GH_LOG, args.join(" ") + "\\n");
if (args[0] === "pr" && args[1] === "view") {
  const count = fs.existsSync(process.env.TEST_GH_COUNT) ? Number(fs.readFileSync(process.env.TEST_GH_COUNT, "utf8")) : 0;
  fs.writeFileSync(process.env.TEST_GH_COUNT, String(count + 1));
  const heads = [process.env.TEST_INITIAL_HEAD, process.env.TEST_CURRENT_HEAD];
  process.stdout.write(JSON.stringify({
    number:143,state:"OPEN",headRefName:"agent/issue-142-deadloop",headRefOid:heads[Math.min(count, heads.length - 1)],isCrossRepository:false,labels:[],comments:[]
  }));
}
`,
  );
  executable(
    path.join(bin, "git"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "-C" && args[2] === "worktree" && args[3] === "list") {
  if (process.env.TEST_HAS_WORKTREE === "true") {
    process.stdout.write("worktree " + process.env.TEST_WORKTREE + "\\0HEAD " + process.env.TEST_WORKTREE_HEAD + "\\0branch refs/heads/agent/issue-142-deadloop\\0\\0");
    if (process.env.TEST_DUPLICATE_WORKTREE === "true") process.stdout.write("worktree /duplicate/worktree\\0HEAD " + process.env.TEST_WORKTREE_HEAD + "\\0branch refs/heads/agent/issue-142-deadloop\\0\\0");
  }
} else if (args[0] === "-C" && args[1] === process.env.TEST_WORKTREE && args[2] === "rev-parse") {
  process.stdout.write(process.env.TEST_WORKTREE_HEAD + "\\n");
} else if (args[0] === "-C" && args[1] === process.env.TEST_WORKTREE && args[2] === "status") {
  process.stdout.write(process.env.TEST_DIRTY === "true" && args.includes("--untracked-files=all") ? "?? untracked.txt\\n" : "");
} else if (args[0] === "check-ref-format") {
  process.exit(0);
}
`,
  );
  executable(
    path.join(bin, "herdr"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.TEST_HERDR_LOG, process.argv.slice(2).join(" ") + "\\n");
const args = process.argv.slice(2);
if (args[0] === "worktree" && args[1] === "open") process.stdout.write(JSON.stringify({workspace_id:"workspace-1",path:process.env.TEST_WORKTREE}));
else if (args[0] === "tab" && args[1] === "create") process.stdout.write(JSON.stringify({tab_id:"tab-1"}));
else process.stdout.write(JSON.stringify({ok:true}));
`,
  );

  const result = spawnSync(
    "node",
    [
      "extensions/deadloop/automations/pr-review-repair-dispatch.ts",
      "--promise",
      promise,
      "--pr",
      "143",
      "--expected-head",
      expectedHead,
      "--branch",
      "agent/issue-142-deadloop",
      "--repo-path",
      root,
      "--github-repo",
      "yasuhito/deadloop",
      "--state-dir",
      path.join(root, "state"),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DEADLOOP_PROJECT_ID: "demo",
        DEADLOOP_REPO_PATH: root,
        DEADLOOP_GITHUB_REPO: "yasuhito/deadloop",
        DEADLOOP_STATE_DIR: path.join(root, "state"),
        TEST_EXPECTED_HEAD: expectedHead,
        TEST_CURRENT_HEAD: currentHead,
        TEST_DIRTY: String(Boolean(options.dirty)),
        TEST_DUPLICATE_WORKTREE: String(Boolean(options.duplicateWorktree)),
        TEST_GH_COUNT: ghCount,
        TEST_GH_LOG: ghLog,
        TEST_HAS_WORKTREE: String(options.hasWorktree !== false),
        TEST_HERDR_LOG: herdrLog,
        TEST_INITIAL_HEAD: options.initialHead || expectedHead,
        TEST_WORKTREE: worktree,
        TEST_WORKTREE_HEAD: worktreeHead,
      },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return {
    output: JSON.parse(result.stdout),
    ghLog: fs.existsSync(ghLog) ? fs.readFileSync(ghLog, "utf8") : "",
    herdrLog: fs.existsSync(herdrLog) ? fs.readFileSync(herdrLog, "utf8") : "",
  };
}

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

  it.each([
    ["8ab3a5f354dccb2d61da7e8385931c8fd5950440", "6c994aad94595aa113e8a35cc2962a9e32a7f6c8"],
    ["6c994aad94595aa113e8a35cc2962a9e32a7f6c8", "ab08360529da29cf16d5ccb109138c9a938e309d"],
  ])("returns a stale review result when the clean worktree advanced from %s", (expectedHead, currentHead) => {
    const result = runStaleWorktreeDispatch(expectedHead, currentHead);

    expect(result.output.driverAction).toBe("review_stale_head");
  });

  it("does not start Herdr when the clean worktree has advanced", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
    );

    expect(result.herdrLog).not.toContain("agent start");
  });

  it("does not mutate GitHub for an advanced clean worktree", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
    );

    expect(result.ghLog.split("\n").filter((line) => line && !line.startsWith("pr view "))).toHaveLength(0);
  });

  it("fails closed when an advanced PR has no owned worktree", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
      { hasWorktree: false },
    );

    expect(result.output.driverAction).toBe("review_repair_worktree_mismatch");
  });

  it("fails closed when an advanced PR does not match the owned worktree", () => {
    const expectedHead = "6c994aad94595aa113e8a35cc2962a9e32a7f6c8";
    const result = runStaleWorktreeDispatch(expectedHead, "ab08360529da29cf16d5ccb109138c9a938e309d", {
      worktreeHead: expectedHead,
    });

    expect(result.output.driverAction).toBe("review_repair_worktree_mismatch");
  });

  it("fails closed when the PR and clean worktree remain mismatched", () => {
    const expectedHead = "6c994aad94595aa113e8a35cc2962a9e32a7f6c8";
    const result = runStaleWorktreeDispatch(expectedHead, expectedHead, {
      worktreeHead: "ab08360529da29cf16d5ccb109138c9a938e309d",
    });

    expect(result.output.driverAction).toBe("review_repair_worktree_mismatch");
  });

  it("finds a branch worktree whose path contains a newline", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
      { worktreeName: "worktree\nodd" },
    );

    expect(result.output.driverAction).toBe("review_stale_head");
  });

  it("does not mutate GitHub when the same stale tuple is dispatched twice", () => {
    const expectedHead = "6c994aad94595aa113e8a35cc2962a9e32a7f6c8";
    const currentHead = "ab08360529da29cf16d5ccb109138c9a938e309d";
    const results = [runStaleWorktreeDispatch(expectedHead, currentHead), runStaleWorktreeDispatch(expectedHead, currentHead)];

    expect(results.flatMap((result) => result.ghLog.split("\n").filter((line) => line && !line.startsWith("pr view ")))).toHaveLength(0);
  });

  it("blocks a dirty worktree when the first PR read is already advanced", () => {
    const expectedHead = "6c994aad94595aa113e8a35cc2962a9e32a7f6c8";
    const currentHead = "ab08360529da29cf16d5ccb109138c9a938e309d";
    const result = runStaleWorktreeDispatch(expectedHead, currentHead, { dirty: true, initialHead: currentHead });

    expect(result.output.driverAction).toBe("review_repair_dirty_worktree");
  });

  it("blocks ambiguous branch worktree ownership", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
      { duplicateWorktree: true },
    );

    expect(result.output.driverAction).toBe("review_repair_ambiguous_worktree");
  });

  it("blocks an advanced dirty repair worktree", () => {
    const result = runStaleWorktreeDispatch(
      "6c994aad94595aa113e8a35cc2962a9e32a7f6c8",
      "ab08360529da29cf16d5ccb109138c9a938e309d",
      { dirty: true },
    );

    expect(result.output.driverAction).toBe("review_repair_dirty_worktree");
  });
});
