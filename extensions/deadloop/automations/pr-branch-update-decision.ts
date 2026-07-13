#!/usr/bin/env node
// Decide whether a PR branch can be updated mechanically or needs one worker.
// CommonJS-shaped so it can run directly with `node pr-branch-update-decision.ts`.

const fs = require("node:fs") as typeof import("node:fs");
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");

type BranchUpdateDecision = Record<string, any>;

function runGitForBranchUpdate(repo: string, args: string[], options: { check?: boolean } = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (options.check !== false && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git failed: ${args.join(" ")}`).trim());
  }
  return result;
}

function countCommitsForBranchUpdate(repo: string, revRange: string): number {
  const output = runGitForBranchUpdate(repo, ["rev-list", "--count", revRange]).stdout.trim();
  return Number(output || 0);
}

function mergeTreeIsClean(repo: string, headRef: string, baseRef: string): boolean {
  return runGitForBranchUpdate(repo, ["merge-tree", "--write-tree", headRef, baseRef], { check: false }).status === 0;
}

function worktreeIsClean(repo: string): boolean {
  return runGitForBranchUpdate(repo, ["status", "--short"]).stdout.trim() === "";
}

function revParseForBranchUpdate(repo: string, ref: string): string {
  return runGitForBranchUpdate(repo, ["rev-parse", "--verify", ref]).stdout.trim();
}

function decideBranchUpdate(
  ahead: number,
  behind: number,
  conflictFree: boolean,
  cleanWorktree = true,
  headMatchesExpected = true,
): BranchUpdateDecision {
  const diverged = ahead > 0 && behind > 0;
  let action: string;
  let reason: string;
  if (!cleanWorktree) {
    action = "blocked";
    reason = "dirty_worktree";
  } else if (!headMatchesExpected) {
    action = "blocked";
    reason = "stale_head";
  } else if (behind <= 0) {
    action = "no_update";
    reason = "head_contains_base";
  } else if (conflictFree) {
    action = "mechanical_update";
    reason = ahead === 0 ? "fast_forward" : "clean_merge";
  } else {
    action = "delegate_worker";
    reason = "merge_conflict";
  }

  return {
    action,
    reason,
    ahead,
    behind,
    diverged,
    conflictFree,
    cleanWorktree,
    headMatchesExpected,
  };
}

function decideBranchUpdateLive(
  repo: string,
  headRef: string,
  baseRef: string,
  expectedHeadRef: string | undefined,
  options: { requireCleanWorktree?: boolean } = {},
): BranchUpdateDecision {
  const headOid = revParseForBranchUpdate(repo, headRef);
  runGitForBranchUpdate(repo, ["rev-parse", "--verify", baseRef]);
  const expectedHeadOid = expectedHeadRef ? revParseForBranchUpdate(repo, expectedHeadRef) : headOid;
  const ahead = countCommitsForBranchUpdate(repo, `${baseRef}..${headRef}`);
  const behind = countCommitsForBranchUpdate(repo, `${headRef}..${baseRef}`);
  const conflictFree = behind <= 0 || mergeTreeIsClean(repo, headRef, baseRef);
  const cleanWorktree = options.requireCleanWorktree === false ? true : worktreeIsClean(repo);
  return {
    ...decideBranchUpdate(ahead, behind, conflictFree, cleanWorktree, headOid === expectedHeadOid),
    headRef,
    baseRef,
    headOid,
    expectedHeadRef: expectedHeadRef ?? null,
    expectedHeadOid,
  };
}

function boolFromFixtureForBranchUpdate(value: unknown, defaultValue: boolean): boolean {
  return value === undefined ? defaultValue : Boolean(value);
}

function decideBranchUpdateFixture(file: string): BranchUpdateDecision {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return decideBranchUpdate(
    Number(data.ahead || 0),
    Number(data.behind || 0),
    boolFromFixtureForBranchUpdate(data.conflictFree, true),
    boolFromFixtureForBranchUpdate(data.cleanWorktree, true),
    boolFromFixtureForBranchUpdate(data.headMatchesExpected, true),
  );
}

function requiredBranchUpdateValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseBranchUpdateArgs(argv: string[]): BranchUpdateDecision {
  const parsed: BranchUpdateDecision = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (["--repo", "--head", "--base", "--fixture", "--expected-head-ref"].includes(token)) {
      const key = token.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
      parsed[key] = requiredBranchUpdateValue(argv, index, token);
      index += 1;
      continue;
    }
    throw new Error(`unknown flag: ${token}`);
  }
  return parsed;
}

function branchUpdateHelp(): string {
  return [
    "Usage: pr-branch-update-decision.ts --fixture FILE",
    "   or: pr-branch-update-decision.ts --repo PATH --head REF --base REF [--expected-head-ref REF]",
  ].join("\n");
}

function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseBranchUpdateArgs(argv);
  if (args.help) {
    process.stdout.write(`${branchUpdateHelp()}\n`);
    return 0;
  }
  const decision = args.fixture
    ? decideBranchUpdateFixture(args.fixture)
    : (() => {
        if (!args.repo || !args.head || !args.base) throw new Error("--repo, --head, and --base are required unless --fixture is used");
        return decideBranchUpdateLive(args.repo, args.head, args.base, args.expectedHeadRef);
      })();
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`pr-branch-update-decision.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

module.exports = { decideBranchUpdate, decideBranchUpdateFixture, decideBranchUpdateLive };
