#!/usr/bin/env node
/**
 * Finishes a stopped review whose result is still owed to the pull request.
 *
 * Completion was reachable only from the reviewer's monitor, so a review that finished while its
 * monitor was gone left its result in the attempt directory and its pull request waiting on an
 * agent request nobody was serving. This is the deterministic entry point for that state: the
 * reviewer role's row in the shared completion contract, driven from the attempt's own evidence.
 *
 * It finishes the outcomes whose completion is a state transition on the pull request. A repairing
 * review completes by launching another agent and an approved review by merging or handing over
 * under gates this caller does not hold, so both are refused by name and left to their monitor.
 * Refusing keeps the ordinary reconciliation blocking the pull request, which is the safe
 * direction, and the reason travels with the refusal.
 */

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { decideReviewTransition } = require("../../../src/reviewer-outcome-contract.ts");
const { provenReviewCompletion } = require("./attempt-completion-proof.ts");
const { dispatch } = require("./pr-review-repair-dispatch.ts");

type JsonObject = Record<string, any>;

type ReviewCompletionOps = { dispatch: (args: JsonObject) => JsonObject };

function completion(args: JsonObject, ops: ReviewCompletionOps = { dispatch }): JsonObject {
  const attemptRecordFile = String(args.attemptRecord || "");
  const runDir = path.dirname(attemptRecordFile);
  const record = readAttemptRecord(runDir);
  if (record.role !== "reviewer") throw new Error("review completion requires a reviewer attempt");
  if (path.resolve(String(args.promise)) !== path.resolve(String(record.promiseFile))) {
    throw new Error("promise does not match the attempt journal's completion report path");
  }
  const proven = provenReviewCompletion(runDir, record);
  if (!proven) throw new Error("the review evidence does not prove a completed review");
  if (proven.expectedHead !== String(args.expectedHead).toLowerCase()) {
    throw new Error("the proven review did not read the expected head");
  }
  const report = JSON.parse(fs.readFileSync(String(record.promiseFile), "utf8"));
  const transition = decideReviewTransition(report.result || {}).transition;
  if (transition !== "human_required") {
    throw new Error(`a ${transition} review completes through its monitor, not through reconciliation`);
  }

  return ops.dispatch({
    promise: String(record.promiseFile),
    attemptRecord: attemptRecordFile,
    requestEventId: String(record.requestEventId || ""),
    pr: String(args.pr),
    expectedHead: proven.expectedHead,
    branch: String(record.branch || ""),
    projectId: String(args.projectId || ""),
    repoPath: String(args.projectRepo || ""),
    githubRepo: String(args.githubRepo || ""),
    stateDir: String(args.stateDir || ""),
    enabledAt: String(args.enabledAt),
    reviewLabel: String(args.reviewLabel || ""),
    implementLabel: String(args.implementLabel || ""),
    updateBranchLabel: String(args.updateBranchLabel || ""),
    inProgressLabel: String(args.inProgressLabel || ""),
    blockedLabel: String(args.blockedLabel || ""),
  });
}

module.exports = { completion };
