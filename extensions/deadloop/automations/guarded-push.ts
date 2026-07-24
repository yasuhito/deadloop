#!/usr/bin/env node
// Push one issue-worker branch to a verified explicit GitHub destination while
// holding the enablement lock. Remote configuration changes cannot redirect it.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");
const { resolveVerifiedPushDestination } = require("./verified-push-destination.ts");

type Args = {
  projectRepo: string;
  worktree: string;
  githubRepo: string;
  stateDir: string;
  enabledAt: number;
  remote: string;
  branch: string;
};

type CommandResult = { status: number; stdout: string; stderr: string };
type CommandOps = { run(args: string[], timeoutMs?: number): CommandResult };
type EnabledProject = { githubRepositoryId: string; baseBranch?: string };

function parseArgs(argv: string[]): Args {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  const enabledAt = Number(values.enabledAt);
  if (!values.projectRepo || !values.worktree || !values.githubRepo || !values.stateDir || !values.remote || !values.branch || !Number.isFinite(enabledAt)) {
    throw new Error("--project-repo, --worktree, --github-repo, --state-dir, --enabled-at, --remote, and --branch are required");
  }
  return { ...values, enabledAt } as Args;
}

function defaultOps(): CommandOps {
  return {
    run(args, timeoutMs) {
      const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" });
      if (result.error) throw result.error;
      return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
    },
  };
}

function gitOutput(ops: CommandOps, args: string[], description: string): string {
  const result = ops.run(args, MAX_GUARDED_OPERATION_MS);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || description).trim());
  return result.stdout.trim();
}

function assertAuthorizedSource(args: Args, enabled: EnabledProject, ops: CommandOps): void {
  const baseBranch = enabled.baseBranch?.replace(/^origin\//, "");
  if (baseBranch && args.branch === baseBranch) throw new Error("push destination must not be the configured base branch");
  if (!args.branch.startsWith("agent/issue-") || args.branch === "agent/issue-") {
    throw new Error("push destination must be an agent/issue-* worker branch");
  }

  const projectCommonDir = gitOutput(
    ops,
    ["git", "-C", args.projectRepo, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    "enabled checkout Git common directory could not be resolved",
  );
  const worktreeCommonDir = gitOutput(
    ops,
    ["git", "-C", args.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    "source worktree Git common directory could not be resolved",
  );
  if (projectCommonDir !== worktreeCommonDir) throw new Error("source worktree does not belong to the enabled checkout");

  const checkedOutBranch = gitOutput(
    ops,
    ["git", "-C", args.worktree, "symbolic-ref", "--quiet", "--short", "HEAD"],
    "source worktree must have the requested branch checked out",
  );
  if (checkedOutBranch !== args.branch) throw new Error("source worktree branch does not match the requested branch");
}

function runGuardedPush(args: Args, ops: CommandOps = defaultOps()): number {
  return withEnabledProjectLock(
    { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt },
    (enabled: EnabledProject, recheck: () => void) => {
      assertAuthorizedSource(args, enabled, ops);
      const destination = resolveVerifiedPushDestination(
        ops,
        args.projectRepo,
        args.remote,
        args.githubRepo,
        enabled.githubRepositoryId,
        MAX_GUARDED_OPERATION_MS,
      );
      const ref = `refs/heads/${args.branch}`;
      recheck();
      const result = ops.run(["git", "-C", args.worktree, "push", "--porcelain", destination, `HEAD:${ref}`], MAX_GUARDED_OPERATION_MS);
      if (result.status !== 0) throw new Error((result.stderr || result.stdout || "push failed").trim());
      return 0;
    },
  );
}

function main(): void {
  try {
    process.exitCode = runGuardedPush(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`guarded-push.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();
module.exports = { assertAuthorizedSource, parseArgs, runGuardedPush };
