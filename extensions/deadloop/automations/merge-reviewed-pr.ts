#!/usr/bin/env node
// Merge one reviewed PR only if GitHub still reports the reviewed head commit.
// The mutation is serialized with /deadloop-disable through the enablement lock.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");
const { validatePromise } = require("./extract-worker-promise.ts");

type MergeArgs = {
  projectRepo: string;
  githubRepo: string;
  stateDir: string;
  enabledAt: number;
  pr: string;
  expectedHead: string;
  reviewPromise: string;
  reviewLabel: string;
  reviewingLabel: string;
  blockedLabel: string;
};
type EnabledProject = {
  firstEnableAutoMerge: boolean;
  firstStartPending: boolean;
  autoMergeAcknowledged: boolean;
};
type CommandResult = { status: number; stdout: string; stderr: string };
type PromiseValidation = { status?: unknown; promise?: Record<string, unknown> };
type MergeOps = {
  run(args: string[], timeoutMs?: number): CommandResult;
  isAutoMergeEnabled?: (args: MergeArgs) => boolean;
  validateReviewPromise?: (file: string) => PromiseValidation;
  withLock?: (project: { repoPath: string; githubRepo: string; stateDir: string; enabledAt: number }, operation: (enabled: EnabledProject, recheck: () => void) => number) => number;
};

