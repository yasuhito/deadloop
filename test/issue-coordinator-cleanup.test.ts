import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const cleanupScript = "extensions/deadloop/automations/cleanup-completed-worker-worktrees.cts";
const driverScript = "extensions/deadloop/automations/issue-coordinator-driver.cts";

// The dispatch lock writes under the state directory, so a fixture run needs one of its own rather
// than the operator's live deadloop state.
const fixtureStateDirs: string[] = [];

afterEach(() => {
  for (const stateDir of fixtureStateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

function fixtureStateDir(): string {
  const stateDir = mkdtempSync(path.join(tmpdir(), "deadloop-cleanup-state-"));
  fixtureStateDirs.push(stateDir);
  return stateDir;
}

function runDriverFixture(fixtureName: string) {
  const result = spawnSync("node", [driverScript, "--fixture", path.join("test/fixtures/issue-coordinator", fixtureName)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env, DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: "/repo",
      DEADLOOP_GITHUB_REPO: "owner/repo", DEADLOOP_STATE_DIR: fixtureStateDir(),
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout);
}

function runCleanupFixture(fixtureName: string) {
  const result = spawnSync(
    "node",
    [cleanupScript, "--fixture", `test/fixtures/issue-coordinator/${fixtureName}`, "--plan", "--json"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout);
}

function writeExecutable(filePath: string, lines: string[]) {
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  chmodSync(filePath, 0o755);
}

function runCleanupApply(scratchArea: ".pi/subagents" | ".pi/npm" | ".pi/git", tracked: boolean) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "deadloop-cleanup-runtime-"));
  try {
    const repoPath = path.join(tempRoot, "repo");
    const worktreeRoot = path.join(tempRoot, "worktrees");
    const worktreePath = path.join(worktreeRoot, "agent-issue-1-cleanup");
    const binPath = path.join(tempRoot, "bin");
    const herdrLog = path.join(tempRoot, "herdr.log");
    const runtimeFile = path.join(worktreePath, scratchArea, "artifact.json");
    mkdirSync(repoPath);
    mkdirSync(path.dirname(runtimeFile), { recursive: true });
    mkdirSync(binPath);
    execFileSync("git", ["init", "-q", worktreePath]);
    writeFileSync(runtimeFile, "{}\n");
    if (tracked) {
      execFileSync("git", ["-C", worktreePath, "add", `${scratchArea}/artifact.json`]);
      execFileSync("git", [
        "-C",
        worktreePath,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "fixture",
      ]);
    }

    writeExecutable(path.join(binPath, "gh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "list" ] && [[ " $* " = *" --state merged "* ]]; then',
      `  printf '%s\\n' '[{"number":2,"state":"MERGED","mergedAt":"2026-07-04T00:00:00Z","headRefName":"agent/issue-1-cleanup","headRefOid":"final","labels":[{"name":"agent:review"}]}]'`,
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "list" ]; then printf \'%s\\n\' \'[]\'; exit 0; fi',
      "exit 2",
    ]);
    writeExecutable(path.join(binPath, "herdr"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\\n' "$*" >> '${herdrLog}'`,
      'if [ "${1:-}" = "--version" ]; then printf \'herdr 0.8.0\\n\'; exit 0; fi',
      'if [ "${1:-} ${2:-}" = "status server" ]; then printf \'version: 0.8.0\\n\'; exit 0; fi',
      'if [ "${1:-}" = "worktree" ] && [ "${2:-}" = "list" ]; then',
      `  if [ -f '${tempRoot}/removed' ]; then printf '%s\\n' '{"result":{"worktrees":[]}}'; else printf '%s\\n' '{"result":{"worktrees":[{"branch":"agent/issue-1-cleanup","is_linked_worktree":true,"path":"${worktreePath}"}]}}'; fi`,
      "  exit 0",
      "fi",
      "exit 2",
    ]);
    writeExecutable(path.join(binPath, "git"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\\n' "$*" >> '${herdrLog}'`,
      'if [[ " $* " = *" fetch --prune "* ]]; then exit 0; fi',
      'if [[ " $* " = *" ls-files -z "* ]]; then',
      tracked ? `  printf '%s\\0' '${scratchArea}/artifact.json'` : "  true",
      "  exit 0",
      "fi",
      'if [[ " $* " = *" status --porcelain "* ]]; then',
      tracked ? "  exit 0" : `  if [ -e '${runtimeFile}' ]; then printf '%s\\n' '?? ${scratchArea}/artifact.json'; fi`,
      "  exit 0",
      "fi",
      'if [[ " $* " = *" worktree remove "* ]]; then',
      `  touch '${tempRoot}/removed'`,
      "  exit 0",
      "fi",
      "exit 2",
    ]);

    const result = spawnSync("node", [cleanupScript, "--apply", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binPath}:${process.env.PATH || ""}`,
        DEADLOOP_REPO_PATH: repoPath,
        DEADLOOP_GITHUB_REPO: "owner/repo",
        DEADLOOP_WORKTREE_ROOT: worktreeRoot,
      },
    });
    const output = JSON.parse(result.stdout);
    return {
      fileExists: existsSync(runtimeFile),
      failure: String(output.failed?.[0]?.error || ""),
      removedWorkspace: existsSync(herdrLog) && readFileSync(herdrLog, "utf8").includes("worktree remove"),
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("issue coordinator cleanup", () => {
  it("ignores agent scratch areas when selecting cleanup candidates", () => {
    expect(runCleanupFixture("cleanup-generated-artifacts.json").candidates).toEqual([
      {
        branch: "agent/issue-1-add-safety-controls-for-dogfooding",
        path: "/worktrees/repo/agent-issue-1-add-safety-controls-for-dogfooding",
        prNumber: 2,
        reason: "merged_pr",
        workspaceId: "",
      },
    ]);
  });

  it.each([".pi/subagents", ".pi/npm", ".pi/git"] as const)(
    "does not delete a tracked file in %s during cleanup",
    (scratchArea) => {
      expect(runCleanupApply(scratchArea, true).fileExists).toBe(true);
    },
  );

  it("reports why tracked files in an agent scratch area block cleanup", () => {
    expect(runCleanupApply(".pi/subagents", true).failure).toContain("contain tracked files");
  });

  it("does not remove the workspace when tracked files in an agent scratch area block cleanup", () => {
    expect(runCleanupApply(".pi/subagents", true).removedWorkspace).toBe(false);
  });

  it("removes a workspace after deleting only untracked agent scratch areas", () => {
    expect(runCleanupApply(".pi/subagents", false).removedWorkspace).toBe(true);
  });

  it("selects a closed linked worktree without fabricating a workspace id", () => {
    expect(runCleanupFixture("cleanup-missing-workspace.json").candidates).toEqual([{
      prNumber: 2,
      branch: "agent/issue-1-cleanup",
      path: "/worktrees/repo/agent-issue-1-cleanup",
      workspaceId: "",
      reason: "merged_pr",
    }]);
  });

  it("does not select the main workspace for cleanup", () => {
    expect(runCleanupFixture("cleanup-main-workspace.json").skipped[0].reason).toBe("main_workspace");
  });

  it("does not select a worktree outside the configured root", () => {
    expect(runCleanupFixture("cleanup-outside-root.json").skipped[0].reason).toBe("outside_worktree_root");
  });

  it("passes a unique worker agent name to deterministic launch", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.workerName).toBe("demo-issue-12-worker");
  });

  it("uses the created worktree root pane without adding a tab", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.rootPaneId).toBe("fixture-pane-worker");
  });

  it("registers model-free monitoring instead of a monitoring prompt", () => {
    const result = runDriverFixture("driver-ready-worker.json");

    expect({ action: result.action, prompt: result.prompt }).toEqual({ action: "monitor", prompt: undefined });
  });

  it("binds monitoring to the structured attempt journal", () => {
    const input = runDriverFixture("driver-ready-worker.json").monitorHandoff.input;

    expect(String(input.attemptRecordFile)).toMatch(/attempt\.json$/);
  });

  // The claude/pi launch argv details (session id, effort, bypass permissions,
  // positional prompt) now live in the launcher and are covered by
  // test/agent-profiles.test.ts. The coordinator keeps only the uuid coupling:
  // the same uuid names the promise file and is handed to the launcher.
  it("hands the shared session uuid to the promise path", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.promiseFile).toContain("fixture-worker-demo-12");
  });

});
