#!/usr/bin/env node
// Merge one reviewed PR only if GitHub still reports the reviewed head commit.
// The mutation is serialized with /deadloop-disable through the enablement lock.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");

type MergeArgs = {
  projectRepo: string;
  githubRepo: string;
  stateDir: string;
  enabledAt: number;
  pr: string;
  expectedHead: string;
};
type CommandResult = { status: number; stdout: string; stderr: string };
type MergeOps = {
  run(args: string[], timeoutMs?: number): CommandResult;
  withLock?: (project: { repoPath: string; githubRepo: string; stateDir: string; enabledAt: number }, operation: () => number) => number;
};

function defaultRun(args: string[], timeoutMs?: number): CommandResult {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" }),
  });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function mergeReviewedPr(args: MergeArgs, ops: MergeOps = { run: defaultRun }): number {
  const project = { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt };
  const operation = () => {
    const result = ops.run([
      "gh", "pr", "merge", args.pr, "-R", args.githubRepo,
      "--squash", "--delete-branch", "--match-head-commit", args.expectedHead,
    ], MAX_GUARDED_OPERATION_MS);
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "guarded PR merge failed").trim());
    return 0;
  };
  return ops.withLock ? ops.withLock(project, operation) : withEnabledProjectLock(project, operation);
}

function parseArgs(argv: string[]): MergeArgs {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  const enabledAt = Number(values.enabledAt);
  if (!values.projectRepo || !values.githubRepo || !values.stateDir || !values.pr || !values.expectedHead || !Number.isFinite(enabledAt)) {
    throw new Error("--project-repo, --github-repo, --state-dir, --enabled-at, --pr, and --expected-head are required");
  }
  return { projectRepo: values.projectRepo, githubRepo: values.githubRepo, stateDir: values.stateDir, enabledAt, pr: values.pr, expectedHead: values.expectedHead };
}

function main(): void {
  try {
    process.exitCode = mergeReviewedPr(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`merge-reviewed-pr.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();
module.exports = { mergeReviewedPr, parseArgs };
