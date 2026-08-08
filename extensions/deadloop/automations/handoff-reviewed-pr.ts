#!/usr/bin/env node
// Hand one approved PR to a human only while the reviewed head, fixed
// verification contract, host record, and current policy remain authorized.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const {
  assertCurrentWorkerContract,
  assertReviewApprovalAuthorized,
  readRequiredVerificationRecord,
  workerRequiredVerificationPath,
} = require("../../../src/worker-required-verification-runtime.cjs");
const { currentAutoMergeEnabled } = require("./merge-reviewed-pr.ts");

type HandoffArgs = {
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
  humanLabel: string;
};
type EnabledProject = { githubRepositoryId?: string };
type CommandResult = { status: number; stdout: string; stderr: string };
type HandoffOps = {
  run(args: string[], timeoutMs?: number): CommandResult;
  isAutoMergeEnabled?: (args: HandoffArgs) => boolean;
  assertReviewVerification?: (args: HandoffArgs, enabled: EnabledProject) => void;
  withLock?: (
    project: { repoPath: string; githubRepo: string; stateDir: string; enabledAt: number },
    operation: (enabled: EnabledProject, recheck: () => void) => number,
  ) => number;
};

function defaultRun(args: string[], timeoutMs?: number): CommandResult {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" }),
  });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function assertRequiredVerificationApproved(args: HandoffArgs, enabled: EnabledProject): void {
  const attemptRecordFile = path.join(path.dirname(args.reviewPromise), "attempt.json");
  const attempt = readAttemptRecord(path.dirname(attemptRecordFile));
  const report = JSON.parse(fs.readFileSync(args.reviewPromise, "utf8"));
  const contract = assertCurrentWorkerContract(
    attempt,
    args.projectRepo,
    process.env.DEADLOOP_CONFIG || path.join(args.stateDir, "projects.json"),
    enabled.githubRepositoryId,
  );
  assertReviewApprovalAuthorized(
    attempt,
    report,
    readRequiredVerificationRecord(workerRequiredVerificationPath(attemptRecordFile)),
    contract,
  );
  if (report.result.reviewedHead !== args.expectedHead) {
    throw new Error("required verification reviewed head changed; human handoff stopped");
  }
}

type CurrentPr = { state?: unknown; isDraft?: unknown; headRefOid?: unknown; labels: Set<string> };

function readCurrentPr(args: HandoffArgs, ops: HandoffOps): CurrentPr {
  const result = ops.run([
    "gh", "pr", "view", args.pr, "-R", args.githubRepo,
    "--json", "state,isDraft,headRefOid,labels",
  ], MAX_GUARDED_OPERATION_MS);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "PR state could not be revalidated").trim());
  let value: { state?: unknown; isDraft?: unknown; headRefOid?: unknown; labels?: unknown };
  try {
    value = JSON.parse(result.stdout || "{}");
  } catch {
    throw new Error("PR state response was invalid; human handoff stopped");
  }
  const labels = new Set(Array.isArray(value.labels)
    ? value.labels.map((label: unknown) => label && typeof label === "object" ? (label as { name?: unknown }).name : undefined)
      .filter((name): name is string => typeof name === "string")
    : []);
  return { ...value, labels };
}

function assertCurrentPrEligible(args: HandoffArgs, ops: HandoffOps): void {
  const pr = readCurrentPr(args, ops);
  if (pr.state !== "OPEN") throw new Error("PR is no longer open; human handoff stopped");
  if (pr.isDraft !== false) throw new Error("PR is draft or its draft state is unknown; human handoff stopped");
  if (pr.headRefOid !== args.expectedHead) throw new Error("PR head changed; human handoff stopped");
  if (!pr.labels.has(args.reviewLabel) || !pr.labels.has(args.reviewingLabel)) {
    throw new Error("required review labels are no longer present; human handoff stopped");
  }
  if (pr.labels.has(args.blockedLabel)) throw new Error("PR is blocked; human handoff stopped");
}

function assertHandoffApplied(args: HandoffArgs, ops: HandoffOps): void {
  const pr = readCurrentPr(args, ops);
  if (pr.headRefOid !== args.expectedHead
    || !pr.labels.has(args.humanLabel)
    || pr.labels.has(args.reviewLabel)
    || pr.labels.has(args.reviewingLabel)
    || pr.labels.has(args.blockedLabel)) {
    throw new Error("human handoff postcondition changed");
  }
}

function restoreReviewState(args: HandoffArgs, ops: HandoffOps): void {
  const result = ops.run([
    "gh", "pr", "edit", args.pr, "-R", args.githubRepo,
    "--remove-label", args.humanLabel,
    "--add-label", args.reviewLabel,
    "--add-label", args.reviewingLabel,
  ], MAX_GUARDED_OPERATION_MS);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "review-state restoration failed").trim());
  const pr = readCurrentPr(args, ops);
  if (pr.labels.has(args.humanLabel) || !pr.labels.has(args.reviewLabel) || !pr.labels.has(args.reviewingLabel)) {
    throw new Error("review-state restoration could not be confirmed");
  }
}

function handoffReviewedPr(args: HandoffArgs, ops: HandoffOps = { run: defaultRun }): number {
  const project = { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt };
  const operation = (enabled: EnabledProject, recheck: () => void = () => {}) => {
    const autoMergeEnabled = ops.isAutoMergeEnabled || currentAutoMergeEnabled;
    if (autoMergeEnabled(args)) throw new Error("autoMerge is currently enabled; human handoff stopped");
    assertCurrentPrEligible(args, ops);
    recheck();
    if (autoMergeEnabled(args)) throw new Error("autoMerge is currently enabled; human handoff stopped");
    const assertVerification = ops.assertReviewVerification || assertRequiredVerificationApproved;
    assertVerification(args, enabled);
    assertCurrentPrEligible(args, ops);
    assertVerification(args, enabled);
    if (autoMergeEnabled(args)) throw new Error("autoMerge is currently enabled; human handoff stopped");
    const result = ops.run([
      "gh", "pr", "edit", args.pr, "-R", args.githubRepo,
      "--remove-label", args.reviewLabel,
      "--remove-label", args.reviewingLabel,
      "--add-label", args.humanLabel,
    ], MAX_GUARDED_OPERATION_MS);
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "guarded human handoff failed").trim());
    try {
      assertHandoffApplied(args, ops);
    } catch (error) {
      restoreReviewState(args, ops);
      throw new Error(`human handoff stopped and review state restored: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 0;
  };
  return ops.withLock ? ops.withLock(project, operation) : withEnabledProjectLock(project, operation);
}

function parseArgs(argv: string[]): HandoffArgs {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  const enabledAt = Number(values.enabledAt);
  const required = ["projectRepo", "githubRepo", "stateDir", "pr", "expectedHead", "reviewPromise", "reviewLabel", "reviewingLabel", "blockedLabel", "humanLabel"];
  if (required.some((name) => !values[name]) || !Number.isFinite(enabledAt)) {
    throw new Error("all handoff binding and label arguments are required");
  }
  return { ...(values as unknown as HandoffArgs), enabledAt };
}

function main(): void {
  try {
    process.exitCode = handoffReviewedPr(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`handoff-reviewed-pr.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();
module.exports = { handoffReviewedPr, parseArgs };
