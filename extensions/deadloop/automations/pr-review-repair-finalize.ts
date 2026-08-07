#!/usr/bin/env node
// Validate and push a review repair. This is the repair worker's only push path.
// It re-checks the open PR head, then performs a normal fast-forward push of
// the immutable repair commit.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
const { assertLocallyEnabled, MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");
const { ensureFinalizerRequiredVerification } = require("./finalizer-required-verification.ts");
const { resolveVerifiedPushDestination } = require("./verified-push-destination.ts");
const { assertAuthorizedSource } = require("./guarded-push.ts");
const { repairAttempts } = require("./pr-review-repair-state.ts");

type JsonObject = Record<string, any>;
type FinalizeArgs = {
  repo: string;
  projectId: string;
  projectRepo: string;
  githubRepo: string;
  attemptRecord: string;
  pr: string;
  branch: string;
  expectedHead: string;
  remote: string;
  automationDir: string;
  stateDir: string;
  enabledAt: number;
  checkCommand: string;
  resultFile: string;
};
type CommandResult = { status: number | null; stdout: string; stderr: string; signal?: NodeJS.Signals | null; timedOut?: boolean };
type EnabledProject = { githubRepo: string; githubRepositoryId: string };
type FinalizeOps = {
  run(args: string[], timeoutMs?: number): CommandResult;
  assertEnabled?: (project: { repoPath: string; githubRepo: string; stateDir: string; enabledAt: number }) => EnabledProject;
  readRepairFindingCount?: (args: FinalizeArgs) => number;
  ensureVerification?: (args: FinalizeArgs, candidateOid: string, repositoryId: string, run: FinalizeOps["run"]) => JsonObject;
};

function defaultRun(args: string[], timeoutMs?: number): CommandResult {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" }),
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    signal: result.signal,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
  };
}

function checkedRaw(ops: FinalizeOps, args: string[], timeoutMs?: number): string {
  const result = ops.run(args, timeoutMs);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `command failed: ${args.join(" ")}`).trim());
  return result.stdout;
}

function checked(ops: FinalizeOps, args: string[], timeoutMs?: number): string {
  return checkedRaw(ops, args, timeoutMs).trim();
}

function pushConditionally(
  ops: FinalizeOps,
  repo: string,
  destination: string,
  branch: string,
  expectedHead: string,
  candidateOid: string,
  recheck: () => void,
): { pushed: boolean; currentRemoteHeadOid: string } {
  const ref = `refs/heads/${branch}`;
  if (checked(ops, ["git", "-C", repo, "rev-parse", "HEAD"], MAX_GUARDED_OPERATION_MS).toLowerCase() !== candidateOid.toLowerCase()) {
    throw new Error("repair HEAD changed immediately before push");
  }
  const remoteBeforePush = checked(ops, ["git", "ls-remote", destination, ref], MAX_GUARDED_OPERATION_MS).split(/\s+/)[0] || "";
  if (remoteBeforePush.toLowerCase() !== expectedHead.toLowerCase()) {
    return { pushed: false, currentRemoteHeadOid: remoteBeforePush.toLowerCase() };
  }
  recheck();
  const push = ops.run(
    ["git", "-C", repo, "push", "--porcelain", destination, `${candidateOid}:${ref}`],
    MAX_GUARDED_OPERATION_MS,
  );
  if (push.status === 0) return { pushed: true, currentRemoteHeadOid: candidateOid.toLowerCase() };

  const remoteLine = checked(ops, ["git", "ls-remote", destination, ref], MAX_GUARDED_OPERATION_MS);
  const remoteHead = (remoteLine.split(/\s+/)[0] || "").toLowerCase();
  if (remoteHead !== expectedHead.toLowerCase()) return { pushed: false, currentRemoteHeadOid: remoteHead };
  throw new Error((push.stderr || push.stdout || "conditional push failed").trim());
}

const MAX_CHANGED_FILES_PER_FINDING = 5;
const MAX_CHANGED_FILES_ABSOLUTE = 20;

