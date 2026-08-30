#!/usr/bin/env node

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { createCommandRunner } = require("../../../src/automation-driver-kit.cts");
const { readAttemptRecord, validateCompletionReportBinding } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { normalizeCompletionReportCommitShas } = require("../../../src/completion-report-normalization.cjs");

type JsonObject = Record<string, any>;
type CompletionOps = { run(script: string, args: string[]): JsonObject };

function flag(name: string, value: unknown): string[] {
  return value === undefined || value === null || value === "" ? [] : [`--${name}`, String(value)];
}

function common(input: JsonObject): string[] {
  return [
    ...flag("attempt-record", input.attemptRecordFile),
    ...flag("project-id", input.projectId),
    ...flag("project-repo", input.repoPath),
    ...flag("github-repo", input.githubRepo),
    ...flag("state-dir", input.stateDir),
    ...flag("enabled-at", input.enabledAt),
  ];
}

function managedLabels(input: JsonObject): string[] {
  return [input.reviewLabel, input.implementLabel, input.updateBranchLabel, input.inProgressLabel, input.blockedLabel]
    .filter(Boolean).flatMap((label) => flag("managed-label", label));
}

/**
 * The explicit human-handoff expectation for a completed review: closure must prove the shared
 * handoff state instead of inferring it from an empty expected label set.
 */
function handoffExpectationLabels(input: JsonObject): string[] {
  return [
    ...flag("handoff-review-label", input.reviewLabel),
    ...flag("handoff-implement-label", input.implementLabel),
    ...flag("handoff-update-branch-label", input.updateBranchLabel),
    ...flag("handoff-in-progress-label", input.inProgressLabel),
    ...flag("handoff-blocked-label", input.blockedLabel),
  ];
}

function completeWorkspace(input: JsonObject, ops: CompletionOps, expectedLabels: string[] = []): JsonObject {
  return ops.run("complete-attempt-workspace.cts", [
    ...common(input),
    ...expectedLabels.flatMap((label) => flag("expected-label", label)),
    ...managedLabels(input),
    ...("autoMerge" in input ? flag("auto-merge", String(Boolean(input.autoMerge))) : []),
  ]);
}

function completeHumanHandoffWorkspace(input: JsonObject, ops: CompletionOps): JsonObject {
  return ops.run("complete-attempt-workspace.cts", [...common(input), ...handoffExpectationLabels(input)]);
}

function persistAttempt(input: JsonObject, ops: CompletionOps): JsonObject {
  return ops.run("persist-attempt-result.cts", [...common(input), ...flag("review-label", input.reviewLabel)]);
}

function dispatcherArgs(input: JsonObject, record: JsonObject): string[] {
  return [
    ...flag("promise", input.promiseFile), ...flag("attempt-record", input.attemptRecordFile),
    ...flag("request-event-id", input.requestEventId || record.requestEventId),
    ...flag("pr", input.prNumber), ...flag("expected-head", input.expectedHeadOid),
    ...flag("branch", input.branch), ...flag("github-repo", input.githubRepo),
    ...flag("repo-path", input.repoPath),
    ...flag("project-id", input.projectId), ...flag("state-dir", input.stateDir), ...flag("enabled-at", input.enabledAt),
    ...flag("review-label", input.reviewLabel), ...flag("blocked-label", input.blockedLabel),
    ...flag("implement-label", input.implementLabel), ...flag("update-branch-label", input.updateBranchLabel),
    ...flag("in-progress-label", input.inProgressLabel),
  ];
}

function ciFallbackGateArgs(input: JsonObject): string[] {
  return [
    ...flag("attempt-record", input.attemptRecordFile),
    ...flag("pr", input.prNumber), ...flag("expected-head", input.expectedHeadOid),
    ...flag("branch", input.branch), ...flag("github-repo", input.githubRepo),
    ...flag("repo-path", input.repoPath),
    ...flag("project-id", input.projectId), ...flag("state-dir", input.stateDir), ...flag("enabled-at", input.enabledAt),
    ...flag("required-verification", input.requiredVerification ? JSON.stringify(input.requiredVerification) : undefined),
    ...flag("worker-agent", input.workerAgent || "pi"),
    ...flag("worker-model", input.workerModel), ...flag("repair-model", input.repairModel),
    ...flag("remote", input.repairRemote || "origin"),
    ...flag("review-label", input.reviewLabel), ...flag("blocked-label", input.blockedLabel),
    ...flag("implement-label", input.implementLabel), ...flag("update-branch-label", input.updateBranchLabel),
    ...flag("in-progress-label", input.inProgressLabel),
  ];
}

