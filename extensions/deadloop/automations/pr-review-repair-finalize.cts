#!/usr/bin/env node
// Validate and push a review repair. This is the repair worker's only push path.
// It re-checks the open PR head, then pushes the immutable repair commit bound to
// that exact head by an expected-object-ID lease, so a remote change after the
// check stops the push instead of overwriting it. The lease can only fast-forward
// because the repair commit is required to contain the verified head.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
const { assertLocallyEnabled, MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");
const { hasUncommittedWork, UNCOMMITTED_WORK_STATUS_ARGS } = require("../../../src/agent-scratch-area.cjs");
const { ensureFinalizerRequiredVerification } = require("./finalizer-required-verification.cts");
const { resolveVerifiedPushDestination } = require("./verified-push-destination.cts");
const { assertAuthorizedSource } = require("./guarded-push.cts");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");

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
  inProgressLabel: string;
  blockedLabel: string;
};
type CommandResult = { status: number | null; stdout: string; stderr: string; signal?: NodeJS.Signals | null; timedOut?: boolean };
type EnabledProject = { repoPath?: string; baseBranch?: string; githubRepo: string; githubRepositoryId: string; automationLogin?: string };
type FinalizeOps = {
  run(args: string[], timeoutMs?: number): CommandResult;
  loadAttemptRecord?: (args: FinalizeArgs) => JsonObject;
  assertEnabled?: (project: { repoPath: string; githubRepo: string; stateDir: string; enabledAt: number }) => EnabledProject;
  ensureVerification?: (args: FinalizeArgs, candidateOid: string, repositoryId: string, run: FinalizeOps["run"]) => Promise<JsonObject>;
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
  beforePush: () => void,
): { pushed: boolean; currentRemoteHeadOid: string } {
  const ref = `refs/heads/${branch}`;
  if (checked(ops, ["git", "-C", repo, "rev-parse", "HEAD"], MAX_GUARDED_OPERATION_MS).toLowerCase() !== candidateOid.toLowerCase()) {
    throw new Error("repair HEAD changed immediately before push");
  }
  const remoteBeforePush = checked(ops, ["git", "ls-remote", destination, ref], MAX_GUARDED_OPERATION_MS).split(/\s+/)[0] || "";
  if (remoteBeforePush.toLowerCase() !== expectedHead.toLowerCase()) {
    return { pushed: false, currentRemoteHeadOid: remoteBeforePush.toLowerCase() };
  }
  beforePush();
  const push = ops.run(
    ["git", "-C", repo, "push", "--porcelain", `--force-with-lease=${ref}:${expectedHead}`, destination, `${candidateOid}:${ref}`],
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

async function finalizeReviewRepair(args: FinalizeArgs, ops: FinalizeOps = { run: defaultRun }): Promise<JsonObject> {
  const record = ops.loadAttemptRecord
    ? ops.loadAttemptRecord(args)
    : readAttemptRecord(canonicalAttemptLocation({ stateDir: args.stateDir, attemptRecord: args.attemptRecord }).runDir);
  if (record.role !== "review-repair" || record.repository !== args.githubRepo
    || record.target?.kind !== "pull-request" || Number(record.target?.number) !== Number(args.pr)
    || String(record.inputRevision?.head || "").toLowerCase() !== args.expectedHead.toLowerCase()) {
    throw new Error("repair attempt record does not match the finalizer target");
  }
  checked(ops, ["git", "check-ref-format", "--branch", args.branch]);
  const candidateOid = checked(ops, ["git", "-C", args.repo, "rev-parse", "HEAD"], MAX_GUARDED_OPERATION_MS);
  if (ops.run(["git", "-C", args.repo, "merge-base", "--is-ancestor", args.expectedHead, candidateOid]).status !== 0) {
    throw new Error("repair branch does not contain the expected PR head");
  }
  if (candidateOid.toLowerCase() === args.expectedHead.toLowerCase()) {
    throw new Error("repair did not create a new commit");
  }
  if (hasUncommittedWork(checked(ops, ["git", "-C", args.repo, ...UNCOMMITTED_WORK_STATUS_ARGS]))) {
    throw new Error("repair worktree is dirty before checks");
  }

  const project = { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt };
  const initiallyEnabled = ops.assertEnabled ? ops.assertEnabled(project) : assertLocallyEnabled(project);
  const verify = ops.ensureVerification
    || ((input: FinalizeArgs, oid: string, repositoryId: string, run: FinalizeOps["run"]) => ensureFinalizerRequiredVerification(input, "review-repair", oid, repositoryId, run));
  const verification = await verify(args, candidateOid, initiallyEnabled.githubRepositoryId, ops.run);
  if (hasUncommittedWork(checked(ops, ["git", "-C", args.repo, ...UNCOMMITTED_WORK_STATUS_ARGS]))) {
    throw new Error("repair worktree is dirty after checks");
  }
  if (checked(ops, ["git", "-C", args.repo, "rev-parse", "HEAD"], MAX_GUARDED_OPERATION_MS).toLowerCase() !== candidateOid.toLowerCase()) {
    throw new Error("repair HEAD changed during checks");
  }

  const guardAndPush = async (enabled: EnabledProject & { automationLogin?: string }, recheck: () => void = () => {}) => {
    await verify(args, candidateOid, enabled.githubRepositoryId, ops.run);
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
    const pushDestination = resolveVerifiedPushDestination(
      ops,
      args.repo,
      args.remote,
      enabled.githubRepo,
      enabled.githubRepositoryId,
      MAX_GUARDED_OPERATION_MS,
    );
    const revalidateImmediatelyBeforePush = () => {
      recheck();
      const automationLogin = String(enabled.automationLogin || "").trim().toLowerCase();
      const authenticated = checked(ops, ["gh", "api", "user", "--jq", ".login"], MAX_GUARDED_OPERATION_MS).toLowerCase();
      if (!automationLogin || authenticated !== automationLogin) {
        throw new Error("current authenticated GitHub identity does not match enablement authority before repair push");
      }
      const currentPr = JSON.parse(checked(ops, [
        "gh", "pr", "view", args.pr, "-R", args.githubRepo,
        "--json", "state,headRefName,headRefOid,isCrossRepository,labels",
      ], MAX_GUARDED_OPERATION_MS));
      const currentGuard = decideRepairPushGuard(currentPr, args.branch, args.expectedHead);
      const labels = (currentPr.labels || []).map((label: JsonObject | string) =>
        typeof label === "string" ? label : String(label.name || ""));
      if (currentGuard.action !== "push" || !labels.includes(args.inProgressLabel) || labels.includes(args.blockedLabel)) {
        throw new Error("repair push target changed immediately before push");
      }
    };
    const push = pushConditionally(ops, args.repo, pushDestination, args.branch, args.expectedHead, candidateOid, revalidateImmediatelyBeforePush);
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
    attemptRecord: required(values, "attemptRecord"),
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
    inProgressLabel: required(values, "inProgressLabel"),
    blockedLabel: required(values, "blockedLabel"),
  };
}

function argumentValue(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] || "") : "";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const fallbackResultFile = argumentValue(argv, "--result-file");
  let args: FinalizeArgs | undefined;
  try {
    args = parseArgs(argv);
    const result = await finalizeReviewRepair(args);
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
        console.error(`pr-review-repair-finalize.cts: could not write result receipt: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
      }
    }
    console.error(`pr-review-repair-finalize.cts: ${message}`);
    process.exitCode = 2;
  }
}

if (require.main === module) void main();

module.exports = { decideRepairPushGuard, finalizeReviewRepair, parseArgs };
