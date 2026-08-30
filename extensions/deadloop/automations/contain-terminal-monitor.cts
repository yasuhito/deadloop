const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const { createCommandRunner, createHerdrRunnerFromCommandRunner } = require("../../../src/automation-driver-kit.cts");
const { createGithubOperations } = require("../../../src/github-operations.cts");
const { withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");
const {
  readAttemptRecord,
  releasePersistedAttemptAuthority,
  releasesAttemptOwnership,
} = require("../../../src/attempt-lifecycle-runtime.cjs");
const { closeReceiptPath, observeAttemptRuntime, observeAttemptTurn } = require("../../../src/attempt-runtime-observation.cts");
const { latestPrRequestEvent } = require("../../../src/pr-request-selection.cts");
const { observeMonitorHandoffDisposition, terminalEvidenceArgs } = require("../../../src/monitor-handoff-observation.cts");

import type { MonitorHandoffDisposition } from "../../../src/monitor-handoff-types";

type JsonObject = Record<string, any>;

type ContainmentInput = {
  handoff: JsonObject;
  disposition: MonitorHandoffDisposition;
  project: {
    id: string;
    repoPath: string;
    githubRepo: string;
    stateDir: string;
    enabledAt: number;
    automationLogin: string;
    labels: {
      explore: string;
      implement: string;
      review: string;
      updateBranch: string;
      inProgress: string;
      blocked: string;
    };
  };
};

function attemptRecordFile(handoff: JsonObject): string {
  const input = handoff.input;
  if (!input || typeof input !== "object") return "";
  if (typeof input.attemptRecordFile === "string") return input.attemptRecordFile;
  return typeof input.promiseFile === "string" ? path.join(path.dirname(input.promiseFile), "attempt.json") : "";
}

function readBoundAttempt(recordFile: string): JsonObject {
  const runDir = path.dirname(recordFile);
  return { ...readAttemptRecord(runDir), runDir };
}


function readTerminalEvidence(commandRunner: JsonObject, record: JsonObject): string {
  return commandRunner.runText(["herdr", ...terminalEvidenceArgs(record)], { check: false });
}

function currentDisposition(commandRunner: JsonObject, runner: JsonObject, record: JsonObject, handoffKind?: unknown): MonitorHandoffDisposition {
  return observeMonitorHandoffDisposition(record, handoffKind, {
    runner,
    readTerminalEvidence: (attempt: JsonObject) => readTerminalEvidence(commandRunner, attempt),
  });
}

function labels(value: JsonObject): string[] {
  return (Array.isArray(value.labels) ? value.labels : [])
    .map((label: unknown) => typeof label === "string" ? label : String((label as JsonObject)?.name || ""))
    .filter(Boolean);
}

function exactTarget(github: JsonObject, input: ContainmentInput, record: JsonObject): JsonObject {
  const number = Number(record.target.number);
  const target = record.target.kind === "issue"
    ? github.getIssue(input.project.githubRepo, number)
    : github.getPr(input.project.githubRepo, number);
  if (target.state !== "OPEN" || Number(target.number) !== number) throw new Error("terminal monitor target changed");
  if (record.target.kind === "pull-request"
    && String(target.headRefOid || "").toLowerCase() !== String(record.inputRevision.head || "").toLowerCase()) {
    throw new Error("terminal monitor pull request head changed");
  }
  // A branch update exists only while the pull request still conflicts with the base selected for
  // it; once GitHub reports the conflict resolved, the queued update is obsolete and no failure
  // record applies. A missing or still-computing state proves nothing either way.
  if (record.role === "branch-update" && record.inputRevision?.base
    && String(target.mergeable || "").toUpperCase() === "MERGEABLE") {
    throw new Error("terminal monitor pull request base became obsolete");
  }
  const handoffInput = input.handoff.input || {};
  if (record.target.kind === "issue" && (
    Number(handoffInput.issueNumber) !== number
    || typeof handoffInput.issueTitle === "string" && target.title !== handoffInput.issueTitle
    || typeof handoffInput.issueBody === "string" && target.body !== handoffInput.issueBody
  )) throw new Error("terminal monitor Issue identity changed");
  return target;
}

/** Maps a monitoring disposition to the published stop code: the one operation a person performs. */
function terminalMonitorStopCode(disposition: JsonObject): string {
  if (disposition.action === "wait_for_model") return "wait";
  if (disposition.reason === "storage_exhaustion") return "free_storage";
  return "add_request";
}

/**
 * The published failure record for a terminal monitor stop.
 *
 * Every variant binds its hidden marker to one attempt, the pull-request head fixed at selection
 * time, and — for a branch update — the base head it was selected against, so reprocessing the same
 * failure cannot duplicate the comment and any changed revision starts a different record. Public
 * text names no local worktree or completion-report path.
 */
function commentBody(record: JsonObject, disposition: JsonObject): string {
  const head = String(record.inputRevision?.head || "").toLowerCase();
  const base = String(record.inputRevision?.base || "").toLowerCase();
  const binding = [
    `Pull request head at selection: \`${head}\``,
    ...(base ? [`Selected base head at selection: \`${base}\``] : []),
  ].join("\n");
  // The published reason is the stop code: the one operation a person performs. The cause stays in
  // the prose above it, and the monitoring disposition keeps its own internal vocabulary.
  const stopCode = terminalMonitorStopCode(disposition);
  const stopMarker = `<!-- deadloop:terminal-monitor-stop attempt=${record.attemptId} head=${head}${base ? ` base=${base}` : ""} reason=${stopCode} -->`;
  if (disposition.action === "wait_for_model") {
    return `deadloop paused this attempt because the agent's terminal result reported a recognized model billing or access rejection. The same attempt, workspace, worktree, and agent session remain retained; no monitor prompt will be sent while access is unavailable.\n\n<!-- deadloop:model-availability-wait attempt=${record.attemptId} -->`;
  }
  if (disposition.reason === "active_work_timeout") {
    return `deadloop stopped this attempt because its active work reached the configured runtime limit. Inspect the retained attempt evidence, then add a new Agent request after resolving the failure.\n\n<!-- deadloop:attempt-timeout attempt=${record.attemptId} -->`;
  }
  if (disposition.reason === "storage_exhaustion") {
    return `deadloop stopped this attempt because the host ran out of storage while it ran (a write failed with ENOSPC or EDQUOT, and deadloop could not even read this attempt's completion report because of it). The stopped attempt will not retry automatically and consumed no retry allowance.\nOperator actions:\n- free up storage on the machine running deadloop\n- add a new Agent request once storage is available\n${binding}\n\n${stopMarker}`;
  }
  if (disposition.reason === "invalid_completion_report") {
    // The validation message names the rejected report field (for example a missing summary).
    const detail = String(disposition.detail || "").replace(/^Invalid attempt record: /, "").trim();
    return `deadloop stopped this attempt because its agent turn ended with an invalid completion report. The completion report was rejected: ${detail || "the report did not satisfy the completion contract"}. No monitor prompt will be redelivered. Inspect the retained attempt evidence, then add a new Agent request after resolving the failure.\n${binding}\n\n${stopMarker}`;
  }
  return `deadloop stopped this attempt because its agent turn ended without a valid completion report. No monitor prompt will be redelivered. Inspect the retained attempt evidence, then add a new Agent request after resolving the failure.\n${binding}\n\n${stopMarker}`;
}

function dispositionStillApplies(commandRunner: JsonObject, runner: JsonObject, record: JsonObject, disposition: JsonObject): boolean {
  if (disposition.action === "stop" && disposition.reason === "active_work_timeout") {
    const active = Number(disposition.accounting?.activeMilliseconds || 0);
    const maximum = Number(disposition.maxActiveMilliseconds || 0);
    return maximum > 0 && active >= maximum && observeAttemptTurn(runner, record).kind === "working";
  }
  const observed = currentDisposition(commandRunner, runner, record);
  return observed.action === disposition.action
    && (!("reason" in disposition) || "reason" in observed && observed.reason === disposition.reason);
}

function authorizedCommentExists(github: JsonObject, input: ContainmentInput, record: JsonObject, body: string): boolean {
  const comments = record.target.kind === "issue"
    ? github.listIssueComments(input.project.githubRepo, record.target.number)
    : github.listPrComments(input.project.githubRepo, record.target.number);
  return comments.some((comment: JsonObject) =>
    String(comment.user?.login || comment.author?.login || "").toLowerCase() === input.project.automationLogin.toLowerCase()
    && comment.body === body
    && (!comment.created_at || !comment.updated_at || comment.created_at === comment.updated_at));
}

function writeCloseReceipt(record: JsonObject): void {
  const destination = closeReceiptPath(record);
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({
    schemaVersion: 1,
    attemptId: record.attemptId,
    workspaceId: record.workspaceId,
    worktreePath: record.worktreePath,
    startedAt: new Date().toISOString(),
  })}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, destination);
}

