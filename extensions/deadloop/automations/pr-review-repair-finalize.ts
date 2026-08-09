#!/usr/bin/env node
// Validate and push a review repair. This is the repair worker's only push path.
// It re-checks the open PR head, then performs a normal fast-forward push of
// the immutable repair commit.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");
const { resolveVerifiedPushDestination } = require("./verified-push-destination.ts");
const { assertAuthorizedSource } = require("./guarded-push.ts");
const { parsePaginatedGithubJson, validateActiveReviewClaim } = require("./pr-review-claim.ts");

type JsonObject = Record<string, any>;
type FinalizeArgs = {
  repo: string;
  projectRepo: string;
  githubRepo: string;
  pr: string;
  branch: string;
  expectedHead: string;
  remote: string;
  automationDir: string;
  stateDir: string;
  enabledAt: number;
  checkCommand: string;
  resultFile: string;
  reviewClaim: JsonObject;
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

function decideRepairPushGuard(pr: JsonObject, expectedBranch: string, expectedHead: string): JsonObject {
  if (String(pr.state || "").toUpperCase() !== "OPEN") return { action: "blocked", reason: "pr_not_open" };
  if (Boolean(pr.isCrossRepository)) return { action: "blocked", reason: "cross_repository_pr" };
  if (String(pr.headRefName || "") !== expectedBranch) return { action: "blocked", reason: "head_branch_changed" };
  if (String(pr.headRefOid || "").toLowerCase() !== expectedHead.toLowerCase()) return { action: "stale_head", reason: "head_sha_changed" };
  return { action: "push", reason: "head_unchanged" };
}

function finalizeReviewRepair(args: FinalizeArgs, ops: FinalizeOps = { run: defaultRun }): JsonObject {
  if (!args.reviewClaim || typeof args.reviewClaim !== "object" || Array.isArray(args.reviewClaim)) {
    throw new Error("active review claim is required before repair push");
  }
  checked(ops, ["git", "check-ref-format", "--branch", args.branch]);
  const candidateOid = checked(ops, ["git", "-C", args.repo, "rev-parse", "HEAD"], MAX_GUARDED_OPERATION_MS);
  if (ops.run(["git", "-C", args.repo, "merge-base", "--is-ancestor", args.expectedHead, candidateOid]).status !== 0) {
    throw new Error("repair branch does not contain the expected PR head");
  }
  if (candidateOid.toLowerCase() === args.expectedHead.toLowerCase()) {
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
  if (checked(ops, ["git", "-C", args.repo, "rev-parse", "HEAD"], MAX_GUARDED_OPERATION_MS).toLowerCase() !== candidateOid.toLowerCase()) {
    throw new Error("repair HEAD changed during checks");
  }

  const project = { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt };
  const guardAndPush = (enabled: EnabledProject, recheck: () => void = () => {}) => {
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
        "state,headRefName,headRefOid,isCrossRepository,labels",
      ], MAX_GUARDED_OPERATION_MS),
    );
    const guard = decideRepairPushGuard(pr, args.branch, args.expectedHead);
    if (guard.action !== "push") return {
      ...guard,
      originalHeadOid: args.expectedHead.toLowerCase(),
      currentRemoteHeadOid: String(pr.headRefOid || "").toLowerCase(),
    };
    const repository = JSON.parse(checked(ops, ["gh", "repo", "view", args.githubRepo, "--json", "id,nameWithOwner"], MAX_GUARDED_OPERATION_MS));
    const events = parsePaginatedGithubJson(checked(ops, ["gh", "api", "--paginate", "--slurp", `repos/${args.githubRepo}/issues/${args.pr}/events`], MAX_GUARDED_OPERATION_MS));
    const comments = parsePaginatedGithubJson(checked(ops, ["gh", "api", "--paginate", "--slurp", `repos/${args.githubRepo}/issues/${args.pr}/comments`], MAX_GUARDED_OPERATION_MS));
    const headers = checkedRaw(ops, ["gh", "api", "--include", `repos/${args.githubRepo}`], MAX_GUARDED_OPERATION_MS);
    if (!validateActiveReviewClaim(pr, events, comments, headers, args.reviewClaim, {
      repositoryId: String(repository.id || ""), repository: String(repository.nameWithOwner || ""), targetNumber: Number(args.pr),
    })) {
      throw new Error("active review claim could not be reauthorized before repair push");
    }
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
      checks: [{ command: args.checkCommand, result: "passed" }],
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
    projectRepo: required(values, "projectRepo"),
    githubRepo: required(values, "githubRepo"),
    pr: required(values, "pr"),
    branch: required(values, "branch"),
    expectedHead: required(values, "expectedHead"),
    remote: required(values, "remote"),
    automationDir: required(values, "automationDir"),
    stateDir: required(values, "stateDir"),
    enabledAt: Number(required(values, "enabledAt")),
    checkCommand: required(values, "checkCommand"),
    resultFile: required(values, "resultFile"),
    reviewClaim: JSON.parse(required(values, "reviewClaim")),
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

module.exports = { decideRepairPushGuard, finalizeReviewRepair, parseArgs };