function defaultRun(args: string[], timeoutMs?: number): CommandResult {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" }),
  });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function currentAutoMergeEnabled(args: MergeArgs): boolean {
  const configPath = process.env.DEADLOOP_CONFIG || path.join(args.stateDir, "projects.json");
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`projects.json read error: ${error instanceof Error ? error.message : String(error)}`);
  }
  let config: unknown;
  try {
    config = JSON.parse(text || "{}");
  } catch (error) {
    throw new Error(`projects.json parse error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("projects.json must contain an object; automatic merge stopped");
  }
  const configuredProjects = (config as { projects?: unknown }).projects;
  if (configuredProjects !== undefined && !Array.isArray(configuredProjects)) {
    throw new Error("projects.json projects must be an array; automatic merge stopped");
  }
  const rawProjects: unknown[] = Array.isArray(configuredProjects) ? configuredProjects : [];
  const selectedIds = new Set(String(process.env.DEADLOOP_PROJECTS || "").split(",").map((value) => value.trim()).filter(Boolean));
  const matches = rawProjects.filter((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("projects.json contains an invalid project; automatic merge stopped");
    }
    const project = candidate as { id?: unknown; repoPath?: unknown; githubRepo?: unknown };
    const projectId = String(project.id || project.githubRepo || project.repoPath || "project")
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
    if (selectedIds.size > 0 && !selectedIds.has(projectId)) return false;
    return typeof project.repoPath === "string"
      && path.resolve(project.repoPath) === path.resolve(args.projectRepo)
      && project.githubRepo === args.githubRepo;
  }) as Array<{ autoMerge?: unknown }>;
  if (matches.length > 1) throw new Error("current project configuration is ambiguous; automatic merge stopped");
  if (matches.length !== 1) return false;
  if (matches[0].autoMerge !== undefined && typeof matches[0].autoMerge !== "boolean") {
    throw new Error("current autoMerge setting is invalid; automatic merge stopped");
  }
  return matches[0].autoMerge === true;
}

function assertMergeAuthorized(enabled: EnabledProject): void {
  if (enabled.firstStartPending) throw new Error("first safe start is still pending; automatic merge stopped");
  if (enabled.firstEnableAutoMerge && !enabled.autoMergeAcknowledged) {
    throw new Error("autoMerge has not been acknowledged after enablement; automatic merge stopped");
  }
}

function assertReviewApproved(args: MergeArgs, ops: MergeOps): void {
  const validation = ops.validateReviewPromise
    ? ops.validateReviewPromise(args.reviewPromise)
    : validatePromise(args.reviewPromise);
  if (validation.status !== "complete" || !validation.promise) {
    throw new Error("validated reviewer approval is missing; automatic merge stopped");
  }
  if (validation.promise.status !== "complete" || validation.promise.outcome !== "approved") {
    throw new Error("review result is not approved; automatic merge stopped");
  }
  if (validation.promise.reviewedHead !== args.expectedHead) {
    throw new Error("reviewed head does not match the guarded merge head; automatic merge stopped");
  }
  if (!Array.isArray(validation.promise.findings) || validation.promise.findings.length !== 0) {
    throw new Error("approved review findings are missing or non-empty; automatic merge stopped");
  }
}

const SUCCESSFUL_CHECK_RESULTS = new Set(["SUCCESS", "SUCCESSFUL", "NEUTRAL", "SKIPPED"]);
const PENDING_CHECK_STATES = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED", "WAITING", "REQUESTED"]);

function assertChecksPassed(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("CI checks are missing; automatic merge stopped");
  }
  for (const check of value) {
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      throw new Error("CI check state is unknown; automatic merge stopped");
    }
    const record = check as { status?: unknown; state?: unknown; conclusion?: unknown };
    const status = String(record.status || "").toUpperCase();
    const state = String(record.state || "").toUpperCase();
    const conclusion = String(record.conclusion || "").toUpperCase();
    if (PENDING_CHECK_STATES.has(status) || PENDING_CHECK_STATES.has(state)) {
      throw new Error("CI checks have not completed; automatic merge stopped");
    }
    if (!status && !state && !conclusion) {
      throw new Error("CI check state is unknown; automatic merge stopped");
    }
    if (!SUCCESSFUL_CHECK_RESULTS.has(conclusion) && !SUCCESSFUL_CHECK_RESULTS.has(state)) {
      throw new Error("CI checks did not pass; automatic merge stopped");
    }
  }
}

function assertCurrentPrEligible(args: MergeArgs, ops: MergeOps): void {
  const result = ops.run([
    "gh", "pr", "view", args.pr, "-R", args.githubRepo,
    "--json", "state,isDraft,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,labels",
  ], MAX_GUARDED_OPERATION_MS);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "PR state could not be revalidated").trim());
  let pr: {
    state?: unknown;
    isDraft?: unknown;
    headRefOid?: unknown;
    mergeable?: unknown;
    mergeStateStatus?: unknown;
    statusCheckRollup?: unknown;
    labels?: unknown;
  };
  try {
    pr = JSON.parse(result.stdout || "{}");
  } catch {
    throw new Error("PR state response was invalid; automatic merge stopped");
  }
  const labels = new Set(
    Array.isArray(pr.labels)
      ? pr.labels.map((label: unknown) => label && typeof label === "object" ? (label as { name?: unknown }).name : undefined)
        .filter((name): name is string => typeof name === "string")
      : [],
  );
  if (pr.state !== "OPEN") throw new Error("PR is no longer open; automatic merge stopped");
  if (pr.isDraft !== false) throw new Error("PR is draft or its draft state is unknown; automatic merge stopped");
  if (pr.headRefOid !== args.expectedHead) throw new Error("PR head changed; automatic merge stopped");
  if (pr.mergeable !== "MERGEABLE") throw new Error("PR mergeability is not confirmed; automatic merge stopped");
  if (pr.mergeStateStatus !== "CLEAN") throw new Error("PR merge state is not clean; automatic merge stopped");
  assertChecksPassed(pr.statusCheckRollup);
  if (!labels.has(args.reviewLabel) || !labels.has(args.reviewingLabel)) {
    throw new Error("required review labels are no longer present; automatic merge stopped");
  }
  if (labels.has(args.blockedLabel)) throw new Error("PR is blocked; automatic merge stopped");
}

function mergeReviewedPr(args: MergeArgs, ops: MergeOps = { run: defaultRun }): number {
  const project = { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt };
  const operation = (enabled: EnabledProject, recheck: () => void = () => {}) => {
    const autoMergeEnabled = ops.isAutoMergeEnabled ? ops.isAutoMergeEnabled(args) : currentAutoMergeEnabled(args);
    if (!autoMergeEnabled) throw new Error("autoMerge is not currently enabled; automatic merge stopped");
    assertMergeAuthorized(enabled);
    assertReviewApproved(args, ops);
    assertCurrentPrEligible(args, ops);
    recheck();
    const autoMergeStillEnabled = ops.isAutoMergeEnabled ? ops.isAutoMergeEnabled(args) : currentAutoMergeEnabled(args);
    if (!autoMergeStillEnabled) throw new Error("autoMerge is not currently enabled; automatic merge stopped");
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
  if (!values.projectRepo || !values.githubRepo || !values.stateDir || !values.pr || !values.expectedHead || !values.reviewPromise || !values.reviewLabel || !values.reviewingLabel || !values.blockedLabel || !Number.isFinite(enabledAt)) {
    throw new Error("--project-repo, --github-repo, --state-dir, --enabled-at, --pr, --expected-head, --review-promise, --review-label, --reviewing-label, and --blocked-label are required");
  }
  return {
    projectRepo: values.projectRepo,
    githubRepo: values.githubRepo,
    stateDir: values.stateDir,
    enabledAt,
    pr: values.pr,
    expectedHead: values.expectedHead,
    reviewPromise: values.reviewPromise,
    reviewLabel: values.reviewLabel,
    reviewingLabel: values.reviewingLabel,
    blockedLabel: values.blockedLabel,
  };
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
module.exports = { currentAutoMergeEnabled, mergeReviewedPr, parseArgs };