/**
 * A branch-update stop must never stomp a queued `agent:update-branch` request that appeared after
 * this attempt consumed its own generation: moving labels would silently delete that request.
 * Right before the label move, the consumed request event is therefore re-checked; an advanced
 * generation aborts the mutation instead of overwriting newer workflow intent.
 */
function assertBranchUpdateStopGeneration(github: JsonObject, input: ContainmentInput, record: JsonObject): void {
  if (record.role !== "branch-update" || !record.requestEventId || typeof github.listPrTimelineEvents !== "function") return;
  const latest = latestPrRequestEvent(
    github.listPrTimelineEvents(input.project.githubRepo, record.target.number) || [],
    input.project.labels.updateBranch,
  );
  if (latest && String(latest.id || latest.node_id || "") !== String(record.requestEventId)) {
    throw new Error("terminal monitor branch update request generation changed");
  }
}

function replaceStoppedLabels(commandRunner: JsonObject, input: ContainmentInput, record: JsonObject, target: JsonObject): void {
  const managed = new Set([
    input.project.labels.explore,
    input.project.labels.implement,
    input.project.labels.review,
    input.project.labels.updateBranch,
    input.project.labels.inProgress,
    input.project.labels.blocked,
  ]);
  const next = labels(target).filter((label) => !managed.has(label));
  next.push(input.project.labels.blocked);
  commandRunner.runJson([
    "gh", "api", "--method", "PUT",
    `repos/${input.project.githubRepo}/issues/${record.target.number}/labels`,
    "--input", "-",
  ], { input: JSON.stringify({ labels: next }) });
}

