import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const cleanupScript = "extensions/deadloop/automations/cleanup-completed-worker-worktrees.ts";
const driverScript = "extensions/deadloop/automations/issue-coordinator-driver.ts";

function runDriverFixture(fixtureName: string) {
  const result = spawnSync("node", [driverScript, "--fixture", path.join("test/fixtures/issue-coordinator", fixtureName)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: "/repo", DEADLOOP_GITHUB_REPO: "owner/repo" },
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

function runCleanupApply(runtimeDirectory: ".deadloop" | ".pi-subagents", tracked: boolean) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "deadloop-cleanup-runtime-"));
  try {
    const repoPath = path.join(tempRoot, "repo");
    const worktreeRoot = path.join(tempRoot, "worktrees");
    const worktreePath = path.join(worktreeRoot, "agent-issue-1-cleanup");
    const binPath = path.join(tempRoot, "bin");
    const herdrLog = path.join(tempRoot, "herdr.log");
    const runtimeFile = path.join(worktreePath, runtimeDirectory, "artifact.json");
    mkdirSync(repoPath);
    mkdirSync(path.dirname(runtimeFile), { recursive: true });
    mkdirSync(binPath);
    execFileSync("git", ["init", "-q", worktreePath]);
    writeFileSync(runtimeFile, "{}\n");
    if (tracked) {
      execFileSync("git", ["-C", worktreePath, "add", `${runtimeDirectory}/artifact.json`]);
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
      'if [ "${1:-}" = "worktree" ] && [ "${2:-}" = "list" ]; then',
      `  printf '%s\\n' '{"result":{"worktrees":[{"branch":"agent/issue-1-cleanup","is_linked_worktree":true,"open_workspace_id":"wW","path":"${worktreePath}"}]}}'`,
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "worktree" ] && [ "${2:-}" = "remove" ]; then exit 0; fi',
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

function runIssuePrecheckWithCleanupCandidate(): number | null {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "deadloop-issue-precheck-"));
  try {
    const repoPath = path.join(tempRoot, "repo");
    mkdirSync(repoPath);
    const fakeGhPath = path.join(tempRoot, "gh");
    const fakeHerdrPath = path.join(tempRoot, "herdr");
    const fakeGitPath = path.join(tempRoot, "git");

    writeExecutable(fakeGhPath, [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [ \"${1:-}\" = \"pr\" ] && [ \"${2:-}\" = \"list\" ] && [[ \" $* \" = *\" --state merged \"* ]]; then",
      "  printf '%s\n' '[{\"number\":2,\"state\":\"MERGED\",\"mergedAt\":\"2026-07-04T00:00:00Z\",\"headRefName\":\"agent/issue-1-cleanup\",\"headRefOid\":\"final\",\"labels\":[{\"name\":\"agent:review\"}]}]'",
      "  exit 0",
      "fi",
      "if [ \"${1:-}\" = \"pr\" ] && [ \"${2:-}\" = \"list\" ] && [[ \" $* \" = *\" --state closed \"* ]]; then",
      "  printf '%s\n' '[]'",
      "  exit 0",
      "fi",
      "echo \"unexpected gh invocation: $*\" >&2",
      "exit 2",
    ]);
    writeExecutable(fakeHerdrPath, [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [ \"${1:-}\" = \"worktree\" ] && [ \"${2:-}\" = \"list\" ]; then",
      "  printf '%s\n' '{\"result\":{\"worktrees\":[{\"branch\":\"agent/issue-1-cleanup\",\"is_linked_worktree\":true,\"open_workspace_id\":\"wW\",\"path\":\"/worktrees/repo/agent-issue-1-cleanup\"}]}}'",
      "  exit 0",
      "fi",
      "echo \"unexpected herdr invocation: $*\" >&2",
      "exit 2",
    ]);
    writeExecutable(fakeGitPath, [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [ \"${1:-}\" = \"-C\" ] && [ \"${3:-}\" = \"status\" ] && [ \"${4:-}\" = \"--short\" ]; then",
      "  exit 0",
      "fi",
      "echo \"unexpected git invocation: $*\" >&2",
      "exit 2",
    ]);

    const result = spawnSync("bash", ["extensions/deadloop/automations/issue-coordinator.precheck.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${tempRoot}:${process.env.PATH || ""}`,
        DEADLOOP_REPO_PATH: repoPath,
        DEADLOOP_GITHUB_REPO: "owner/repo",
        DEADLOOP_WORKTREE_ROOT: "/worktrees/repo",
        DEADLOOP_REVIEW_LABEL: "agent:review",
        DEADLOOP_HUMAN_LABEL: "ready-for-human",
      },
      encoding: "utf8",
    });

    return result.status;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("issue coordinator cleanup", () => {
  it("ignores generated deadloop artifacts when selecting cleanup candidates", () => {
    expect(runCleanupFixture("cleanup-generated-artifacts.json").candidates).toEqual([
      {
        branch: "agent/issue-1-add-safety-controls-for-dogfooding",
        path: "/worktrees/repo/agent-issue-1-add-safety-controls-for-dogfooding",
        prNumber: 2,
        reason: "merged_pr",
        workspaceId: "wW",
      },
    ]);
  });

  it("does not delete a tracked .deadloop file during cleanup", () => {
    expect(runCleanupApply(".deadloop", true).fileExists).toBe(true);
  });

  it("does not delete a tracked .pi-subagents file during cleanup", () => {
    expect(runCleanupApply(".pi-subagents", true).fileExists).toBe(true);
  });

  it("reports why tracked runtime-named files block cleanup", () => {
    expect(runCleanupApply(".deadloop", true).failure).toContain("contain tracked files");
  });

  it("does not remove the workspace when tracked runtime-named files block cleanup", () => {
    expect(runCleanupApply(".deadloop", true).removedWorkspace).toBe(false);
  });

  it("removes a workspace after deleting only untracked runtime artifacts", () => {
    expect(runCleanupApply(".pi-subagents", false).removedWorkspace).toBe(true);
  });

  it("does not select a Herdr worktree without a workspace id", () => {
    expect(runCleanupFixture("cleanup-missing-workspace.json").candidates).toEqual([]);
  });

  it("does not select the main workspace for cleanup", () => {
    expect(runCleanupFixture("cleanup-main-workspace.json").skipped[0].reason).toBe("main_workspace");
  });

  it("does not select a worktree outside the configured root", () => {
    expect(runCleanupFixture("cleanup-outside-root.json").skipped[0].reason).toBe("outside_worktree_root");
  });

  it("wakes the coordinator for cleanup when no issue is required", () => {
    expect(runIssuePrecheckWithCleanupCandidate()).toBe(0);
  });

  it("passes a unique worker agent name to deterministic launch", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.workerName).toBe("demo-issue-12-worker");
  });

  it("creates a dedicated tab before monitoring a worker", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.tabId).toBe("fixture-tab");
  });

  it("keeps worker launch out of the monitoring prompt", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).not.toContain("launch-agent.ts");
  });

  it("does not document workspace split startup for workers", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).not.toMatch(/herdr agent start[^`\n]*--workspace <workspaceId>/);
  });

  it("creates a dedicated tab before starting a review worker", () => {
    expect(readFileSync("extensions/deadloop/automations/pr-reviewer.prompt.md", "utf8")).toContain(
      'herdr tab create --workspace <workspaceId> --cwd <worktreePath> --label "$reviewer_name" --no-focus',
    );
  });

  it("forwards the dedicated tab to the launcher for review agents", () => {
    expect(readFileSync("extensions/deadloop/automations/pr-reviewer.prompt.md", "utf8")).toContain(
      '--tab "$tab_id"',
    );
  });

  it("does not document workspace split startup for review workers", () => {
    expect(readFileSync("extensions/deadloop/automations/pr-reviewer.prompt.md", "utf8")).not.toMatch(
      /herdr agent start[^`\n]*--workspace <workspaceId>/,
    );
  });

  // The claude/pi launch argv details (session id, effort, bypass permissions,
  // positional prompt) now live in the launcher and are covered by
  // test/agent-profiles.test.ts. The coordinator keeps only the uuid coupling:
  // the same uuid names the promise file and is handed to the launcher.
  it("hands the shared session uuid to the promise path", () => {
    expect(runDriverFixture("driver-ready-worker.json").launch.promiseFile).toContain("fixture-worker-uuid");
  });

  it("keeps the promise file as the worker completion authority", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain("only completion authority");
  });

  it("documents dedicated tab startup for branch update workers", () => {
    expect(readFileSync("extensions/deadloop/automations/pr-reviewer.prompt.md", "utf8")).toContain(
      "Branch-update workers also need a dedicated tab with the same label as the worker name before `herdr agent start ... --tab <tabId> --no-focus`.",
    );
  });
});
