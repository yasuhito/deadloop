import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const {
  AGENT_SCRATCH_AREAS,
  UNCOMMITTED_WORK_STATUS_ARGS,
  hasUncommittedWork,
} = require("../src/agent-scratch-area.ts");

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

/** A worktree holding `files`, with `tracked` committed and everything else left untracked. */
function worktree(files: Record<string, string>, tracked: string[] = []): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-scratch-area-"));
  sandboxes.push(root);
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "deadloop test"]);
  writeFileSync(path.join(root, "README.md"), "seed\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "seed"]);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  if (tracked.length) {
    execFileSync("git", ["-C", root, "add", "--", ...tracked]);
    execFileSync("git", ["-C", root, "commit", "-qm", "track"]);
  }
  return root;
}

function uncommittedWork(root: string): boolean {
  return hasUncommittedWork(execFileSync("git", ["-C", root, ...UNCOMMITTED_WORK_STATUS_ARGS], { encoding: "utf8" }));
}

describe("agent scratch areas are not uncommitted work", () => {
  it.each(AGENT_SCRATCH_AREAS)("ignores an untracked file the agent CLI left in %s", (scratchArea: string) => {
    expect(uncommittedWork(worktree({ [`${scratchArea}/artifact.json`]: "{}\n" }))).toBe(false);
  });

  it("ignores a scratch file whose name git has to quote", () => {
    expect(uncommittedWork(worktree({ ".pi/subagents/artifacts/報告.md": "done\n" }))).toBe(false);
  });

  it("counts a shared project resource stored beside the scratch areas", () => {
    expect(uncommittedWork(worktree({ ".pi/settings.json": "{}\n" }))).toBe(true);
  });

  it("counts a shared project resource hidden behind an otherwise untracked scratch area", () => {
    // `git status --short` collapses a fully untracked `.pi/` to one line, which
    // cannot be told apart from a scratch area on its own.
    expect(uncommittedWork(worktree({ ".pi/settings.json": "{}\n", ".pi/subagents/artifact.json": "{}\n" }))).toBe(true);
  });

  it("counts a tracked change under a scratch area", () => {
    const root = worktree({ ".pi/subagents/report.md": "first\n" }, [".pi/subagents/report.md"]);
    writeFileSync(path.join(root, ".pi", "subagents", "report.md"), "edited\n");
    expect(uncommittedWork(root)).toBe(true);
  });

  it("counts the layout an older agent CLI wrote", () => {
    expect(uncommittedWork(worktree({ ".pi-subagents/artifacts/log": "runtime\n" }))).toBe(true);
  });

  it("counts the worktree directory deadloop itself no longer writes", () => {
    expect(uncommittedWork(worktree({ ".deadloop/promise.json": "{}\n" }))).toBe(true);
  });

  it("counts an ordinary untracked file", () => {
    expect(uncommittedWork(worktree({ "luac.out": "output\n" }))).toBe(true);
  });

  it("counts an ordinary modification", () => {
    const root = worktree({});
    writeFileSync(path.join(root, "README.md"), "edited\n");
    expect(uncommittedWork(root)).toBe(true);
  });

  it("reports a clean worktree as having no uncommitted work", () => {
    expect(uncommittedWork(worktree({}))).toBe(false);
  });

  it("treats a path named like a scratch area but held as a file as uncommitted work", () => {
    expect(uncommittedWork(worktree({ ".pi/npm": "not a directory\n" }))).toBe(true);
  });
});
