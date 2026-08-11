#!/usr/bin/env node
// Hand one approved PR to a human only while its accepted review history is
// current and the reviewed head, fixed verification contract, host record, and
// current policy remain authorized. The label mutation is serialized with
// /deadloop-disable through the enablement lock.

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
const { validatePromise } = require("./extract-worker-promise.ts");
const {
  comparePrHistoryObservations,
  observePrHistory,
  readPrHistoryObservation,
} = require("../../../src/pr-review-history.ts");

import type { JsonObject } from "../../../src/automation-driver-kit";

type HandoffArgs = {
  projectRepo: string;
  githubRepo: string;
  stateDir: string;
  enabledAt: number;
  pr: string;
  expectedHead: string;
  reviewPromise: string;
  historyObservation: string;
  reviewLabel: string;
  reviewingLabel: string;
  inProgressLabel: string;
  blockedLabel: string;
  humanLabel: string;
};
type EnabledProject = { githubRepositoryId?: string };
type CommandResult = { status: number; stdout: string; stderr: string };
type HandoffResult = { action: "handed_off" | "stale_history" };
type HandoffOps = {
  run(args: string[], timeoutMs?: number): CommandResult;
  isAutoMergeEnabled?: (args: HandoffArgs) => boolean;
  assertReviewVerification?: (args: HandoffArgs, enabled: EnabledProject) => void;
  validateReviewPromise?: (file: string) => { status?: unknown; promise?: JsonObject; evidenceStrength?: unknown };
  readHistory?: (file: string) => JsonObject;
  observeHistory?: (repository: string, pr: number) => JsonObject;
  withLock?: (
    project: { repoPath: string; githubRepo: string; stateDir: string; enabledAt: number },
    operation: (enabled: EnabledProject, recheck: () => void) => HandoffResult,
  ) => HandoffResult;
};

function defaultRun(args: string[], timeoutMs?: number): CommandResult {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" }),
  });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function commandError(result: CommandResult, fallback: string): string {
  return (result.stderr || result.stdout || fallback).trim();
}

