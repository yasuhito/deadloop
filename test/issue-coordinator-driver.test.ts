import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const driverScript = "extensions/deadloop/automations/issue-coordinator-driver.ts";
const { acquireLockSync, releaseOwned } = require("../src/enablement-lock.cjs");

function runDriverFixture(fixtureName: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("node", [driverScript, "--fixture", path.join("test/fixtures/issue-coordinator", fixtureName)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEADLOOP_PROJECT_ID: "demo",
      DEADLOOP_REPO_PATH: "/repo path",
      DEADLOOP_GITHUB_REPO: "owner/repo",
      DEADLOOP_CHECK_COMMAND: "npm test",
      DEADLOOP_WORKER_AGENT: "pi",
      ...extraEnv,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout);
}

describe("issue coordinator deterministic driver", () => {
  it("skips candidate-free runs", () => {
    expect(runDriverFixture("driver-no-candidate.json").action).toBe("skip");
  });

  it("completes cleanup-only runs deterministically", () => {
    expect(runDriverFixture("driver-cleanup-candidate.json").driverAction).toBe("cleanup_applied");
  });

  it.each([
    ["starts cleanup before disable", (result: { cleanupStarted: boolean }) => result.cleanupStarted, true],
    ["completes disable while cleanup is blocked", (result: { disableCompleted: boolean }) => result.disableCompleted, true],
    ["preserves the worker artifact", (result: { artifactExists: boolean }) => result.artifactExists, true],
    ["does not remove the workspace", (result: { workspaceRemoved: boolean }) => result.workspaceRemoved, false],
  ])("%s", async (_name, observation, expected) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-cleanup-disable-"));
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "worktree");
    const artifact = path.join(worktree, ".deadloop", "run.json");
    const stateDir = path.join(root, ".pi", "agent", "deadloop");
    const binDir = path.join(root, "bin");
    const started = path.join(root, "cleanup-started");
    const release = path.join(root, "cleanup-release");
    const removed = path.join(root, "workspace-removed");
    const lockPath = path.join(stateDir, "enabled-projects.json.lock");
    const statePath = path.join(stateDir, "enabled-projects.json");
    mkdirSync(repo, { recursive: true });
    mkdirSync(path.dirname(artifact), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    spawnSync("git", ["init", "-q", worktree]);
    spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
    writeFileSync(artifact, "{}\n");
    writeFileSync(statePath, JSON.stringify({ projects: [{
      repoPath: repo, githubRepo: "owner/repo", githubRepositoryId: "R_repo", enabledAt: 1,
      firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false,
      autoMergeAcknowledged: false, enabled: true,
    }] }));
    writeFileSync(path.join(binDir, "gh"), `#!/bin/sh
if [ "$1 $2" = "pr list" ]; then
  case "$*" in
    *--state\\ merged*) printf '%s\\n' '[{"number":1,"state":"MERGED","mergedAt":"2026-07-04T00:00:00Z","headRefName":"agent/issue-1","headRefOid":"final","labels":[{"name":"agent:review"}]}]' ;;
    *) printf '%s\\n' '[]' ;;
  esac
else
  printf '%s\\n' '{"id":"R_repo"}'
fi
`);
    writeFileSync(path.join(binDir, "git"), `#!/bin/sh
if [ "$1" = "-C" ] && [ "$2" = "${repo}" ] && [ "$3 $4" = "fetch --prune" ]; then exit 0; fi
if [ "$1" = "-C" ] && [ "$2" = "${worktree}" ] && [ "$3" = "ls-files" ]; then
  touch '${started}'
  while [ ! -f '${release}' ]; do sleep 0.05; done
fi
exec /usr/bin/git "$@"
`);
    writeFileSync(path.join(binDir, "herdr"), `#!/bin/sh
if [ "$1 $2" = "worktree list" ]; then
  printf '%s\\n' '{"result":{"worktrees":[{"branch":"agent/issue-1","is_linked_worktree":true,"open_workspace_id":"w1","path":"${worktree}"}]}}'
  exit 0
fi
if [ "$1 $2" = "worktree remove" ]; then touch '${removed}'; exit 0; fi
exit 2
`);
    for (const command of ["gh", "git", "herdr"]) chmodSync(path.join(binDir, command), 0o755);

    const child = spawn(process.execPath, [path.resolve(driverScript)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        PI_CODING_AGENT_DIR: path.join(root, ".pi", "agent"),
        DEADLOOP_REPO_PATH: repo,
        DEADLOOP_GITHUB_REPO: "owner/repo",
        DEADLOOP_ENABLED_AT: "1",
        DEADLOOP_STATE_DIR: stateDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      for (let attempt = 0; attempt < 100 && !existsSync(started); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      let disableCompleted = false;
      try {
        const lock = acquireLockSync(lockPath, { attempts: 8, delayMs: 10 });
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        state.projects[0].enabled = false;
        writeFileSync(statePath, JSON.stringify(state));
        releaseOwned(lockPath, lock.token);
        disableCompleted = true;
      } catch {}
      writeFileSync(release, "release");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));

      expect(observation({
        cleanupStarted: existsSync(started),
        disableCompleted,
        artifactExists: existsSync(artifact),
        workspaceRemoved: existsSync(removed),
      })).toBe(expected);
    } finally {
      writeFileSync(release, "release");
      child.kill("SIGKILL");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("handles contract-missing issues without an LLM prompt", () => {
    expect(runDriverFixture("driver-contract-missing.json").driverAction).toBe("contract_missing");
  });

  it("renders contract-missing guidance", () => {
    expect(runDriverFixture("driver-contract-missing.json").comment).toContain("Acceptance criteria");
  });

  it("renders blocked comments for planning issues", () => {
    expect(runDriverFixture("driver-blocked-prd.json").comment).toContain("## Recovery steps");
  });

  it("does not block implementable issues that only reference a PRD document path", () => {
    expect(runDriverFixture("driver-prd-doc-reference.json").driverAction).toBe("worker_monitor_request");
  });

  it("reports the deterministic Worker name", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.workerName).toBe("demo-issue-12-worker");
  });

  it("persists the launch-time issue title for monitor revalidation", () => {
    expect(runDriverFixture("driver-ready-worker.json").monitorHandoff.input.issueTitle).toBe("Implement small feature");
  });

  it("persists the launch-time issue body for monitor revalidation", () => {
    expect(runDriverFixture("driver-ready-worker.json").monitorHandoff.input.issueBody).toContain("Build a focused feature.");
  });

  it("does not ask the LLM to run launch-agent", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).not.toContain("launch-agent.ts");
  });

  it("keeps promise files as the worker completion authority", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain("only completion authority");
  });

  it("reports the deterministic worker promise path outside the worktree", () => {
    expect(
      runDriverFixture("driver-ready-worker.json", { DEADLOOP_STATE_DIR: "/state/deadloop" }).launch.promiseFile,
    ).toBe("/state/deadloop/runs/fixture-worker-uuid/promise.json");
  });

  it("isolates runtime artifacts during monitor validation", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain("run-project-check.ts");
  });

  it("preserves the validation gate before PR creation", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain("before creating any PR");
  });

  it("receives worker agent settings from the shared automation environment", () => {
    expect(readFileSync("src/core.ts", "utf8")).toContain("DEADLOOP_WORKER_AGENT");
  });

  it("receives worker model settings from the shared automation environment", () => {
    expect(readFileSync("src/core.ts", "utf8")).toContain("DEADLOOP_WORKER_MODEL");
  });

  it("uses the TypeScript renderer for blocked comments", () => {
    expect(readFileSync(driverScript, "utf8")).toContain("renderIssueBlockedComment");
  });
});