function applyTerminalMonitorDisposition(
  input: ContainmentInput,
  dependencies: {
    commandRunner?: JsonObject;
    runner?: JsonObject;
    github?: JsonObject;
    withEnabledProjectLock?: typeof withEnabledProjectLock;
  } = {},
): boolean {
  const recordFile = attemptRecordFile(input.handoff);
  if (!recordFile) throw new Error("terminal monitor handoff has no attempt record");
  const commandRunner = dependencies.commandRunner || createCommandRunner();
  const runner = dependencies.runner || createHerdrRunnerFromCommandRunner(commandRunner);
  const github = dependencies.github || createGithubOperations(commandRunner);
  const withProjectLock = dependencies.withEnabledProjectLock || withEnabledProjectLock;
  return withProjectLock({
    repoPath: input.project.repoPath,
    githubRepo: input.project.githubRepo,
    stateDir: input.project.stateDir,
    enabledAt: input.project.enabledAt,
  }, (_enabled: JsonObject, recheck: () => void) => {
    let record = readBoundAttempt(recordFile);
    if (record.project !== input.project.id || record.repository !== input.project.githubRepo) {
      throw new Error("terminal monitor attempt identity changed");
    }
    if (releasesAttemptOwnership(record.phase)) return true;
    if (!dispositionStillApplies(commandRunner, runner, record, input.disposition)) return false;
    const observed = input.disposition;
    if (observed.action !== "wait_for_model" && observed.action !== "stop") return false;
    let target = exactTarget(github, input, record);
    const body = commentBody(record, observed);

    if (observed.action === "wait_for_model") {
      if (!authorizedCommentExists(github, input, record, body)) {
        recheck();
        record = readBoundAttempt(recordFile);
        target = exactTarget(github, input, record);
        if (!dispositionStillApplies(commandRunner, runner, record, observed)) return false;
        if (!labels(target).includes(input.project.labels.inProgress)) return false;
        if (record.target.kind === "issue") github.commentIssue(input.project.githubRepo, record.target.number, body);
        else github.commentPr(input.project.githubRepo, record.target.number, body);
      }
      return authorizedCommentExists(github, input, record, body);
    }

    const currentLabels = labels(target);
    const stopped = currentLabels.includes(input.project.labels.blocked)
      && !currentLabels.some((label) => [
        input.project.labels.explore,
        input.project.labels.implement,
        input.project.labels.review,
        input.project.labels.updateBranch,
        input.project.labels.inProgress,
      ].includes(label));
    if (!stopped) {
      if (!currentLabels.includes(input.project.labels.inProgress)) return false;
      recheck();
      record = readBoundAttempt(recordFile);
      target = exactTarget(github, input, record);
      assertBranchUpdateStopGeneration(github, input, record);
      if (!dispositionStillApplies(commandRunner, runner, record, observed)) return false;
      // This confirmation is the last gate before GitHub writes. The label move and the stop
      // comment run back to back under it: aborting between them would strand a half-applied
      // stop — moved labels without the explanation, or the reverse.
      replaceStoppedLabels(commandRunner, input, record, target);
      if (!authorizedCommentExists(github, input, record, body)) {
        if (record.target.kind === "issue") github.commentIssue(input.project.githubRepo, record.target.number, body);
        else github.commentPr(input.project.githubRepo, record.target.number, body);
      }
    } else if (!authorizedCommentExists(github, input, record, body)) {
      recheck();
      record = readBoundAttempt(recordFile);
      exactTarget(github, input, record);
      if (!dispositionStillApplies(commandRunner, runner, record, observed)) return false;
      if (record.target.kind === "issue") github.commentIssue(input.project.githubRepo, record.target.number, body);
      else github.commentPr(input.project.githubRepo, record.target.number, body);
    }
    if (!authorizedCommentExists(github, input, record, body)) return false;

    const runtime = observeAttemptRuntime(runner, record, input.project.repoPath);
    if (runtime.kind === "live_matching_owner") {
      if (!dispositionStillApplies(commandRunner, runner, record, observed)) return false;
      writeCloseReceipt(record);
      runner.closeWorkspace(record.workspaceId);
      if (observeAttemptRuntime(runner, record, input.project.repoPath).kind !== "owner_absent_owned") return false;
    } else if (runtime.kind !== "owner_absent_owned") {
      return false;
    }
    releasePersistedAttemptAuthority(
      record.runDir,
      new Date().toISOString(),
      undefined,
      observed.reason === "active_work_timeout" ? "runtime_timeout" : "terminal_missing_report",
    );
    return true;
  });
}

module.exports = { applyTerminalMonitorDisposition, attemptRecordFile, commentBody, currentDisposition };
