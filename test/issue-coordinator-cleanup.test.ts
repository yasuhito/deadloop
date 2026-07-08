import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const cleanupScript = "extensions/pi-looper/automations/cleanup-completed-worker-worktrees.py";
const driverScript = "extensions/pi-looper/automations/issue-coordinator-driver.py";

function runDriverFixture(fixtureName: string) {
  const result = spawnSync("python3", [driverScript, "--fixture", path.join("test/fixtures/issue-coordinator", fixtureName)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PI_LOOPER_PROJECT_ID: "demo", PI_LOOPER_REPO_PATH: "/repo", PI_LOOPER_GITHUB_REPO: "owner/repo" },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout);
}

function runCleanupFixture(fixtureName: string) {
  const result = spawnSync(
    "python3",
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

function runIssuePrecheckWithCleanupCandidate(): number | null {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-looper-issue-precheck-"));
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

    const result = spawnSync("bash", ["extensions/pi-looper/automations/issue-coordinator.precheck.sh"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PATH: `${tempRoot}:${process.env.PATH || ""}`,
        PI_LOOPER_REPO_PATH: repoPath,
        PI_LOOPER_GITHUB_REPO: "owner/repo",
        PI_LOOPER_WORKTREE_ROOT: "/worktrees/repo",
        PI_LOOPER_REVIEW_LABEL: "agent:review",
        PI_LOOPER_HUMAN_LABEL: "ready-for-human",
      },
      encoding: "utf8",
    });

    return result.status;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("issue coordinator cleanup", () => {
  it("selects a clean matching worktree for a merged PR", () => {
    expect(runCleanupFixture("cleanup-merged-clean.json").candidates).toEqual([
      {
        branch: "agent/issue-1-add-safety-controls-for-dogfooding",
        path: "/worktrees/repo/agent-issue-1-add-safety-controls-for-dogfooding",
        prNumber: 2,
        reason: "merged_pr",
        workspaceId: "wW",
      },
    ]);
  });

  it("does not select a dirty matching worktree", () => {
    expect(runCleanupFixture("cleanup-dirty-worktree.json").candidates).toEqual([]);
  });

  it("does not select a Herdr worktree without a workspace id", () => {
    expect(runCleanupFixture("cleanup-missing-workspace.json").candidates).toEqual([]);
  });

  it("wakes the coordinator for cleanup when no issue is required", () => {
    expect(runIssuePrecheckWithCleanupCandidate()).toBe(0);
  });

  it("passes a unique worker agent name to the launcher", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain('--name "$worker_name"');
  });

  it("creates a dedicated tab before starting a worker", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain(
      'herdr tab create --workspace <workspaceId> --cwd <worktreePath> --label "demo-issue-12-worker" --no-focus',
    );
  });

  it("forwards the dedicated tab to the launcher for workers", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain('--tab "$tab_id"');
  });

  it("does not document workspace split startup for workers", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).not.toMatch(/herdr agent start[^`\n]*--workspace <workspaceId>/);
  });

  it("creates a dedicated tab before starting a review worker", () => {
    expect(readFileSync("extensions/pi-looper/automations/pr-reviewer.prompt.md", "utf8")).toContain(
      'herdr tab create --workspace <workspaceId> --cwd <worktreePath> --label "$reviewer_name" --no-focus',
    );
  });

  it("forwards the dedicated tab to the launcher for review agents", () => {
    expect(readFileSync("extensions/pi-looper/automations/pr-reviewer.prompt.md", "utf8")).toContain(
      '--tab "$tab_id"',
    );
  });

  it("does not document workspace split startup for review workers", () => {
    expect(readFileSync("extensions/pi-looper/automations/pr-reviewer.prompt.md", "utf8")).not.toMatch(
      /herdr agent start[^`\n]*--workspace <workspaceId>/,
    );
  });

  // The claude/pi launch argv details (session id, effort, bypass permissions,
  // positional prompt) now live in the launcher and are covered by
  // test/agent-profiles.test.ts. The coordinator keeps only the uuid coupling:
  // the same uuid names the promise file and is handed to the launcher.
  it("hands the shared session uuid to the launcher", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain('--uuid "$uuid"');
  });

  it("keeps the promise file as the worker completion authority", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain("only completion authority");
  });

  it("documents dedicated tab startup for branch update workers", () => {
    expect(readFileSync("extensions/pi-looper/automations/pr-reviewer.prompt.md", "utf8")).toContain(
      "branch update worker を起動する場合も、worker 名と同じ label の専用タブを作ってから `herdr agent start ... --tab <tabId> --no-focus`",
    );
  });
});
