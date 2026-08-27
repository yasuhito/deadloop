import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

const { assertWorktreeBelongsToProject } = require("../src/attempt-project-confinement.cjs");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
  return String(result.stdout || "").trim();
}

const runner = {
  runText: (argv: string[]) => {
    const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
    if (result.status !== 0) throw new Error(String(result.stderr || result.stdout));
    return String(result.stdout || "");
  },
};

function repoWithAttemptWorktree(): { repo: string; attemptWorktree: string; root: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-project-confinement-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  spawnSync("git", ["init", repo], { encoding: "utf8" });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "init");
  const attemptWorktree = path.join(root, "wt-attempt");
  git(repo, "worktree", "add", attemptWorktree, "-b", "attempt-branch");
  return { repo, attemptWorktree, root };
}

function confinementArgs(repo: string): Record<string, string> {
  return { projectId: "p1", githubRepo: "owner/repo", projectRepo: repo };
}

function attemptRecord(attemptWorktree: string): Record<string, string> {
  return { project: "p1", repository: "owner/repo", worktreePath: attemptWorktree };
}

it("proves a live attempt worktree even when another registered worktree's directory no longer exists", () => {
  const { repo, attemptWorktree, root } = repoWithAttemptWorktree();
  const staleWorktree = path.join(root, "wt-stale");
  git(repo, "worktree", "add", staleWorktree, "-b", "stale-branch");
  rmSync(staleWorktree, { recursive: true, force: true });

  const proven = assertWorktreeBelongsToProject(runner, attemptRecord(attemptWorktree), confinementArgs(repo));

  expect(proven.worktreePath).toBe(realpathSync(attemptWorktree));
});

it("still rejects an attempt worktree whose own directory no longer exists", () => {
  const { repo, attemptWorktree } = repoWithAttemptWorktree();
  rmSync(attemptWorktree, { recursive: true, force: true });

  expect(() => assertWorktreeBelongsToProject(runner, attemptRecord(attemptWorktree), confinementArgs(repo)))
    .toThrow("attempt worktree is not an existing canonical path");
});

it("still rejects an attempt worktree that the project checkout does not register", () => {
  const { attemptWorktree } = repoWithAttemptWorktree();
  const { repo: otherRepo } = repoWithAttemptWorktree();

  expect(() => assertWorktreeBelongsToProject(runner, attemptRecord(attemptWorktree), confinementArgs(otherRepo)))
    .toThrow("attempt worktree does not belong to the configured project checkout");
});
