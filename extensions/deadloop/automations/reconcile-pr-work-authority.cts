#!/usr/bin/env node

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { createCommandRunner, createHerdrRunnerFromCommandRunner, driverResult } = require("../../../src/automation-driver-kit.cts");
const { createGithubOperations } = require("../../../src/github-operations.cts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { readAttemptRecordOrUnreadable, isUnreadableAttemptRecord, releasePersistedAttemptAuthority, releasesAttemptOwnership } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { reportUnreadableAttemptRecordOnce } = require("../../../src/unreadable-attempt-journal.cjs");
const { applyPrWorkAuthorityReconciliation } = require("../../../src/pr-work-authority-reconciliation.cts");
const { closeReceiptPath, observeAttemptRuntime } = require("../../../src/attempt-runtime-observation.cts");
const { provenAttemptCompletion } = require("./attempt-completion-proof.cts");
const { containsStorageExhaustion, reportNamesStorageExhaustion } = require("../../../src/storage-exhaustion.cjs");
const { validatePromise } = require("./extract-worker-promise.cts");

type JsonObject = Record<string, any>;

function parseArgs(argv: string[]): JsonObject {
  const result: JsonObject = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    result[token.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = argv[++index] || "";
  }
  return result;
}

function labels(value: JsonObject): string[] {
  return (value.labels || []).map((label: JsonObject | string) => typeof label === "string" ? label : String(label.name || "")).filter(Boolean);
}

function reconciledLabelReplacement(current: string[], next: string[], managedLabels: string[]): string[] {
  const managed = new Set(managedLabels);
  return [...new Set([
    ...current.filter((label) => !managed.has(label)),
    ...next.filter((label) => managed.has(label)),
  ])];
}

function moveReconciledLabels(github: any, repository: string, number: number, current: string[], next: string[], managedLabels: string[]): string[] {
  const desired = reconciledLabelReplacement(current, next, managedLabels);
  const remove = current.filter((label) => !desired.includes(label));
  const add = desired.filter((label) => !current.includes(label));
  github.movePrLabels(repository, number, { remove, add });
  const observed = labels({ labels: github.listPrLabels(repository, number) });
  if (add.some((label) => !observed.includes(label))
    || remove.some((label) => observed.includes(label))) throw new Error("PR label recovery postcondition was not reached");
  return observed;
}

/**
 * Applies a request-invalidating transition as one full-label replacement, so a request queued
 * between revalidation and this mutation cannot outlive the cutoff the mutation establishes.
 * The postcondition proves the observed managed state is exactly the decided one. An unrelated
 * label added inside that same window is not preserved: GitHub offers no conditional write, and
 * invalidating every request atomically is the stronger requirement for this transition.
 */
function replaceReconciledLabels(github: any, repository: string, number: number, current: string[], next: string[], managedLabels: string[]): string[] {
  const managed = new Set(managedLabels);
  const desired = reconciledLabelReplacement(current, next, managedLabels);
  github.replacePrLabels(repository, number, desired);
  const observed = labels({ labels: github.listPrLabels(repository, number) });
  // A full replacement carries the unrelated labels the preceding read saw. Checking only the
  // managed ones would let this mutation drop somebody else's label without anybody noticing.
  const preserved = desired.filter((label) => !managed.has(label));
  if (!sameStringSet(observed.filter((label) => managed.has(label)), desired.filter((label) => managed.has(label)))
    || !preserved.every((label) => observed.includes(label))) {
    throw new Error("PR label recovery postcondition was not reached");
  }
  return observed;
}

function loadAttempts(stateDir: string, projectId: string, repository: string): { valid: JsonObject[]; released: JsonObject[]; malformed: JsonObject[] } {
  const valid: JsonObject[] = [];
  const released: JsonObject[] = [];
  const malformed: JsonObject[] = [];
  let entries: string[] = [];
  try { entries = fs.readdirSync(path.join(stateDir, "runs")); } catch { return { valid, released, malformed }; }
  for (const entry of entries) {
    const runDir = path.join(stateDir, "runs", entry);
    const file = path.join(runDir, "attempt.json");
    if (!fs.existsSync(file)) continue;
    try {
      const read = readAttemptRecordOrUnreadable(runDir);
      // A finished attempt's unreadable journal is evidence, not live state: report it once and
      // skip it instead of making its pull request unobservable.
      if (isUnreadableAttemptRecord(read)) { reportUnreadableAttemptRecordOnce(stateDir, read); continue; }
      const record = read;
      if (record.project === projectId && record.repository === repository) {
        const entry = { ...record, runDir };
        if (releasesAttemptOwnership(record.phase)) released.push(entry);
        else valid.push(entry);
      }
    } catch {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        if (raw?.project === projectId && raw?.repository === repository && raw?.target?.kind === "pull-request") malformed.push(raw);
      } catch {}
    }
  }
  return { valid, released, malformed };
}

