#!/usr/bin/env node
// Push one issue-worker branch to a verified explicit GitHub destination while
// holding the enablement lock. Remote configuration changes cannot redirect it.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");
const path = require("node:path") as typeof import("node:path");
const { resolveVerifiedPushDestination } = require("./verified-push-destination.ts");
const { readAttemptRecord, validateCompletionReportBinding } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { assertAttemptProjectBinding, assertWorktreeBelongsToProject, canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");
const {
  assertCurrentWorkerContract,
  assertWorkerCompletionAuthorized,
  readRequiredVerificationRecord,
  workerRequiredVerificationPath,
} = require("../../../src/worker-required-verification-runtime.cjs");

type Args = {
  projectId: string;
  projectRepo: string;
  worktree: string;
  githubRepo: string;
  stateDir: string;
  enabledAt: number;
  remote: string;
  branch: string;
  attemptRecord: string;
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
  if (!values.projectId || !values.projectRepo || !values.worktree || !values.githubRepo || !values.stateDir || !values.remote || !values.branch || !values.attemptRecord || !Number.isFinite(enabledAt)) {
    throw new Error("--project-id, --project-repo, --worktree, --github-repo, --state-dir, --enabled-at, --remote, --branch, and --attempt-record are required");
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

function assertWorkerPushBinding(
  attempt: { project: string; repository: string; branch: string; worktreePath: string },
  args: Pick<Args, "projectId" | "githubRepo" | "branch" | "worktree">,
): void {
  if (attempt.project !== args.projectId) throw new Error("attempt project does not match push project");
  if (attempt.repository !== args.githubRepo) throw new Error("attempt repository does not match push repository");
  if (attempt.branch !== args.branch) throw new Error("attempt branch does not match push destination");
  if (path.resolve(attempt.worktreePath) !== path.resolve(args.worktree)) throw new Error("attempt worktree does not match push source");
}

function assertVerifiedWorkerOutput(args: Args, ops: CommandOps = defaultOps()): string {
  const location = canonicalAttemptLocation(args);
  const attempt = readAttemptRecord(location.runDir);
  assertWorkerPushBinding(attempt, args);
  assertAttemptProjectBinding(attempt, args);
  assertWorktreeBelongsToProject({ runText: (argv: string[]) => gitOutput(ops, argv, "attempt worktree confinement failed") }, attempt, args);
  const report = JSON.parse(require("node:fs").readFileSync(attempt.promiseFile, "utf8"));
  validateCompletionReportBinding(attempt, report);
  const current = assertCurrentWorkerContract(attempt, args.projectRepo);
  const verification = readRequiredVerificationRecord(workerRequiredVerificationPath(args.attemptRecord));
  return assertWorkerCompletionAuthorized(attempt, report, verification, current).outputRevision;
}

function assertWorkerHead(args: Pick<Args, "worktree">, ops: CommandOps, outputRevision: string, message: string): void {
  if (gitOutput(ops, ["git", "-C", args.worktree, "rev-parse", "--verify", "HEAD^{commit}"], "Worker HEAD could not be resolved").toLowerCase() !== outputRevision.toLowerCase()) {
    throw new Error(message);
  }
}

function runGuardedPush(
  args: Args,
  ops: CommandOps = defaultOps(),
  authorize: (args: Args, ops: CommandOps) => string = assertVerifiedWorkerOutput,
): number {
  authorize(args, ops);
  return withEnabledProjectLock(
    { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt },
    (enabled: EnabledProject, recheck: () => void) => {
      const outputRevision = authorize(args, ops);
      assertAuthorizedSource(args, enabled, ops);
      assertWorkerHead(args, ops, outputRevision, "Worker HEAD is not the verified output commit");
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
      assertWorkerHead(args, ops, outputRevision, "Worker HEAD changed after verification");
      const result = ops.run(["git", "-C", args.worktree, "push", "--porcelain", destination, `${outputRevision}:${ref}`], MAX_GUARDED_OPERATION_MS);
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
module.exports = { assertAuthorizedSource, assertVerifiedWorkerOutput, assertWorkerHead, assertWorkerPushBinding, parseArgs, runGuardedPush };
