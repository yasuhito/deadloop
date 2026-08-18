import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { alignOpenedCheckout } = require("../src/checkout-alignment.ts");

const branch = "agent/issue-203-task";
const ref = `refs/heads/${branch}`;
const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commit(repo: string, text: string): string {
  writeFileSync(path.join(repo, "file.txt"), `${text}\n`);
  git(repo, ["add", "file.txt"]);
  git(repo, ["commit", "--quiet", "-m", text]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/**
 * A checkout left behind the branch tip, exactly as a retained attempt leaves it: the remote moved
 * on while the linked worktree stayed where its own attempt stopped.
 */
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-checkout-align-"));
  sandboxes.push(root);
  const origin = path.join(root, "origin.git");
  const author = path.join(root, "author");
  const checkout = path.join(root, "checkout");
  execFileSync("git", ["init", "--quiet", "--bare", origin]);
  mkdirSync(author);
  git(author, ["init", "--quiet"]);
  git(author, ["checkout", "--quiet", "-b", branch]);
  git(author, ["config", "user.email", "test@example.com"]);
  git(author, ["config", "user.name", "Test"]);
  const behindHead = commit(author, "behind");
  execFileSync("git", ["-C", author, "push", "--quiet", origin, `${behindHead}:${ref}`]);
  execFileSync("git", ["clone", "--quiet", "--branch", branch, origin, checkout]);
  git(checkout, ["config", "user.email", "test@example.com"]);
  git(checkout, ["config", "user.name", "Test"]);
  const expectedHead = commit(author, "ahead");
  execFileSync("git", ["-C", author, "push", "--quiet", origin, `${expectedHead}:${ref}`]);
  return { checkout, behindHead, expectedHead };
}

function align(checkout: string, expectedHead: string) {
  alignOpenedCheckout({ worktreePath: checkout, expectedHead, remote: "origin", branch });
}

describe("opened checkout alignment", () => {
  it("fast-forwards a clean checkout to the revision the attempt is bound to", () => {
    const { checkout, expectedHead } = fixture();
    align(checkout, expectedHead);

    expect(git(checkout, ["rev-parse", "HEAD"])).toBe(expectedHead);
  });

  it("leaves a checkout that already carries the expected head alone", () => {
    const { checkout, expectedHead } = fixture();
    align(checkout, expectedHead);
    const reflogBefore = git(checkout, ["reflog", "--format=%H"]);
    align(checkout, expectedHead);

    expect(git(checkout, ["reflog", "--format=%H"])).toBe(reflogBefore);
  });

  it("keeps the branch on its own commits by refusing a checkout it cannot fast-forward", () => {
    const { checkout, expectedHead } = fixture();
    const diverged = commit(checkout, "local only");

    try { align(checkout, expectedHead); } catch {}

    expect(git(checkout, ["rev-parse", "HEAD"])).toBe(diverged);
  });

  it("refuses a checkout it cannot fast-forward", () => {
    const { checkout, expectedHead } = fixture();
    commit(checkout, "local only");

    expect(() => align(checkout, expectedHead)).toThrow("cannot fast-forward");
  });

  it("refuses a checkout with uncommitted work", () => {
    const { checkout, expectedHead } = fixture();
    writeFileSync(path.join(checkout, "file.txt"), "uncommitted\n");

    expect(() => align(checkout, expectedHead)).toThrow("uncommitted");
  });

  it("keeps uncommitted work when it refuses", () => {
    const { checkout, expectedHead } = fixture();
    writeFileSync(path.join(checkout, "file.txt"), "uncommitted\n");

    try { align(checkout, expectedHead); } catch {}

    expect(git(checkout, ["status", "--porcelain"])).toBe("M file.txt");
  });

  it("aligns a checkout whose only untracked files are an agent scratch area", () => {
    const { checkout, expectedHead } = fixture();
    mkdirSync(path.join(checkout, ".pi", "subagents"), { recursive: true });
    writeFileSync(path.join(checkout, ".pi", "subagents", "transcript.jsonl"), "{}\n");
    align(checkout, expectedHead);

    expect(git(checkout, ["rev-parse", "HEAD"])).toBe(expectedHead);
  });

  it("refuses a checkout whose scratch area holds a tracked change", () => {
    const { checkout, expectedHead } = fixture();
    mkdirSync(path.join(checkout, ".pi", "subagents"), { recursive: true });
    writeFileSync(path.join(checkout, ".pi", "subagents", "report.md"), "first\n");
    git(checkout, ["add", ".pi/subagents/report.md"]);
    git(checkout, ["commit", "--quiet", "-m", "track scratch report"]);
    writeFileSync(path.join(checkout, ".pi", "subagents", "report.md"), "edited\n");

    expect(() => align(checkout, expectedHead)).toThrow("uncommitted");
  });

  it("refuses a revision the remote branch does not carry", () => {
    const { checkout } = fixture();
    const absent = "0".repeat(39) + "1";

    expect(() => align(checkout, absent)).toThrow("does not carry");
  });

  it("refuses a revision that is not a commit identifier", () => {
    const { checkout } = fixture();

    expect(() => align(checkout, "HEAD")).toThrow("commit");
  });
});