function decideRepairSize(changedFileCount: number, findingCount: number): JsonObject {
  if (!Number.isSafeInteger(changedFileCount) || changedFileCount < 0) throw new Error("changed file count must be a non-negative integer");
  if (!Number.isSafeInteger(findingCount) || findingCount < 1) throw new Error("finding count must be a positive integer");
  const perFindingLimit = findingCount * MAX_CHANGED_FILES_PER_FINDING;
  const effectiveLimit = Math.min(perFindingLimit, MAX_CHANGED_FILES_ABSOLUTE);
  const policy = {
    changedFileCount,
    findingCount,
    maxChangedFilesPerFinding: MAX_CHANGED_FILES_PER_FINDING,
    maxChangedFilesAbsolute: MAX_CHANGED_FILES_ABSOLUTE,
    effectiveLimit,
    rationale: "Automatic repair is limited to five changed files per finding and twenty changed files overall; larger repairs require human review because broad edits increase regression risk.",
  };
  return changedFileCount > effectiveLimit
    ? { action: "human_required", reason: "repair_size_limit_exceeded", ...policy }
    : { action: "push", reason: "repair_size_within_limit", ...policy };
}

function repairFindingCount(args: FinalizeArgs, ops: FinalizeOps): number {
  if (ops.readRepairFindingCount) return ops.readRepairFindingCount(args);
  const pr = JSON.parse(checked(ops, [
    "gh", "pr", "view", args.pr, "-R", args.githubRepo, "--json", "comments",
  ], MAX_GUARDED_OPERATION_MS));
  const matching = repairAttempts(pr.comments || []).filter(
    (attempt: JsonObject) => attempt.headOid === args.expectedHead.toLowerCase() && Number.isSafeInteger(attempt.findingCount),
  );
  const counts = [...new Set<number>(matching.map((attempt: JsonObject) => Number(attempt.findingCount)))];
  if (counts.length !== 1 || counts[0] < 1) {
    throw new Error("persisted review repair marker does not provide one finding count for the expected PR head");
  }
  return counts[0];
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
  const candidateOid = checked(ops, ["git", "-C", args.repo, "rev-parse", "HEAD"], MAX_GUARDED_OPERATION_MS);
  if (ops.run(["git", "-C", args.repo, "merge-base", "--is-ancestor", args.expectedHead, candidateOid]).status !== 0) {
    throw new Error("repair branch does not contain the expected PR head");
  }
  if (candidateOid.toLowerCase() === args.expectedHead.toLowerCase()) {
    throw new Error("repair did not create a new commit");
  }
  if (checked(ops, ["git", "-C", args.repo, "status", "--porcelain"])) throw new Error("repair worktree is dirty before checks");

  const changedFilesOutput = checkedRaw(ops, [
    "git", "-C", args.repo, "-c", "diff.renameLimit=0", "diff", "--name-only", "-z", "--find-renames", args.expectedHead, candidateOid, "--",
  ], MAX_GUARDED_OPERATION_MS);
  const changedFileCount = changedFilesOutput ? changedFilesOutput.split("\0").filter(Boolean).length : 0;
  const findingCount = repairFindingCount(args, ops);
  const size = decideRepairSize(changedFileCount, findingCount);
  if (size.action === "human_required") {
    return {
      action: "blocked",
      reason: size.reason,
      summary: `Repair changes ${changedFileCount} files; the automatic limit for ${findingCount} findings is ${size.effectiveLimit}.`,
      originalHeadOid: args.expectedHead.toLowerCase(),
      size,
    };
  }

  const project = { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt };
  const initiallyEnabled = ops.assertEnabled ? ops.assertEnabled(project) : assertLocallyEnabled(project);
  const verify = ops.ensureVerification
    || ((input: FinalizeArgs, oid: string, repositoryId: string, run: FinalizeOps["run"]) => ensureFinalizerRequiredVerification(input, "review-repair", oid, repositoryId, run));
  const verification = verify(args, candidateOid, initiallyEnabled.githubRepositoryId, ops.run);
  if (checked(ops, ["git", "-C", args.repo, "status", "--porcelain"])) throw new Error("repair worktree is dirty after checks");
  if (checked(ops, ["git", "-C", args.repo, "rev-parse", "HEAD"], MAX_GUARDED_OPERATION_MS).toLowerCase() !== candidateOid.toLowerCase()) {
    throw new Error("repair HEAD changed during checks");
  }

  const guardAndPush = (enabled: EnabledProject, recheck: () => void = () => {}) => {
    verify(args, candidateOid, enabled.githubRepositoryId, ops.run);
    assertAuthorizedSource(
      { projectRepo: args.projectRepo, worktree: args.repo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt, remote: args.remote, branch: args.branch },
      enabled,
      ops,
    );
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
    const guard = decideRepairPushGuard(pr, args.branch, args.expectedHead);
    if (guard.action !== "push") return {
      ...guard,
      originalHeadOid: args.expectedHead.toLowerCase(),
      currentRemoteHeadOid: String(pr.headRefOid || "").toLowerCase(),
    };
    const pushDestination = resolveVerifiedPushDestination(
      ops,
      args.repo,
      args.remote,
      enabled.githubRepo,
      enabled.githubRepositoryId,
      MAX_GUARDED_OPERATION_MS,
    );
    const push = pushConditionally(ops, args.repo, pushDestination, args.branch, args.expectedHead, candidateOid, recheck);
    if (!push.pushed) {
      return {
        action: "stale_head",
        reason: "head_sha_changed_during_push",
        originalHeadOid: args.expectedHead.toLowerCase(),
        currentRemoteHeadOid: push.currentRemoteHeadOid,
      };
    }
    return {
      action: "pushed",
      reason: "repair_pushed",
      originalHeadOid: args.expectedHead.toLowerCase(),
      headOid: candidateOid.toLowerCase(),
      checks: [{ command: verification.record?.binding?.command || args.checkCommand, result: "passed" }],
      size,
    };
  };
  if (ops.assertEnabled) {
    return guardAndPush(ops.assertEnabled(project));
  }
  return withEnabledProjectLock(project, guardAndPush);
}