function assertApproved(args: HandoffArgs, ops: HandoffOps): { legacyApproval: boolean } {
  const validation = ops.validateReviewPromise?.(args.reviewPromise) || validatePromise(args.reviewPromise);
  const promise = validation.promise;
  const legacyApproval = validation.evidenceStrength === "legacy-weak"
    && promise?.status === "complete"
    && (promise.outcome === undefined || promise.outcome === "approved")
    && (promise.findings === undefined || Array.isArray(promise.findings) && promise.findings.length === 0);
  if (validation.status !== "complete" || !promise || promise.status !== "complete") {
    throw new Error("validated reviewer approval is missing; human handoff stopped");
  }
  if (!legacyApproval && (promise.outcome !== "approved" || promise.reviewedHead !== args.expectedHead
    || !Array.isArray(promise.findings) || promise.findings.length !== 0)) {
    throw new Error("reviewer approval is not bound to the expected head; human handoff stopped");
  }
  return { legacyApproval };
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

function currentHistory(args: HandoffArgs, ops: HandoffOps): JsonObject {
  if (ops.observeHistory) return ops.observeHistory(args.githubRepo, Number(args.pr));
  const runner = {
    runText(command: string[]): string {
      const result = ops.run(command, MAX_GUARDED_OPERATION_MS);
      if (result.status !== 0) throw new Error(commandError(result, "PR history could not be observed"));
      return result.stdout;
    },
    runJson(command: string[]): unknown { return JSON.parse(this.runText(command)); },
  };
  return observePrHistory(args.githubRepo, Number(args.pr), runner);
}

function releaseStaleClaim(args: HandoffArgs, ops: HandoffOps): HandoffResult {
  const result = ops.run([
    "gh", "pr", "edit", args.pr, "-R", args.githubRepo,
    "--remove-label", args.inProgressLabel, "--remove-label", args.reviewingLabel, "--add-label", args.reviewLabel,
  ], MAX_GUARDED_OPERATION_MS);
  if (result.status !== 0) throw new Error(commandError(result, "stale review claim could not be released"));
  return { action: "stale_history" };
}

function compareAcceptedHistory(args: HandoffArgs, ops: HandoffOps, expected: JsonObject): boolean {
  return comparePrHistoryObservations(expected, currentHistory(args, ops)).kind === "unchanged";
}

type CurrentPr = { state?: unknown; isDraft?: unknown; headRefOid?: unknown; labels: Set<string> };

function readCurrentPr(args: HandoffArgs, ops: HandoffOps): CurrentPr {
  const result = ops.run([
    "gh", "pr", "view", args.pr, "-R", args.githubRepo,
    "--json", "state,isDraft,headRefOid,labels",
  ], MAX_GUARDED_OPERATION_MS);
  if (result.status !== 0) throw new Error(commandError(result, "PR state could not be revalidated"));
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

function assertEligiblePr(args: HandoffArgs, ops: HandoffOps): void {
  const pr = readCurrentPr(args, ops);
  if (pr.state !== "OPEN" || pr.isDraft !== false || pr.headRefOid !== args.expectedHead) {
    throw new Error("PR is no longer eligible for human handoff");
  }
  if (!pr.labels.has(args.inProgressLabel) || pr.labels.has(args.blockedLabel)) {
    throw new Error("the active review claim state is no longer present; human handoff stopped");
  }
}

function assertHandoffApplied(args: HandoffArgs, ops: HandoffOps): void {
  const pr = readCurrentPr(args, ops);
  if (pr.headRefOid !== args.expectedHead
    || !pr.labels.has(args.humanLabel)
    || pr.labels.has(args.inProgressLabel)
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
    "--add-label", args.inProgressLabel,
  ], MAX_GUARDED_OPERATION_MS);
  if (result.status !== 0) throw new Error(commandError(result, "review-state restoration failed"));
  const pr = readCurrentPr(args, ops);
  if (pr.labels.has(args.humanLabel) || !pr.labels.has(args.inProgressLabel)) {
    throw new Error("review-state restoration could not be confirmed");
  }
}

function handoffReviewedPr(args: HandoffArgs, ops: HandoffOps = { run: defaultRun }): HandoffResult {
  const project = { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt };
  const operation = (enabled: EnabledProject, recheck: () => void): HandoffResult => {
    const autoMergeEnabled = ops.isAutoMergeEnabled || currentAutoMergeEnabled;
    if (autoMergeEnabled(args)) throw new Error("autoMerge is currently enabled; human handoff stopped");
    const { legacyApproval } = assertApproved(args, ops);
    const assertVerification = ops.assertReviewVerification || assertRequiredVerificationApproved;
    if (!legacyApproval) assertVerification(args, enabled);
    const expected = legacyApproval
      ? undefined
      : ops.readHistory?.(args.historyObservation) || readPrHistoryObservation(args.historyObservation);
    if (expected && !compareAcceptedHistory(args, ops, expected)) {
      recheck();
      return releaseStaleClaim(args, ops);
    }
    assertEligiblePr(args, ops);
    recheck();
    if (expected && !compareAcceptedHistory(args, ops, expected)) {
      recheck();
      return releaseStaleClaim(args, ops);
    }
    assertEligiblePr(args, ops);
    if (!legacyApproval) assertVerification(args, enabled);
    if (autoMergeEnabled(args)) throw new Error("autoMerge is currently enabled; human handoff stopped");
    recheck();
    const result = ops.run([
      "gh", "pr", "edit", args.pr, "-R", args.githubRepo,
      "--remove-label", args.inProgressLabel, "--remove-label", args.reviewLabel, "--remove-label", args.reviewingLabel,
      "--add-label", args.humanLabel,
    ], MAX_GUARDED_OPERATION_MS);
    if (result.status !== 0) throw new Error(commandError(result, "reviewed PR human handoff failed"));
    try {
      assertHandoffApplied(args, ops);
    } catch (error) {
      restoreReviewState(args, ops);
      throw new Error(`human handoff stopped and review state restored: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { action: "handed_off" };
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
  const required = ["projectRepo", "githubRepo", "stateDir", "pr", "expectedHead", "reviewPromise", "historyObservation", "reviewLabel", "reviewingLabel", "inProgressLabel", "blockedLabel", "humanLabel"];
  if (required.some((name) => !values[name]) || !Number.isFinite(enabledAt)) throw new Error("required human handoff arguments are missing");
  return { ...values, enabledAt } as unknown as HandoffArgs;
}

function main(): void {
  try {
    process.stdout.write(`${JSON.stringify(handoffReviewedPr(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    console.error(`handoff-reviewed-pr.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();
module.exports = { handoffReviewedPr, parseArgs };