function writeJsonAtomically(file: string, value: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function recoveryReceiptPath(stateDir: string, repositoryId: string, number: number): string {
  return path.join(stateDir, "work-authority-reconciliation", `${repositoryId}-${number}.json`);
}

/** The phases an attempt passes before its launch opens a workspace. */
const PHASES_BEFORE_WORKSPACE = ["prepared", "github_claimed"];

/**
 * An attempt whose launch failed before it opened a workspace.
 *
 * The launch is what opens the workspace, so a launch that failed while the journal was still at one
 * of the phases before that left no runtime state at all: nothing to observe, nothing to close, and
 * no way back to the pull request. That is the whole proof this attempt can no longer act. A launch
 * failure that already held a workspace is the opposite case and keeps its ownership, because that
 * workspace still has to be accounted for.
 */
function releasableUnlaunchedAttempt(record: JsonObject): boolean {
  return record.phase === "launch_failed" && PHASES_BEFORE_WORKSPACE.includes(record.lastSuccessfulPhase)
    && !record.workspaceId && !record.tabId && !record.rootPaneId;
}

/**
 * Storage exhaustion deadloop observed for one attempt, per ADR 0018.
 *
 * Two channels count: deadloop's own journal of its deterministic launch writes, and the attempt's
 * completion report — either a blocked report naming ENOSPC/EDQUOT as its result, or a report file
 * deadloop could not even read because the same exhaustion broke that read. An agent's terminal
 * output names neither, so it feeds nothing here; a stop without a completion report stays a
 * generic technical failure unless one of these deterministic channels actually observed the code.
 */
function observedAttemptStorageExhaustion(record: JsonObject): boolean {
  if (containsStorageExhaustion(record.launchError)) return true;
  const promiseFile = String(record.promiseFile || "");
  const runDir = String(record.runDir || "");
  if (!promiseFile || !runDir || !fs.existsSync(promiseFile)) return false;
  const validation = validatePromise(promiseFile, path.join(runDir, "attempt.json"));
  if (validation.status === "invalid") return /storage_exhaustion:/.test(String(validation.error || ""));
  return validation.status === "blocked" && reportNamesStorageExhaustion(validation.promise);
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

/** The request label each role's stopped attempt returns its pull request to. */
function requestLabelForRole(role: string, requestLabels: { reviewLabel: string; implementLabel: string; updateBranchLabel: string }): string | undefined {
  return ({
    worker: requestLabels.implementLabel,
    explorer: requestLabels.implementLabel,
    reviewer: requestLabels.reviewLabel,
    "review-repair": requestLabels.reviewLabel,
    "branch-update": requestLabels.updateBranchLabel,
  } as Record<string, string | undefined>)[role];
}

/**
 * Finishes a stopped attempt that proved it completed against the pull request's current head.
 *
 * An agent stops the moment it writes its completion report, so "the runtime says stopped" and "the
 * work was abandoned" are indistinguishable from the runtime alone. The attempt's own evidence
 * tells them apart, in whichever way its role proves one: a writing role by the finalizer receipt
 * for its push, a review by its own report bound to the attempt journal. Either way the proof names
 * the live head, so the work succeeded and only its handoff is still owed.
 *
 * Driving that handoff here rather than waiting for it removes the last authority only one session
 * held. Completion was reachable solely from the monitor prompt, so an agent that finished while
 * its monitor was gone left a pull request nobody would ever hand over. The handler is idempotent
 * and re-authorizes under the enablement lock against the exact head, so holding the evidence is
 * the only thing driving it requires.
 *
 * Returns null when the attempt proves nothing to finish, `pending_head_visibility` when a pushed
 * head has not reached the pull-request snapshot yet, `completed` when the handoff ran, and
 * `refused` with the handler's own reason when it could not. A refusal leaves the ordinary
 * reconciliation to block the pull request, which is the safe direction, but the reason travels
 * with it: an attempt that pushed and then could not hand over must not read as one that never
 * pushed.
 */
function completeProvenStoppedAttempt(
  record: JsonObject,
  pr: JsonObject,
  args: JsonObject,
  workflowLabels: {
    reviewLabel: string;
    implementLabel: string;
    updateBranchLabel: string;
    inProgressLabel: string;
    blockedLabel: string;
  },
  ops: { complete?: (role: string, handlerArgs: JsonObject) => JsonObject } = {},
): { kind: "completed"; result: JsonObject } | { kind: "pending_head_visibility" } | { kind: "refused"; reason: string } | null {
  const runDir = String(record.runDir || "");
  const completion = provenAttemptCompletion(runDir, record);
  if (!completion) return null;
  if (completion.currentHeadOid !== String(pr.headRefOid || "").toLowerCase()) {
    return completion.expectedHead === String(pr.headRefOid || "").toLowerCase()
      ? { kind: "pending_head_visibility" } : null;
  }
  const role = String(record.role || "");
  const handler = COMPLETION_HANDLERS[role];
  if (!handler) return null;
  const handlerArgs = {
    promise: String(record.promiseFile || ""),
    attemptRecord: path.join(runDir, "attempt.json"),
    projectId: String(args.projectId || ""),
    projectRepo: String(args.projectRepo || ""),
    githubRepo: String(args.githubRepo || ""),
    stateDir: String(args.stateDir || ""),
    enabledAt: Number(args.enabledAt),
    pr: Number(pr.number),
    expectedHead: completion.expectedHead,
    reviewLabel: workflowLabels.reviewLabel,
    implementLabel: workflowLabels.implementLabel,
    updateBranchLabel: workflowLabels.updateBranchLabel,
    inProgressLabel: workflowLabels.inProgressLabel,
    blockedLabel: workflowLabels.blockedLabel,
    ...handler.args(record, runDir),
  };
  const complete = ops.complete
    || ((_role: string, values: JsonObject) => require(handler.module).completion(values));
  try {
    return { kind: "completed", result: complete(role, handlerArgs) };
  } catch (error) {
    // A refusal keeps the pull request on the ordinary blocking path, but the reason has to travel
    // with it. Without one, an attempt that pushed and then could not hand over looks identical to
    // an attempt that never pushed, and neither the operator nor the next change can tell them
    // apart from the recorded stop alone.
    return { kind: "refused", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Every role whose completion is still owed to GitHub, and the handler that owes it. */
const COMPLETION_HANDLERS: Record<string, { module: string; args: (record: JsonObject, runDir: string) => JsonObject }> = {
  "branch-update": {
    module: "./pr-branch-update-complete.cts",
    args: () => ({}),
  },
  reviewer: {
    module: "./pr-review-complete.cts",
    args: () => ({}),
  },
  "review-repair": {
    module: "./pr-review-repair-complete.cts",
    args: (record, runDir) => ({
      result: path.join(runDir, "finalizer-result.json"),
      contract: path.join(runDir, "review-contract.json"),
      branch: String(record.branch || ""),
      attemptKey: String(record.attemptId || ""),
    }),
  },
};

/**
 * The one-axis runtime answer for one attempt journal, collapsed from the runtime observation.
 * Running means the runtime lists the attempt's agent; stopped means it reports the attempt ended;
 * an answer the runtime cannot give — unreachable, or a checkout it cannot describe — is
 * unobservable, and unobservable fails closed.
 */
function observeJournalRuntime(
  runner: any,
  record: JsonObject,
  projectRepo: string,
): "running" | "stopped" | "unobservable" {
  try {
    const observed = observeAttemptRuntime(runner, record, projectRepo);
    return observed.kind === "live_matching_owner" ? "running"
      : observed.kind === "owner_absent_owned" ? "stopped" : "unobservable";
  } catch { return "unobservable"; }
}

async function reconcile(args: JsonObject, commandRunner = createCommandRunner()): Promise<JsonObject> {
  const enabledEnv = {
    repoPath: args.projectRepo,
    githubRepo: args.githubRepo,
    stateDir: args.stateDir,
    enabledAt: Number(args.enabledAt),
  };
  const guarded = <T,>(operation: () => T): T => withEnabledDriverLock(enabledEnv, (_enabled: unknown, recheck: () => void) => {
    recheck();
    return operation();
  });
  const github = createGithubOperations(commandRunner);
  const requestLabels = [args.updateBranchLabel || "agent:update-branch", args.implementLabel || "agent:implement", args.reviewLabel || "agent:review"];
  const inProgressLabel = args.inProgressLabel || "agent:in-progress";
  const blockedLabel = args.blockedLabel || "agent:blocked";
  const automationLogin = String(commandRunner.runText(["gh", "api", "user", "--jq", ".login"])).trim().toLowerCase();
  if (!automationLogin || args.automationLogin && automationLogin !== String(args.automationLogin).trim().toLowerCase()) {
    throw new Error("authenticated GitHub identity does not match the enabled reconciliation identity");
  }
  const repositoryIdentity = github.getRepositoryIdentity(args.githubRepo);
  const attempts = loadAttempts(args.stateDir, args.projectId, args.githubRepo);
  const prs = github.listOpenPrs(args.githubRepo);
  const runner = createHerdrRunnerFromCommandRunner(commandRunner);
  const results: JsonObject[] = [];

  /**
   * A request event newer than every recorded launch failure is demand those failures never
   * answered. Launch-failed attempts never started an agent, so their journals are not evidence
   * that blocks a new request: the next launch is attempted instead (Issue #394).
   */
  const newestFailureTime = (number: number): number | null => {
    const times: number[] = [];
    for (const attempt of attempts.valid.filter((candidate) => candidate.target?.kind === "pull-request"
      && Number(candidate.target.number) === number && candidate.phase === "launch_failed")) {
      try { times.push(fs.statSync(path.join(attempt.runDir, "attempt.json")).mtime.getTime()); } catch {}
    }
    for (const attempt of attempts.released.filter((candidate) => candidate.target?.kind === "pull-request"
      && Number(candidate.target.number) === number && candidate.authorityRelease?.reason === "never_launched")) {
      const releasedAt = Date.parse(String(attempt.authorityRelease?.releasedAt || ""));
      if (Number.isFinite(releasedAt)) times.push(releasedAt);
    }
    return times.length ? Math.max(...times) : null;
  };
  const requestEventNewerThanFailure = async (number: number, failureTime: number | null): Promise<boolean> => {
    if (failureTime === null) return false;
    let events: JsonObject[];
    try { events = await github.listPrTimelineEvents(args.githubRepo, number); } catch { return false; }
    const requestTimes = events
      .filter((event) => String(event.event || "").toLowerCase() === "labeled"
        && requestLabels.includes(String(event.label?.name || "")))
      .map((event) => Date.parse(String(event.created_at || "")))
      .filter((time) => Number.isFinite(time));
    return requestTimes.length > 0 && Math.max(...requestTimes) > failureTime;
  };

  // A pull request deadloop still holds an attempt journal for is one it owes an answer on, whether
  // or not a request label survives. Selecting on the in-progress label alone made a pull request
  // invisible the moment reconciliation blocked it, which is exactly when it needs looking at.
  const attemptedPrNumbers = new Set(attempts.valid
    .filter((attempt) => attempt.target?.kind === "pull-request")
    .map((attempt) => Number(attempt.target.number)));
  for (const pr of prs.filter((candidate: JsonObject) => labels(candidate).includes(inProgressLabel)
    || attemptedPrNumbers.has(Number(candidate.number))
    || fs.existsSync(recoveryReceiptPath(args.stateDir, String(repositoryIdentity.id || ""), Number(candidate.number))))) {
    const number = Number(pr.number);
    const recoveryFile = recoveryReceiptPath(args.stateDir, String(repositoryIdentity.id || ""), number);
    const failureTime = newestFailureTime(number);
    const newerRequestThanFailure = await requestEventNewerThanFailure(number, failureTime);
    const claimed = attempts.valid.filter((attempt) => attempt.target?.kind === "pull-request" && Number(attempt.target.number) === number);
    // Counting an attempt that never launched as an owner makes its pull request ambiguous for
    // good. Releasing it writes that into its journal, so the launch error stays as evidence. A
    // request newer than the failure outranks the failed launch entirely: a launch-failed attempt
    // never started an agent, so its journal is no longer a claim on this pull request. A live
    // runtime observation keeps the claim; anything else releases it.
    const outrankedJournals: Array<{ record: JsonObject; kind: string }> = [];
    const releasedClaims = new Set<JsonObject>();
    if (newerRequestThanFailure) {
      for (const attempt of claimed.filter((candidate) => !releasableUnlaunchedAttempt(candidate)
        && candidate.phase === "launch_failed")) {
        const kind = observeJournalRuntime(runner, attempt, args.projectRepo);
        if (kind !== "stopped") continue;
        releasePersistedAttemptAuthority(attempt.runDir, new Date().toISOString(), undefined, "never_launched");
        results.push({ number, action: "released_unlaunched_attempt", attemptId: attempt.attemptId });
        outrankedJournals.push({ record: attempt, kind });
        releasedClaims.add(attempt);
      }
    }
    const matching = claimed.filter((attempt) => !releasableUnlaunchedAttempt(attempt)
      && !releasedClaims.has(attempt));
    for (const attempt of claimed.filter(releasableUnlaunchedAttempt)) {
      releasePersistedAttemptAuthority(attempt.runDir, new Date().toISOString(), undefined, "never_launched");
      results.push({ number, action: "released_unlaunched_attempt", attemptId: attempt.attemptId });
    }
    const malformed = attempts.malformed.filter((attempt) => Number(attempt.target?.number) === number);
    // Every recorded reason this PR's launches failed before starting an agent: the attempts still
    // waiting to be released this cycle, and the ones earlier cycles already released. This is what
    // lets a stop name the real failure instead of a missing journal.
    const launchFailures = [
      ...claimed.filter(releasableUnlaunchedAttempt),
      ...attempts.released.filter((attempt) => attempt.target?.kind === "pull-request"
        && Number(attempt.target?.number) === number
        && attempt.authorityRelease?.reason === "never_launched"),
    ].map((attempt) => String(attempt.launchError || "")).filter(Boolean);
    // A stop keeps an observed ENOSPC/EDQUOT instead of reporting an unknown cause. Completion proof
    // outranks this evidence: the completed handoff above continues past any blocking below.
    const storageExhaustion = launchFailures.some((failure) => containsStorageExhaustion(failure))
      || matching.some((attempt) => observedAttemptStorageExhaustion(attempt));

    // Liveness is asked per journal and answered by the runtime alone. One live agent keeps the
    // pull request active; one unreadable answer makes the whole observation unobservable. No
    // journal left at all is its own answer: there is nothing to observe, not an unreadable owner.
    const journals = matching.map((record) => ({ record, kind: observeJournalRuntime(runner, record, args.projectRepo) }));
    const runtime = journals.some((journal) => journal.kind === "running") ? { kind: "running" }
      : malformed.length > 0 || journals.some((journal) => journal.kind === "unobservable")
        ? { kind: "unobservable" }
        : journals.length === 0 ? { kind: "absent" } : { kind: "stopped" };

    // A stopped attempt that left proof of a completed attempt is finished, not abandoned. Handing
    // it over here is what keeps a successful attempt from being blocked for ending on success.
    let completion: { kind: "handoff_refused" | "not_run" } = { kind: "not_run" };
    let completionHandled = false;
    for (const journal of journals.filter((candidate) => candidate.kind === "stopped")) {
      const completed = completeProvenStoppedAttempt(journal.record, pr, args, {
        reviewLabel: args.reviewLabel || "agent:review",
        implementLabel: args.implementLabel || "agent:implement",
        updateBranchLabel: args.updateBranchLabel || "agent:update-branch",
        inProgressLabel,
        blockedLabel,
      });
      if (!completed) continue;
      if (completed.kind === "completed") {
        results.push({ number, action: "completed_proven_attempt", attemptId: journal.record.attemptId, result: completed.result });
        completionHandled = true;
      } else if (completed.kind === "pending_head_visibility") {
        results.push({ number, action: "completion_pending_head_visibility", attemptId: journal.record.attemptId });
        completionHandled = true;
      } else {
        results.push({ number, action: "completion_refused", attemptId: journal.record.attemptId, reason: completed.reason });
        completion = { kind: "handoff_refused" };
      }
      break;
    }
    if (completionHandled) continue;

    const restoreRequestLabel = journals
      .map((journal) => requestLabelForRole(String(journal.record.role || ""), {
        reviewLabel: args.reviewLabel || "agent:review",
        implementLabel: args.implementLabel || "agent:implement",
        updateBranchLabel: args.updateBranchLabel || "agent:update-branch",
      }))
      .find((label) => label !== undefined);
    const input = { pr: { ...pr, labels: labels(pr) }, runtime, requestLabels, inProgressLabel, blockedLabel, completion,
      ...(restoreRequestLabel ? { restoreRequestLabel } : {}),
      ...(newerRequestThanFailure ? { newerRequestThanFailure: true } : {}),
      ...(launchFailures.length ? { launchFailures } : {}),
      ...(storageExhaustion ? { storageExhaustion: true } : {}) };
    let blockStarted: { reason: string; timelineEventIds: string[] } | undefined;
    try {
      const receipt = JSON.parse(fs.readFileSync(recoveryFile, "utf8"));
      if (receipt?.schemaVersion === 1 && receipt?.repository === args.githubRepo
        && receipt?.repositoryId === String(repositoryIdentity.id || "") && Number(receipt?.prNumber) === number
        && String(receipt?.headRefOid || "").toLowerCase() === String(pr.headRefOid || "").toLowerCase()
        && typeof receipt?.reason === "string" && Array.isArray(receipt?.timelineEventIds)
        && receipt.timelineEventIds.every((id: unknown) => typeof id === "string" && id)) {
        blockStarted = { reason: receipt.reason, timelineEventIds: receipt.timelineEventIds };
      }
    } catch {}
    const managed = [...requestLabels, inProgressLabel, blockedLabel];
    const revalidate = (expectedManagedLabels: string[]): string[] => {
      const livePr = github.getPr(args.githubRepo, number);
      const liveLabels = labels({ labels: github.listPrLabels(args.githubRepo, number) });
      if (String(livePr.state || "").toUpperCase() !== "OPEN"
        || String(livePr.headRefOid || "").toLowerCase() !== String(pr.headRefOid || "").toLowerCase()
        || !sameStringSet(liveLabels.filter((label) => managed.includes(label)), expectedManagedLabels.filter((label) => managed.includes(label)))) {
        throw new Error("PR reconciliation state changed before recovery mutation");
      }
      return liveLabels;
    };
    const result = await applyPrWorkAuthorityReconciliation(input, {
      automationLogin,
      blockStarted,
      recordBlockStarted: (started: JsonObject) => writeJsonAtomically(recoveryFile, {
        schemaVersion: 1, repository: args.githubRepo, repositoryId: String(repositoryIdentity.id || ""),
        prNumber: number, headRefOid: String(pr.headRefOid || ""), attemptId: journals[0]?.record.attemptId,
        ...started,
      }),
      completeBlock: journals.length + outrankedJournals.length === 0 ? () => fs.rmSync(recoveryFile, { force: true }) : undefined,
      listTimelineEvents: () => github.listPrTimelineEvents(args.githubRepo, number),
      listComments: () => github.listPrComments(args.githubRepo, number),
      replaceLabels: (next: string[], options: { invalidatesRequests: boolean }) => guarded(() => {
        const current = revalidate(input.pr.labels);
        const apply = options.invalidatesRequests ? replaceReconciledLabels : moveReconciledLabels;
        input.pr.labels = apply(github, args.githubRepo, number, current, next, managed);
      }),
      comment: (body: string) => guarded(() => {
        revalidate(input.pr.labels);
        return github.createPrComment(args.githubRepo, number, body);
      }),
      closeStoppedWorkspace: journals.length || outrankedJournals.length
        ? () => guarded(() => closeStoppedAttemptWorkspaces(runner, [...journals, ...outrankedJournals], args.projectRepo))
        : undefined,
    });
    // A stopped attempt whose workspace is closed again has nothing left to hold. Writing that into
    // its journal keeps the restored request launchable: an unsettled journal still counts as a
    // claim, and a claim beside a fresh request would stop the next launch dead.
    if ((result.action === "restore_request" || result.action === "block") && result.cleanup === "workspace_closed") {
      for (const journal of journals) {
        try { releasePersistedAttemptAuthority(journal.record.runDir, new Date().toISOString(), undefined, "owner_absent"); } catch {}
      }
      fs.rmSync(recoveryFile, { force: true });
    }
    results.push({ prNumber: number, ...result });
  }
  // A refused handoff has to reach the summary, not only the structured results. Callers keep the
  // summary and drop the rest, so a reason left there alone would never be read by anybody.
  const refused = results.filter((entry) => entry.action === "completion_refused")
    .map((entry) => `#${entry.number} ${entry.reason}`);
  const summary = `reconciled ${results.length} active PR work state(s)`
    + (refused.length ? `; ${refused.length} proven completion(s) refused: ${refused.join("; ")}` : "");
  return driverResult("done", summary, { driverAction: "pr_work_authority_reconciled", results });
}

/**
 * Closes every stopped attempt workspace this pull request still holds, one journal at a time.
 * Closing is idempotent: a workspace already closed left the receipt that says so, and the runtime
 * re-observed absence is what makes the close count. Any journal this cannot confirm keeps its
 * workspace, and the caller reports the workspace as preserved instead of closed.
 */
function closeStoppedAttemptWorkspaces(
  runner: any,
  journals: Array<{ record: JsonObject; kind: string }>,
  projectRepo: string,
): boolean {
  let allClosed = true;
  for (const { record } of journals.filter((journal) => journal.kind === "stopped")) {
    try {
      if (observeAttemptRuntime(runner, record, projectRepo).kind !== "owner_absent_owned") { allClosed = false; continue; }
      writeJsonAtomically(closeReceiptPath(record), {
        schemaVersion: 1, attemptId: record.attemptId, workspaceId: record.workspaceId,
        worktreePath: record.worktreePath, startedAt: new Date().toISOString(),
      });
      const alreadyAbsent = !runner.listWorkspaces().some((workspace: JsonObject) => String(workspace.workspaceId || "") === String(record.workspaceId));
      if (!alreadyAbsent) runner.closeWorkspace(record.workspaceId);
      if (observeAttemptRuntime(runner, record, projectRepo).kind !== "owner_absent_owned") allClosed = false;
    } catch { allClosed = false; }
  }
  return allClosed;
}

async function main(): Promise<void> {
  try { process.stdout.write(`${JSON.stringify(await reconcile(parseArgs(process.argv.slice(2))))}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "pr_work_authority_reconciliation_failed" }))}\n`); }
}

if (require.main === module) void main();
module.exports = {
  completeProvenStoppedAttempt,
  loadAttempts,
  moveReconciledLabels,
  observeJournalRuntime,
  reconcile,
  reconciledLabelReplacement,
  replaceReconciledLabels,
};