function writeResult(file: string, result: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
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
    projectId: required(values, "projectId"),
    projectRepo: required(values, "projectRepo"),
    githubRepo: required(values, "githubRepo"),
    attemptRecord: required(values, "attemptRecord"),
    pr: required(values, "pr"),
    branch: required(values, "branch"),
    expectedHead: required(values, "expectedHead"),
    remote: required(values, "remote"),
    automationDir: required(values, "automationDir"),
    stateDir: required(values, "stateDir"),
    enabledAt: Number(required(values, "enabledAt")),
    checkCommand: required(values, "checkCommand"),
    resultFile: required(values, "resultFile"),
  };
}

function argumentValue(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] || "") : "";
}

function main(): void {
  const argv = process.argv.slice(2);
  const fallbackResultFile = argumentValue(argv, "--result-file");
  let args: FinalizeArgs | undefined;
  try {
    args = parseArgs(argv);
    const result = finalizeReviewRepair(args);
    writeResult(args.resultFile, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.action === "blocked") process.exitCode = 3;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const resultFile = args?.resultFile || fallbackResultFile;
    if (resultFile) {
      try {
        writeResult(resultFile, {
          action: "blocked",
          reason: "finalizer_error",
          summary: message,
          originalHeadOid: String(args?.expectedHead || argumentValue(argv, "--expected-head")).toLowerCase(),
        });
      } catch (writeError) {
        console.error(`pr-review-repair-finalize.ts: could not write result receipt: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
      }
    }
    console.error(`pr-review-repair-finalize.ts: ${message}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = { decideRepairPushGuard, decideRepairSize, finalizeReviewRepair, parseArgs };
