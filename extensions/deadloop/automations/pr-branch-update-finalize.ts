#!/usr/bin/env node
// Run the configured check, revalidate the exact PR head, and perform the only
// push allowed to a branch-update worker. The push is always non-force.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const path = require("node:path") as typeof import("node:path");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");
const { resolveVerifiedPushDestination } = require("./verified-push-destination.ts");

type JsonObject = Record<string, any>;
type FinalizeArgs = {
  repo: string;
  projectRepo: string;
  githubRepo: string;
  pr: string;
  branch: string;
  expectedHead: string;
  expectedBase: string;
  remote: string;
  automationDir: string;
  stateDir: string;
  enabledAt: number;
  checkCommand: string;
};
type CommandResult = { status: number; stdout: string; stderr: string };
type EnabledProject = { githubRepo: string; githubRepositoryId: string };
type FinalizeOps = {
  run(args: string[], timeoutMs?: number): CommandResult;
  assertEnabled?: (project: { repoPath: string; githubRepo: string; stateDir: string; enabledAt: number }) => EnabledProject;
};

function defaultRun(args: string[], timeoutMs?: number): CommandResult {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" }),
  });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function checked(ops: FinalizeOps, args: string[], timeoutMs?: number): string {
  const result = ops.run(args, timeoutMs);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `command failed: ${args.join(" ")}`).trim());
  return result.stdout.trim();
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

  const project = { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt };
  const guardAndPush = (enabled: EnabledProject) => {
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
      ], MAX_GUARDED_OPERATION_MS),
    );
    const guard = decidePushGuard(pr, args.branch, args.expectedHead);
    if (guard.action !== "push") return guard;
    const pushDestination = resolveVerifiedPushDestination(
      ops,
      args.repo,
      args.remote,
      enabled.githubRepo,
      enabled.githubRepositoryId,
      MAX_GUARDED_OPERATION_MS,
    );
    checked(ops, ["git", "-C", args.repo, "push", "--porcelain", pushDestination, `HEAD:refs/heads/${args.branch}`], MAX_GUARDED_OPERATION_MS);
    return {
      action: "pushed",
      reason: "branch_updated",
      headOid: checked(ops, ["git", "-C", args.repo, "rev-parse", "HEAD"], MAX_GUARDED_OPERATION_MS),
    };
  };
  if (ops.assertEnabled) {
    return guardAndPush(ops.assertEnabled(project));
  }
  return withEnabledProjectLock(project, guardAndPush);
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
    projectRepo: required(values, "projectRepo"),
    githubRepo: required(values, "githubRepo"),
    pr: required(values, "pr"),
    branch: required(values, "branch"),
    expectedHead: required(values, "expectedHead"),
    expectedBase: required(values, "expectedBase"),
    remote: required(values, "remote"),
    automationDir: required(values, "automationDir"),
    stateDir: required(values, "stateDir"),
    enabledAt: Number(required(values, "enabledAt")),
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
