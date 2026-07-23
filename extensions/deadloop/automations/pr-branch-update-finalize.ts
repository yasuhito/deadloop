#!/usr/bin/env node
// Run the configured check, revalidate the exact PR head, and perform the only
// push allowed to a branch-update worker. The push is always non-force.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const path = require("node:path") as typeof import("node:path");

type JsonObject = Record<string, any>;
type FinalizeArgs = {
  repo: string;
  githubRepo: string;
  pr: string;
  branch: string;
  expectedHead: string;
  expectedBase: string;
  remote: string;
  automationDir: string;
  stateDir: string;
  checkCommand: string;
};
type CommandResult = { status: number; stdout: string; stderr: string };
type BranchPush = {
  repo: string;
  remote: string;
  updates: { source: string; destination: string }[];
  mode: "normal";
};
type FinalizeOps = {
  run(args: string[]): CommandResult;
  pushBranch?(push: BranchPush): CommandResult;
};

function defaultRun(args: string[]): CommandResult {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function checkedResult(result: CommandResult, failureMessage: string): string {
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || failureMessage).trim());
  return result.stdout.trim();
}

function checked(ops: FinalizeOps, args: string[]): string {
  return checkedResult(ops.run(args), `command failed: ${args.join(" ")}`);
}

function pushBranch(ops: FinalizeOps, push: BranchPush): string {
  const result = ops.pushBranch
    ? ops.pushBranch(push)
    : ops.run([
        "git",
        "-C",
        push.repo,
        "push",
        "--porcelain",
        push.remote,
        ...push.updates.map((update) => `${update.source}:${update.destination}`),
      ]);
  return checkedResult(result, "branch push failed");
}

function decidePushGuard(pr: JsonObject, expectedBranch: string, expectedHead: string): JsonObject {
  if (String(pr.state || "").toUpperCase() !== "OPEN") return { action: "blocked", reason: "pr_not_open" };
  if (Boolean(pr.isCrossRepository)) return { action: "blocked", reason: "cross_repository_pr" };
  if (String(pr.headRefName || "") !== expectedBranch) return { action: "blocked", reason: "head_branch_changed" };
  if (String(pr.headRefOid || "").toLowerCase() !== expectedHead.toLowerCase()) return { action: "stale_head", reason: "head_sha_changed" };
  return { action: "push", reason: "head_unchanged" };
}

function finalizeBranchUpdate(args: FinalizeArgs, ops: FinalizeOps = { run: defaultRun }): JsonObject {
  checked(ops, ["git", "check-ref-format", "--branch", args.branch]);
  const originalHeadIsAncestor = ops.run(["git", "-C", args.repo, "merge-base", "--is-ancestor", args.expectedHead, "HEAD"]);
  if (originalHeadIsAncestor.status !== 0) throw new Error("updated branch does not contain the expected PR head");
  const baseIsAncestor = ops.run(["git", "-C", args.repo, "merge-base", "--is-ancestor", args.expectedBase, "HEAD"]);
  if (baseIsAncestor.status !== 0) throw new Error("updated branch does not contain the selected base head");

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
  if (checked(ops, ["git", "-C", args.repo, "status", "--porcelain"])) throw new Error("branch-update worktree is dirty after checks");

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
  const guard = decidePushGuard(pr, args.branch, args.expectedHead);
  if (guard.action !== "push") return guard;

  pushBranch(ops, {
    repo: args.repo,
    remote: args.remote,
    updates: [{ source: "HEAD", destination: `refs/heads/${args.branch}` }],
    mode: "normal",
  });
  return { action: "pushed", reason: "branch_updated", headOid: checked(ops, ["git", "-C", args.repo, "rev-parse", "HEAD"]) };
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
    expectedBase: required(values, "expectedBase"),
    remote: required(values, "remote"),
    automationDir: required(values, "automationDir"),
    stateDir: required(values, "stateDir"),
    checkCommand: required(values, "checkCommand"),
  };
}

function main(): void {
  try {
    const result = finalizeBranchUpdate(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.action === "blocked") process.exitCode = 3;
  } catch (error) {
    console.error(`pr-branch-update-finalize.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = { decidePushGuard, finalizeBranchUpdate, parseArgs };
