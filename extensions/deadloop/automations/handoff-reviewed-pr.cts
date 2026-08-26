#!/usr/bin/env node
// Hand one approved PR back to people only while its accepted review history is current: the draft
// becomes ready and every agent workflow label is removed, so GitHub shows a pull request no Agent
// request is waiting on. The mutation is serialized with /deadloop-disable through the enablement
// lock, and the ready transition runs first so a failed label removal leaves the requests visible
// instead of stranding a silently unlabelled draft.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { reauthorizeReviewWrite } = require("../../../src/worker-required-verification-runtime.cjs");
const { currentAutoMergeEnabled } = require("./merge-reviewed-pr.cts");
const { validatePromise } = require("./extract-worker-promise.cts");
const {
  comparePrHistoryObservations,
  observePrHistory,
  readPrHistoryObservation,
} = require("../../../src/pr-review-history.cts");
const { humanHandoffComplete, humanHandoffLabelMove } = require("../../../src/human-handoff.cts");

import type { JsonObject } from "../../../src/automation-driver-kit-types";

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
  implementLabel: string;
  updateBranchLabel: string;
  inProgressLabel: string;
  blockedLabel: string;
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

function assertApproved(args: HandoffArgs, ops: HandoffOps): void {
  const validation = ops.validateReviewPromise?.(args.reviewPromise) || validatePromise(args.reviewPromise);
  const promise = validation.promise;
  if (validation.evidenceStrength !== "strong" || validation.status !== "complete" || !promise || promise.status !== "complete") {
    throw new Error("validated reviewer approval is missing; ready handoff stopped");
  }
  if (promise.outcome !== "approved" || promise.reviewedHead !== args.expectedHead
    || !Array.isArray(promise.findings) || promise.findings.length !== 0) {
    throw new Error("reviewer approval is not bound to the expected head; ready handoff stopped");
  }
}

function assertRequiredVerificationApproved(args: HandoffArgs, enabled: EnabledProject): void {
  const attemptRecordFile = path.join(path.dirname(args.reviewPromise), "attempt.json");
  const attempt = readAttemptRecord(path.dirname(attemptRecordFile));
  const report = JSON.parse(fs.readFileSync(args.reviewPromise, "utf8"));
  reauthorizeReviewWrite(attempt, {
    projectRepo: args.projectRepo,
    localConfigPath: process.env.DEADLOOP_CONFIG || path.join(args.stateDir, "projects.json"),
    repositoryId: enabled.githubRepositoryId,
    report,
    attemptRecordFile,
  });
  if (report.result.reviewedHead !== args.expectedHead) {
    throw new Error("required verification reviewed head changed; ready handoff stopped");
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
    "--remove-label", args.inProgressLabel, "--add-label", args.reviewLabel,
  ], MAX_GUARDED_OPERATION_MS);
  if (result.status !== 0) throw new Error(commandError(result, "stale review claim could not be released"));
  return { action: "stale_history" };
}

function compareAcceptedHistory(args: HandoffArgs, ops: HandoffOps, expected: JsonObject): boolean {
  return comparePrHistoryObservations(expected, currentHistory(args, ops)).kind === "unchanged";
}


type CurrentPr = JsonObject & { labels: Set<string> };

function readCurrentPr(args: HandoffArgs, ops: HandoffOps): CurrentPr {
  const result = ops.run([
    "gh", "pr", "view", args.pr, "-R", args.githubRepo,
    "--json", "state,isDraft,headRefOid,labels",
  ], MAX_GUARDED_OPERATION_MS);
  if (result.status !== 0) throw new Error(commandError(result, "PR state could not be revalidated"));
  let pr: JsonObject;
  try { pr = JSON.parse(result.stdout || "{}"); } catch { throw new Error("PR state response was invalid; ready handoff stopped"); }
  const labels = new Set(Array.isArray(pr.labels) ? pr.labels.map((label) => label?.name).filter((name) => typeof name === "string") : []);
  return { ...pr, labels };
}

function assertEligiblePr(args: HandoffArgs, ops: HandoffOps): CurrentPr {
  const pr = readCurrentPr(args, ops);
  if (pr.state !== "OPEN" || pr.headRefOid !== args.expectedHead) {
    throw new Error("PR is no longer eligible for ready handoff");
  }
  if (!pr.labels.has(args.inProgressLabel) || pr.labels.has(args.blockedLabel)) {
    throw new Error("the active review claim state is no longer present; ready handoff stopped");
  }
  return pr;
}

