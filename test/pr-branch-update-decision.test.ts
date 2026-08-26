import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

const { decideBranchUpdateLive } = require("../extensions/deadloop/automations/pr-branch-update-decision.cts");

const decisionScript = "extensions/deadloop/automations/pr-branch-update-decision.cts";

function runDecisionFixture(fixtureName: string) {
  const result = spawnSync(
    "node",
    [decisionScript, "--fixture", path.join("test/fixtures/pr-branch-update", fixtureName)],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout);
}

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

/** A repository whose head is one commit behind its base, so the decision reaches the clean check. */
function behindRepository(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "deadloop-branch-update-"));
  sandboxes.push(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  execFileSync("git", ["init", "-q", repo]);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "deadloop test");
  writeFileSync(path.join(repo, "file.txt"), "base\n");
  git("add", "file.txt");
  git("commit", "-qm", "shared");
  git("branch", "feature");
  writeFileSync(path.join(repo, "file.txt"), "advanced\n");
  git("add", "file.txt");
  git("commit", "-qm", "base advances");
  git("branch", "-M", "base");
  git("checkout", "-q", "feature");
  return repo;
}

function liveReason(repo: string): string {
  return decideBranchUpdateLive(repo, "feature", "base", undefined).reason;
}

describe("PR branch update decision", () => {
  it("updates a worktree whose only untracked files are an agent scratch area", () => {
    const repo = behindRepository();
    mkdirSync(path.join(repo, ".pi", "subagents"), { recursive: true });
    writeFileSync(path.join(repo, ".pi", "subagents", "transcript.jsonl"), "{}\n");

    expect(liveReason(repo)).toBe("fast_forward");
  });

  it("blocks a worktree holding somebody else's untracked file", () => {
    const repo = behindRepository();
    writeFileSync(path.join(repo, "luac.out"), "output\n");

    expect(liveReason(repo)).toBe("dirty_worktree");
  });

  it("does not update a head that already contains the base", () => {
    expect(runDecisionFixture("no-update.json").action).toBe("no_update");
  });

  it("updates mechanically when the head can fast-forward to the base", () => {
    expect(runDecisionFixture("fast-forward.json").action).toBe("mechanical_update");
  });

  it("updates mechanically when a diverged head merges cleanly", () => {
    expect(runDecisionFixture("clean-merge.json").action).toBe("mechanical_update");
  });

  it("delegates one worker when the branch update conflicts", () => {
    expect(runDecisionFixture("conflict.json").action).toBe("delegate_worker");
  });

  it("blocks mechanical updates from a dirty worktree", () => {
    expect(runDecisionFixture("dirty-worktree.json").reason).toBe("dirty_worktree");
  });

  it("blocks mechanical updates from a stale head", () => {
    expect(runDecisionFixture("stale-head.json").reason).toBe("stale_head");
  });
});
