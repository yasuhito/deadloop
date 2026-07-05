import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const cleanupScript = "extensions/pi-looper/automations/cleanup-completed-worker-worktrees.py";

function runCleanupFixture(fixtureName: string) {
  const result = spawnSync(
    "python3",
    [cleanupScript, "--fixture", `test/fixtures/generic-issue-coordinator/${fixtureName}`, "--plan", "--json"],
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

    const result = spawnSync("bash", ["extensions/pi-looper/automations/generic-issue-coordinator.precheck.sh"], {
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

describe("generic issue coordinator cleanup", () => {
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

  it("starts Herdr with a unique worker agent name", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-issue-coordinator.prompt.md", "utf8")).toContain(
      'herdr agent start "{{projectId}}-issue-<N>-worker"',
    );
  });

  it("creates a dedicated tab before starting a worker", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-issue-coordinator.prompt.md", "utf8")).toContain(
      'herdr tab create --workspace <workspaceId> --cwd <worktreePath> --label "{{projectId}}-issue-<N>-worker" --no-focus',
    );
  });

  it("starts workers in the dedicated tab", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-issue-coordinator.prompt.md", "utf8")).toContain(
      'herdr agent start "{{projectId}}-issue-<N>-worker" --cwd <worktreePath> --tab <tabId> --no-focus',
    );
  });

  it("does not document workspace split startup for workers", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-issue-coordinator.prompt.md", "utf8")).not.toMatch(
      /herdr agent start[^`\n]*--workspace <workspaceId>/,
    );
  });

  it("creates a dedicated tab before starting a review worker", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-pr-reviewer.prompt.md", "utf8")).toContain(
      'herdr tab create --workspace <workspaceId> --cwd <worktreePath> --label "$reviewer_name" --no-focus',
    );
  });

  it("starts review workers in the dedicated tab", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-pr-reviewer.prompt.md", "utf8")).toContain(
      'herdr agent start "$reviewer_name" --cwd <worktreePath> --tab "$tab_id" --no-focus',
    );
  });

  it("does not document workspace split startup for review workers", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-pr-reviewer.prompt.md", "utf8")).not.toMatch(
      /herdr agent start[^`\n]*--workspace <workspaceId>/,
    );
  });

  it("documents claude worker startup with a shared session id", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-issue-coordinator.prompt.md", "utf8")).toContain(
      '-- claude --session-id "$uuid"',
    );
  });

  it("documents claude worker startup with effort levels", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-issue-coordinator.prompt.md", "utf8")).toContain(
      '--effort "$level"',
    );
  });

  it("documents claude worker startup with bypass permissions", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-issue-coordinator.prompt.md", "utf8")).toContain(
      "--permission-mode bypassPermissions",
    );
  });

  it("documents claude worker startup with positional prompt text", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-issue-coordinator.prompt.md", "utf8")).toContain(
      '"$worker_prompt_text"',
    );
  });

  it("documents separate enter sends when nudging claude workers", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-issue-coordinator.prompt.md", "utf8")).toContain(
      "herdr agent send <t> $'\\r'",
    );
  });

  it("documents dedicated tab startup for branch update workers", () => {
    expect(readFileSync("extensions/pi-looper/automations/generic-pr-reviewer.prompt.md", "utf8")).toContain(
      "branch update worker を起動する場合も、worker 名と同じ label の専用タブを作ってから `herdr agent start ... --tab <tabId> --no-focus`",
    );
  });
});