// The postcondition is the one shared human-handoff definition: ready, and no agent workflow label
// left. An unknown draft state counts as still draft, so only an observed ready PR passes.
function assertHandoffApplied(args: HandoffArgs, ops: HandoffOps): void {
  const pr = readCurrentPr(args, ops);
  if (pr.state !== "OPEN" || pr.headRefOid !== args.expectedHead
    || !humanHandoffComplete({ isDraft: pr.isDraft as boolean, labels: [...pr.labels] }, args)) {
    throw new Error("ready handoff postcondition changed");
  }
}

function restoreReviewState(args: HandoffArgs, ops: HandoffOps): void {
  const result = ops.run([
    "gh", "pr", "edit", args.pr, "-R", args.githubRepo,
    "--add-label", args.inProgressLabel,
  ], MAX_GUARDED_OPERATION_MS);
  if (result.status !== 0) throw new Error(commandError(result, "review-state restoration failed"));
  if (!readCurrentPr(args, ops).labels.has(args.inProgressLabel)) {
    throw new Error("review-state restoration could not be confirmed");
  }
}

function handoffReviewedPr(args: HandoffArgs, ops: HandoffOps = { run: defaultRun }): HandoffResult {
  const project = { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt };
  const operation = (enabled: EnabledProject, recheck: () => void): HandoffResult => {
    const autoMergeEnabled = ops.isAutoMergeEnabled || currentAutoMergeEnabled;
    if (autoMergeEnabled(args)) throw new Error("autoMerge is currently enabled; ready handoff stopped");
    assertApproved(args, ops);
    const assertVerification = ops.assertReviewVerification || assertRequiredVerificationApproved;
    assertVerification(args, enabled);
    const expected = ops.readHistory?.(args.historyObservation) || readPrHistoryObservation(args.historyObservation);
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
    const eligible = assertEligiblePr(args, ops);
    if (autoMergeEnabled(args)) throw new Error("autoMerge is currently enabled; ready handoff stopped");
    // The accepted review history is the last external observation before the mutation, and the
    // fixed contract, current policy and current-head success record are re-authenticated after it.
    // A policy or history change during the reads above therefore cannot hand a stale approval to
    // people, and the same conditions are confirmed again once the mutation has been applied.
    if (expected && !compareAcceptedHistory(args, ops, expected)) {
      recheck();
      return releaseStaleClaim(args, ops);
    }
    assertVerification(args, enabled);
    recheck();
    if (eligible.isDraft === true) {
      const ready = ops.run(["gh", "pr", "ready", args.pr, "-R", args.githubRepo], MAX_GUARDED_OPERATION_MS);
      if (ready.status !== 0) throw new Error(commandError(ready, "reviewed PR could not be marked ready"));
    }
    const result = ops.run([
      "gh", "pr", "edit", args.pr, "-R", args.githubRepo,
      ...humanHandoffLabelMove(args).remove.flatMap((label) => ["--remove-label", label]),
    ], MAX_GUARDED_OPERATION_MS);
    if (result.status !== 0) throw new Error(commandError(result, "reviewed PR ready handoff failed"));
    try {
      assertHandoffApplied(args, ops);
      if (expected && !compareAcceptedHistory(args, ops, expected)) {
        throw new Error("accepted review history changed during the ready handoff");
      }
      assertVerification(args, enabled);
    } catch (error) {
      restoreReviewState(args, ops);
      throw new Error(`ready handoff stopped and review state restored: ${error instanceof Error ? error.message : String(error)}`);
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
  const required = ["projectRepo", "githubRepo", "stateDir", "pr", "expectedHead", "reviewPromise", "historyObservation", "reviewLabel", "implementLabel", "updateBranchLabel", "inProgressLabel", "blockedLabel"];
  if (required.some((name) => !values[name]) || !Number.isFinite(enabledAt)) throw new Error("required ready handoff arguments are missing");
  return { ...values, enabledAt } as HandoffArgs;
}

function main(): void {
  try {
    process.stdout.write(`${JSON.stringify(handoffReviewedPr(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    console.error(`handoff-reviewed-pr.cts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();
module.exports = { handoffReviewedPr, parseArgs };
