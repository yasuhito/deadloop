import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

const { loadFixtureCleanupPlan } = require("../../extensions/deadloop/automations/cleanup-completed-worker-worktrees.ts");

type CleanupPlan = { candidates: unknown[] };
type CleanupWorld = { fixtureName?: string; plan?: CleanupPlan; trackedFileExists?: boolean; trackedWorktree?: boolean };

const cleanupScript = "extensions/deadloop/automations/cleanup-completed-worker-worktrees.ts";
const fixtureDirectory = path.join("test", "fixtures", "issue-coordinator");

function planFromFixture(fixtureName: string): CleanupPlan {
  return loadFixtureCleanupPlan(path.join(fixtureDirectory, fixtureName));
}

function writeExecutable(filePath: string, lines: string[]): void {
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  chmodSync(filePath, 0o755);
}

function trackedFileSurvivesCleanup(): boolean {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "deadloop-acceptance-cleanup-"));
  try {
    const repoPath = path.join(tempRoot, "repo");
    const worktreeRoot = path.join(tempRoot, "worktrees");
    const worktreePath = path.join(worktreeRoot, "agent-issue-1-cleanup");
    const binPath = path.join(tempRoot, "bin");
    const runtimeFile = path.join(worktreePath, ".deadloop", "artifact.json");
    mkdirSync(repoPath);
    mkdirSync(path.dirname(runtimeFile), { recursive: true });
    mkdirSync(binPath);
    execFileSync("git", ["init", "-q", worktreePath]);
    writeFileSync(runtimeFile, "{}\n");
    execFileSync("git", ["-C", worktreePath, "add", ".deadloop/artifact.json"]);
    execFileSync("git", ["-C", worktreePath, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"]);

    writeExecutable(path.join(binPath, "gh"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "list" ] && [[ " $* " = *" --state merged "* ]]; then',
      "  printf '%s\\n' '[{\"number\":2,\"state\":\"MERGED\",\"mergedAt\":\"2026-07-04T00:00:00Z\",\"headRefName\":\"agent/issue-1-cleanup\",\"headRefOid\":\"final\",\"labels\":[{\"name\":\"agent:review\"}]}]'",
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "pr" ] && [ "${2:-}" = "list" ]; then printf \'%s\\n\' \'[]\'; exit 0; fi',
      "exit 2",
    ]);
    writeExecutable(path.join(binPath, "herdr"), [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "${1:-}" = "worktree" ] && [ "${2:-}" = "list" ]; then',
      `  printf '%s\\n' '{"result":{"worktrees":[{"branch":"agent/issue-1-cleanup","is_linked_worktree":true,"open_workspace_id":"wW","path":"${worktreePath}"}]}}'`,
      "  exit 0",
      "fi",
      'if [ "${1:-}" = "worktree" ] && [ "${2:-}" = "remove" ]; then exit 0; fi',
      "exit 2",
    ]);

    const cleanupResult = spawnSync("node", [cleanupScript, "--apply", "--json"], {
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
    if (cleanupResult.error) throw cleanupResult.error;
    if (cleanupResult.status !== 0 && cleanupResult.status !== 1) {
      throw new Error(`cleanup command failed with status ${cleanupResult.status}: ${cleanupResult.stderr}`);
    }
    try {
      JSON.parse(cleanupResult.stdout);
    } catch {
      throw new Error(`cleanup command returned invalid JSON: ${cleanupResult.stderr || cleanupResult.stdout}`);
    }
    return existsSync(runtimeFile);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

Given("マージ済みで変更のない deadloop の作業場所がある", function (this: CleanupWorld) {
  this.fixtureName = "cleanup-merged-clean.json";
});

Given("変更中のマージ済み deadloop 作業場所がある", function (this: CleanupWorld) {
  this.fixtureName = "cleanup-dirty-worktree.json";
});

Given("Git 管理ファイルを含むマージ済み deadloop 作業場所がある", function (this: CleanupWorld) {
  this.trackedWorktree = true;
});

Given("別のリポジトリにあるマージ済み deadloop 作業場所がある", function (this: CleanupWorld) {
  this.fixtureName = "cleanup-outside-root.json";
});

Given("未マージの pull request に対応する deadloop 作業場所がある", function (this: CleanupWorld) {
  this.fixtureName = "cleanup-unmerged.json";
});

When("deadloop が片付けを開始する", function (this: CleanupWorld) {
  if (this.trackedWorktree) {
    this.trackedFileExists = trackedFileSurvivesCleanup();
    return;
  }
  if (!this.fixtureName) throw new Error("cleanup precondition is missing");
  this.plan = planFromFixture(this.fixtureName);
});

Then("その作業場所は片付け候補になる", function (this: CleanupWorld) {
  assert.equal(this.plan?.candidates.length, 1);
});

Then("その作業場所は片付け候補にならない", function (this: CleanupWorld) {
  assert.equal(this.plan?.candidates.length, 0);
});

Then("その作業場所の Git 管理ファイルは残る", function (this: CleanupWorld) {
  assert.equal(this.trackedFileExists, true);
});