function processBranchUpdate(input: JsonObject, report: JsonObject, ops: CompletionOps): JsonObject {
  if (report.status === "blocked") return { applied: true, result: "branch_update_blocked_retained" };
  if (report.result?.outcome === "stale_head") {
    return { applied: completeWorkspace(input, ops).driverAction === "workspace_closed", result: "branch_update_stale_head" };
  }
  const completed = ops.run("pr-branch-update-complete.cts", [
    ...flag("promise", input.promiseFile), ...common(input), ...flag("pr", input.prNumber),
    ...flag("expected-head", input.expectedHeadOid), ...flag("review-label", input.reviewLabel),
    ...flag("implement-label", input.implementLabel), ...flag("update-branch-label", input.updateBranchLabel),
    ...flag("in-progress-label", input.inProgressLabel), ...flag("blocked-label", input.blockedLabel),
  ]);
  if (!["branch_update_review_requested", "branch_update_review_already_requested"].includes(String(completed.driverAction))) {
    return { applied: false, result: completed };
  }
  const persisted = persistAttempt(input, ops);
  if (persisted.driverAction !== "result_persisted") return { applied: false, result: persisted };
  const closed = completeWorkspace(input, ops, [input.reviewLabel]);
  return { applied: closed.driverAction === "workspace_closed", result: completed.driverAction };
}

// Repair results whose public evidence is confirmed (posted, already posted, or stale) close the
// workspace exactly like the migrated prompt contract; every other result keeps its workspace for
// inspection and leaves recovery to the existing surfaces.
const REPAIR_CLOSING_RESULTS = new Set(["repair_result_posted", "repair_result_duplicate", "repair_stale_head"]);

function processRepair(input: JsonObject, ops: CompletionOps): JsonObject {
  const runDir = path.dirname(String(input.promiseFile));
  const completed = ops.run("pr-review-repair-complete.cts", [
    ...flag("promise", input.promiseFile), ...common(input),
    ...flag("result", path.join(runDir, "finalizer-result.json")),
    ...flag("contract", path.join(runDir, "review-contract.json")),
    ...flag("pr", input.prNumber), ...flag("branch", input.branch),
    ...flag("expected-head", input.expectedHeadOid), ...flag("attempt-key", input.attemptKey),
    ...flag("review-label", input.reviewLabel), ...flag("implement-label", input.implementLabel),
    ...flag("update-branch-label", input.updateBranchLabel), ...flag("in-progress-label", input.inProgressLabel),
    ...flag("blocked-label", input.blockedLabel),
  ]);
  if (!REPAIR_CLOSING_RESULTS.has(String(completed.driverAction))) {
    return { applied: true, result: completed };
  }
  const closed = completeWorkspace(input, ops);
  return { applied: closed.driverAction === "workspace_closed", result: completed.driverAction };
}

