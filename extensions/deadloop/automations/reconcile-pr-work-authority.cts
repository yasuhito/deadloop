#!/usr/bin/env node

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { createCommandRunner, createHerdrRunnerFromCommandRunner, driverResult } = require("../../../src/automation-driver-kit.cts");
const { createGithubOperations } = require("../../../src/github-operations.cts");
const { compareGithubTimelineEvents } = require("../../../src/github-timeline-order.cts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { readAttemptRecord, releasePersistedAttemptAuthority, releasesAttemptOwnership } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { applyPrWorkAuthorityReconciliation } = require("../../../src/pr-work-authority-reconciliation.cts");
const { closeReceiptPath, observeAttemptRuntime } = require("../../../src/attempt-runtime-observation.cts");
const { provenPushedHeadTransition } = require("./pushed-head-proof.cts");
const { provenAttemptCompletion } = require("./attempt-completion-proof.cts");

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
      const record = readAttemptRecord(runDir);
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

function latestConfiguredRequest(events: JsonObject[], currentLabels: string[], requestLabels: string[]): JsonObject | null {
  const queued = new Set(currentLabels.filter((label) => requestLabels.includes(label)));
  return events.filter((event) => String(event.event || "").toLowerCase() === "labeled"
    && queued.has(String(event.label?.name || ""))
    && String(event.id || event.node_id || ""))
    .sort(compareGithubTimelineEvents).at(-1) || null;
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

/**
 * The head change an attempt proved it produced and still holds, or null when it proved none.
 *
 * The proof itself is the finalizer receipt and the bound completion report agreeing on one push.
 * Currency is this caller's part: a proven push the pull request has since moved past says nothing
 * about who owns the head reconciliation is looking at now.
 */
function pushedHeadTransition(record: JsonObject, pr: JsonObject): { originalHeadOid: string; headOid: string } | null {
  const transition = provenPushedHeadTransition(String(record.runDir || ""), record);
  if (!transition) return null;
  return transition.headOid === String(pr.headRefOid || "").toLowerCase() ? transition : null;
}

function classifyRequest(
  events: JsonObject[],
  currentLabels: string[],
  record: JsonObject,
  requestLabels: string[],
): { request: { kind: string }; requestEventId: string } {
  const latest = latestConfiguredRequest(events, currentLabels, requestLabels);
  const requestEventId = String(latest?.id || latest?.node_id || "");
  const consumedEventId = String(record.requestEventId || "");
  if (!consumedEventId) return { request: { kind: "ambiguous" }, requestEventId };
  if (requestEventId && requestEventId !== consumedEventId) return { request: { kind: "superseded" }, requestEventId };
  return { request: { kind: "current" }, requestEventId };
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function reconciliationAuthorityMatches(expected: JsonObject, observed: JsonObject): boolean {
  return String(observed.state || "").toUpperCase() === "OPEN"
    && String(observed.headRefOid || "").toLowerCase() === String(expected.headRefOid || "").toLowerCase()
    && observed.requestKind === expected.requestKind
    && observed.requestEventId === expected.requestEventId
    && sameStringSet(observed.managedLabels || [], expected.managedLabels || []);
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
    const claimed = attempts.valid.filter((attempt) => attempt.target?.kind === "pull-request" && Number(attempt.target.number) === number);
    // Counting an attempt that never launched as an owner makes its pull request ambiguous for
    // good. Releasing it writes that into its journal, so the launch error stays as evidence.
    const matching = claimed.filter((attempt) => !releasableUnlaunchedAttempt(attempt));
    for (const attempt of claimed.filter(releasableUnlaunchedAttempt)) {
      releasePersistedAttemptAuthority(attempt.runDir, new Date().toISOString(), undefined, "never_launched");
      results.push({ number, action: "released_unlaunched_attempt", attemptId: attempt.attemptId });
    }
    if (matching.length === 0 && fs.existsSync(recoveryFile)) {
      try {
        const receipt = JSON.parse(fs.readFileSync(recoveryFile, "utf8"));
        const released = attempts.released.find((attempt) => attempt.attemptId === receipt.attemptId && attempt.phase === "authority_released");
        if (receipt.action === "authority_release_started" && released) {
          fs.rmSync(recoveryFile, { force: true });
          continue;
        }
      } catch {}
    }
    const malformed = attempts.malformed.filter((attempt) => Number(attempt.target?.number) === number);
    const events = github.listPrTimelineEvents(args.githubRepo, number);
    let request: { kind: string };
    let runtime: { kind: string };
    let record: JsonObject | undefined;

    if (malformed.length || matching.length > 1) {
      request = { kind: "ambiguous" };
      runtime = { kind: "ambiguous" };
    } else if (matching.length === 0) {
      request = { kind: "missing" };
      runtime = { kind: "ambiguous" };
    } else {
      record = matching[0];
      request = classifyRequest(events, labels(pr), record, requestLabels).request;
      try { runtime = observeAttemptRuntime(runner, record, args.projectRepo); }
      catch { runtime = { kind: "unreachable" }; }
    }

    // A stopped owner that left proof of a completed attempt is finished, not abandoned. Handing
    // it over here is what keeps a successful attempt from being blocked for stopping on success.
    if (record && runtime.kind === "stopped_owned") {
      const completed = completeProvenStoppedAttempt(record, pr, args, {
        reviewLabel: args.reviewLabel || "agent:review",
        implementLabel: args.implementLabel || "agent:implement",
        updateBranchLabel: args.updateBranchLabel || "agent:update-branch",
        inProgressLabel,
        blockedLabel,
      });
      if (completed?.kind === "completed") {
        results.push({ number, action: "completed_proven_attempt", attemptId: record.attemptId, result: completed.result });
        continue;
      }
      if (completed?.kind === "pending_head_visibility") {
        results.push({ number, action: "completion_pending_head_visibility", attemptId: record.attemptId });
        continue;
      }
      if (completed?.kind === "refused") {
        results.push({ number, action: "completion_refused", attemptId: record.attemptId, reason: completed.reason });
      }
    }

    const input = { pr: { ...pr, labels: labels(pr) }, request, runtime, requestLabels, inProgressLabel, blockedLabel };
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
    const initialRequest = latestConfiguredRequest(events, labels(input.pr), requestLabels);
    let expectedRequestEventId = record
      ? classifyRequest(events, labels(input.pr), record, requestLabels).requestEventId
      : String(initialRequest?.id || initialRequest?.node_id || "");
    const managed = [...requestLabels, inProgressLabel, blockedLabel];
    const revalidate = (expectedManagedLabels: string[], expectedRequestKind: string): string[] => {
      const livePr = github.getPr(args.githubRepo, number);
      const liveLabels = labels({ labels: github.listPrLabels(args.githubRepo, number) });
      const liveEvents = github.listPrTimelineEvents(args.githubRepo, number);
      const liveRequest = latestConfiguredRequest(liveEvents, liveLabels, requestLabels);
      const observed = record ? classifyRequest(liveEvents, liveLabels, record, requestLabels) : {
        request: { kind: expectedRequestKind },
        requestEventId: String(liveRequest?.id || liveRequest?.node_id || ""),
      };
      if (!reconciliationAuthorityMatches({
        state: "OPEN", headRefOid: pr.headRefOid, requestKind: expectedRequestKind,
        requestEventId: expectedRequestEventId,
        managedLabels: expectedManagedLabels.filter((label) => managed.includes(label)),
      }, {
        state: livePr.state, headRefOid: livePr.headRefOid, requestKind: observed.request.kind,
        requestEventId: observed.requestEventId,
        managedLabels: liveLabels.filter((label) => managed.includes(label)),
      })) throw new Error("PR reconciliation state changed before recovery mutation");
      return liveLabels;
    };
    const result = await applyPrWorkAuthorityReconciliation(input, {
      automationLogin,
      blockStarted,
      recordBlockStarted: (started: JsonObject) => writeJsonAtomically(recoveryFile, {
        schemaVersion: 1, repository: args.githubRepo, repositoryId: String(repositoryIdentity.id || ""),
        prNumber: number, headRefOid: String(pr.headRefOid || ""), attemptId: record?.attemptId,
        ...started,
      }),
      completeBlock: record ? undefined : () => fs.rmSync(recoveryFile, { force: true }),
      listTimelineEvents: () => github.listPrTimelineEvents(args.githubRepo, number),
      listComments: () => github.listPrComments(args.githubRepo, number),
      replaceLabels: (next: string[], options: { invalidatesRequests: boolean }) => guarded(() => {
        const current = revalidate(input.pr.labels, request.kind);
        const apply = options.invalidatesRequests ? replaceReconciledLabels : moveReconciledLabels;
        input.pr.labels = apply(github, args.githubRepo, number, current, next, managed);
        if (!next.some((label) => requestLabels.includes(label))) expectedRequestEventId = "";
      }),
      comment: (body: string) => guarded(() => {
        revalidate(input.pr.labels, request.kind);
        return github.createPrComment(args.githubRepo, number, body);
      }),
      recordReleaseStarted: record ? () => writeJsonAtomically(recoveryFile, {
        schemaVersion: 1, action: "authority_release_started", repository: args.githubRepo,
        repositoryId: String(repositoryIdentity.id || ""), prNumber: number,
        headRefOid: String(pr.headRefOid || ""), attemptId: record!.attemptId,
        requestEventId: expectedRequestEventId,
      }) : undefined,
      closeOwnedWorkspace: record && runtime.kind === "stopped_owned" ? () => guarded(() => {
        if (observeAttemptRuntime(runner, record!, args.projectRepo).kind !== "stopped_owned") return false;
        writeJsonAtomically(closeReceiptPath(record!), {
          schemaVersion: 1, attemptId: record!.attemptId, workspaceId: record!.workspaceId,
          worktreePath: record!.worktreePath, startedAt: new Date().toISOString(),
        });
        const alreadyAbsent = !runner.listWorkspaces().some((workspace: JsonObject) => String(workspace.workspaceId || "") === String(record!.workspaceId));
        if (!alreadyAbsent) runner.closeWorkspace(record!.workspaceId);
        return observeAttemptRuntime(runner, record!, args.projectRepo).kind === "stopped_owned";
      }) : undefined,
      releaseLocalOwnership: record ? (cutoffEventId?: string) => {
        releasePersistedAttemptAuthority(record!.runDir, new Date().toISOString(), cutoffEventId);
        fs.rmSync(recoveryFile, { force: true });
      } : undefined,
    });
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

async function main(): Promise<void> {
  try { process.stdout.write(`${JSON.stringify(await reconcile(parseArgs(process.argv.slice(2))))}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "pr_work_authority_reconciliation_failed" }))}\n`); }
}

if (require.main === module) void main();
module.exports = {
  classifyRequest,
  completeProvenStoppedAttempt,
  latestConfiguredRequest,
  loadAttempts,
  moveReconciledLabels,
  pushedHeadTransition,
  reconcile,
  reconciledLabelReplacement,
  reconciliationAuthorityMatches,
  replaceReconciledLabels,
};
