#!/usr/bin/env node
// Validate and push a review repair. This is the repair worker's only push path.
// It always re-checks the open PR head immediately before a non-force push.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

type JsonObject = Record<string, any>;
type FinalizeArgs = {
  repo: string;
  githubRepo: string;
  pr: string;
  branch: string;
  expectedHead: string;
  remote: string;
  automationDir: string;
  stateDir: string;
  checkCommand: string;
  resultFile?: string;
};
type CommandResult = { status: number; stdout: string; stderr: string };
type FinalizeOps = { run(args: string[]): CommandResult };

function defaultRun(args: string[]): CommandResult {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function checked(ops: FinalizeOps, args: string[]): string {
  const result = ops.run(args);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `command failed: ${args.join(" ")}`).trim());
  return result.stdout.trim();
}

function decideRepairPushGuard(pr: JsonObject, expectedBranch: string, expectedHead: string): JsonObject {
  if (String(pr.state || "").toUpperCase() !== "OPEN") return { action: "blocked", reason: "pr_not_open" };
  if (Boolean(pr.isCrossRepository)) return { action: "blocked", reason: "cross_repository_pr" };
  if (String(pr.headRefName || "") !== expectedBranch) return { action: "blocked", reason: "head_branch_changed" };
  if (String(pr.headRefOid || "").toLowerCase() !== expectedHead.toLowerCase()) return { action: "stale_head", reason: "head_sha_changed" };
  return { action: "push", reason: "head_unchanged" };
}

function finalizeReviewRepair(args: FinalizeArgs, ops: FinalizeOps = { run: defaultRun }): JsonObject {
  checked(ops, ["git", "check-ref-format", "--branch", args.branch]);
  if (ops.run(["git", "-C", args.repo, "merge-base", "--is-ancestor", args.expectedHead, "HEAD"]).status !== 0) {
    throw new Error("repair branch does not contain the expected PR head");
  }
  if (checked(ops, ["git", "-C", args.repo, "rev-parse", "HEAD"]).toLowerCase() === args.expectedHead.toLowerCase()) {
    throw new Error("repair did not create a new commit");
  }
  if (checked(ops, ["git", "-C", args.repo, "status", "--porcelain"])) throw new Error("repair worktree is dirty before checks");

  checked(ops, [
    "node",
    path.join(args.automationDir, "run-project-check.ts"),
    "--cwd",
    args.repo,
    "--command",
    args.checkCommand,
    "--quarantine-root",
    path.join(args.stateDir, "check-quarantine"),
  ]);
  if (checked(ops, ["git", "-C", args.repo, "status", "--porcelain"])) throw new Error("repair worktree is dirty after checks");

  const pr = JSON.parse(
    checked(ops, [
      "gh",
      "pr",
      "view",
      args.pr,
      "-R",
      args.githubRepo,
      "--json",
      "state,headRefName,headRefOid,isCrossRepository",
    ]),
  );
  const guard = decideRepairPushGuard(pr, args.branch, args.expectedHead);
  if (guard.action !== "push") return { ...guard, originalHeadOid: args.expectedHead };

  checked(ops, ["git", "-C", args.repo, "push", "--porcelain", args.remote, `HEAD:refs/heads/${args.branch}`]);
  return {
    action: "pushed",
    reason: "repair_pushed",
    originalHeadOid: args.expectedHead.toLowerCase(),
    headOid: checked(ops, ["git", "-C", args.repo, "rev-parse", "HEAD"]).toLowerCase(),
    checks: [{ command: args.checkCommand, result: "passed" }],
  };
}

function required(values: Record<string, string>, name: string): string {
  if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  return values[name];
}

function parseArgs(argv: string[]): FinalizeArgs {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  return {
    repo: required(values, "repo"),
    githubRepo: required(values, "githubRepo"),
    pr: required(values, "pr"),
    branch: required(values, "branch"),
    expectedHead: required(values, "expectedHead"),
    remote: required(values, "remote"),
    automationDir: required(values, "automationDir"),
    stateDir: required(values, "stateDir"),
    checkCommand: required(values, "checkCommand"),
    resultFile: required(values, "resultFile"),
  };
}

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = finalizeReviewRepair(args);
    fs.writeFileSync(String(args.resultFile), `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.action === "blocked") process.exitCode = 3;
  } catch (error) {
    console.error(`pr-review-repair-finalize.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = { decideRepairPushGuard, finalizeReviewRepair, parseArgs };