function processReviewer(input: JsonObject, record: JsonObject, report: JsonObject, ops: CompletionOps): JsonObject {
  if (report.status === "complete" && report.result?.outcome === "approved") {
    try {
      ops.run("run-worker-required-verification.cts", [
        ...common(input), ...flag("worktree", input.worktreePath),
        ...flag("quarantine-root", path.join(input.stateDir, "check-quarantine")), ...flag("role", "reviewer"),
      ]);
    } catch {
      // The verification command persists its failed evidence before exiting. The dispatcher below
      // turns that evidence into the existing idempotent approval stop instead of rerunning the
      // expensive check on every scheduler tick.
    }
  }
  const dispatched = ops.run("pr-review-repair-dispatch.cts", dispatcherArgs(input, record));
  if (dispatched.action === "monitor" && dispatched.monitorHandoff?.kind === "repair") {
    return { applied: true, nextHandoff: dispatched, result: dispatched.driverAction };
  }
  if (dispatched.driverAction === "review_approved") {
    const acceptedHistory = path.join(path.dirname(input.promiseFile), "pr-review-history-accepted.json");
    let policyResult: JsonObject;
    let closedWorkspaceForMerge = false;
    if (input.autoMerge) {
      // GitHub checks are one health signal: a failed terminal check set may be replaced by fresh
      // CI-equivalent verification of the exact prospective merge tree (ADR 0030).
      const gate = ops.run("ci-fallback-gate.cts", ciFallbackGateArgs(input));
      if (String(gate.driverAction || "") === "ci_fallback_repair_requested") {
        // The gate already closed the reviewer workspace as part of the request transition.
        return { applied: true, result: gate.driverAction };
      }
      if (gate.action !== "proceed_merge") {
        return { applied: false, result: String(gate.reason || "ci_fallback_gate_stopped"), gate };
      }
      policyResult = ops.run("merge-reviewed-pr.cts", [
        ...flag("attempt-record", input.attemptRecordFile), ...flag("project-repo", input.repoPath),
        ...flag("github-repo", input.githubRepo), ...flag("state-dir", input.stateDir), ...flag("enabled-at", input.enabledAt),
        ...flag("pr", input.prNumber), ...flag("expected-head", input.expectedHeadOid), ...flag("review-promise", input.promiseFile),
        ...flag("history-observation", acceptedHistory), ...flag("in-progress-label", input.inProgressLabel), ...flag("blocked-label", input.blockedLabel),
        ...flag("ci-fallback-record", gate.basis === "ci_fallback" ? gate.recordPath : undefined),
      ]);
      closedWorkspaceForMerge = true;
    } else {
      policyResult = ops.run("handoff-reviewed-pr.cts", [
        ...flag("project-repo", input.repoPath), ...flag("github-repo", input.githubRepo),
        ...flag("state-dir", input.stateDir), ...flag("enabled-at", input.enabledAt), ...flag("pr", input.prNumber),
        ...flag("expected-head", input.expectedHeadOid), ...flag("review-promise", input.promiseFile),
        ...flag("history-observation", acceptedHistory), ...flag("review-label", input.reviewLabel),
        ...flag("implement-label", input.implementLabel), ...flag("update-branch-label", input.updateBranchLabel),
        ...flag("in-progress-label", input.inProgressLabel), ...flag("blocked-label", input.blockedLabel),
      ]);
    }
    if (policyResult.action === "error") return { applied: false, result: policyResult };
    const closed = closedWorkspaceForMerge
      ? completeWorkspace(input, ops, [input.inProgressLabel])
      : completeHumanHandoffWorkspace(input, ops);
    return { applied: closed.driverAction === "workspace_closed", result: policyResult.driverAction || policyResult.action };
  }
  if (dispatched.driverAction === "review_human_handoff") {
    const closed = completeHumanHandoffWorkspace(input, ops);
    return { applied: closed.driverAction === "workspace_closed", result: dispatched.driverAction };
  }
  if (["review_stale_history", "review_technical_retry"].includes(String(dispatched.driverAction))) {
    const closed = completeWorkspace(input, ops, [input.reviewLabel]);
    return { applied: closed.driverAction === "workspace_closed", result: dispatched.driverAction };
  }
  if (dispatched.driverAction === "review_stale_head") {
    const closed = completeWorkspace(input, ops);
    return { applied: closed.driverAction === "workspace_closed", result: dispatched.driverAction };
  }
  if (dispatched.driverAction === "review_policy_changed") {
    return { applied: false, result: dispatched.driverAction };
  }
  return { applied: true, result: dispatched.driverAction || "review_completion_retained" };
}

function processInput(handoff: JsonObject, ops?: CompletionOps): JsonObject {
  if (!handoff?.input || !["reviewer", "branch-update", "repair"].includes(String(handoff.kind))) {
    throw new Error("deterministic PR completion requires a reviewer, branch-update, or repair handoff");
  }
  const input = handoff.input;
  const record = readAttemptRecord(path.dirname(input.attemptRecordFile));
  const report = normalizeCompletionReportCommitShas(record, JSON.parse(fs.readFileSync(input.promiseFile, "utf8")));
  validateCompletionReportBinding(record, report);
  const commandRunner = createCommandRunner({ timeoutMs: 15 * 60_000 });
  const operations = ops || { run: (script: string, args: string[]) => commandRunner.runJson(["node", path.join(input.automationDir, script), ...args]) };
  if (handoff.kind === "repair") return processRepair(input, operations);
  return handoff.kind === "branch-update"
    ? processBranchUpdate(input, report, operations)
    : processReviewer(input, record, report, operations);
}

function main(): void {
  try {
    const handoff = JSON.parse(fs.readFileSync(0, "utf8"));
    process.stdout.write(`${JSON.stringify(processInput(handoff))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ applied: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  }
}

if (require.main === module) main();
module.exports = { completeWorkspace, completeHumanHandoffWorkspace, dispatcherArgs, processBranchUpdate, processInput, processRepair, processReviewer };
