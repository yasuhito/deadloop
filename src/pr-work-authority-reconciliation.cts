const { compareGithubTimelineEvents } = require("./github-timeline-order.cts");
const { redactLocalDetail } = require("./local-detail-redaction.cts");
const { containsStorageExhaustion } = require("./storage-exhaustion.cjs");

type JsonObject = Record<string, any>;

/**
 * Liveness has one authority: the execution runtime. Deadloop never proves ownership, so there is
 * no second observation to reconcile against and no ambiguous middle: an answer the runtime cannot
 * give is unobservable, and unobservable fails closed.
 */
type RuntimeObservation =
  | { kind: "running" }
  | { kind: "stopped" }
  | { kind: "unobservable" };

/** Whether the completion handler ran, answered by the finalizer receipt and the attempt journal. */
type CompletionObservation = { kind: "handoff_refused" | "not_run" };

type ReconciliationInput = {
  pr: { number: number; headRefOid: string; labels: Array<string | { name?: string }> };
  runtime: RuntimeObservation;
  requestLabels: string[];
  inProgressLabel: string;
  blockedLabel: string;
  /** The request label a stopped attempt returns the pull request to. */
  restoreRequestLabel?: string;
  completion?: CompletionObservation;
  /** Launch errors recorded by this PR's attempts that failed before starting any agent. */
  launchFailures?: string[];
  /** ENOSPC/EDQUOT deadloop's own deterministic processing or a bound completion report observed. */
  storageExhaustion?: boolean;
};

type ReconciliationDecision =
  | { action: "keep_active"; cleanup: "none" }
  | { action: "restore_request"; labels: string[]; cleanup: "close_stopped_workspace" }
  | { action: "block"; reason: "runtime_unobservable" | "completion_handoff_refused" | "launch_unprepared" | "storage_exhaustion"; labels: string[]; cleanup: "close_stopped_workspace" | "preserve_workspace" };

function labelNames(labels: Array<string | { name?: string }>): string[] {
  return labels.map((label) => typeof label === "string" ? label : String(label.name || "")).filter(Boolean);
}

function unique(values: string[]): string[] { return [...new Set(values)]; }

function managedWorkflowLabels(input: ReconciliationInput): Set<string> {
  return new Set([...input.requestLabels, input.inProgressLabel, input.blockedLabel]);
}

/**
 * A stopped attempt hands the pull request back to its request state. Requests queued while the
 * attempt ran are concurrent demand and stay; the request state the attempt consumed is restored
 * beside them.
 */
function restoreRequestLabels(input: ReconciliationInput): string[] {
  const managed = managedWorkflowLabels(input);
  return unique([
    ...labelNames(input.pr.labels).filter((label) => !managed.has(label)),
    ...labelNames(input.pr.labels).filter((label) => input.requestLabels.includes(label)),
    ...(input.restoreRequestLabel ? [input.restoreRequestLabel] : []),
  ]);
}

function blockedLabels(input: ReconciliationInput): string[] {
  const managed = managedWorkflowLabels(input);
  return unique([...labelNames(input.pr.labels).filter((label) => !managed.has(label)), input.blockedLabel]);
}

/**
 * The one axis reconciliation still answers: a pull request carrying the active attempt state whose
 * attempt the runtime reports stopped, and whose completion handler did not run, returns to a
 * request state or blocks with an explanation. There is no claim to classify.
 */
function reconcilePrWorkAuthority(input: ReconciliationInput): ReconciliationDecision {
  if (input.runtime.kind === "running") return { action: "keep_active", cleanup: "none" };
  // A refused handoff is a completed attempt whose result the role's finalizer would not apply, so
  // it names its own reason instead of reading as an abandoned attempt.
  if (input.runtime.kind === "stopped" && input.completion?.kind === "handoff_refused") {
    return { action: "block", reason: "completion_handoff_refused", labels: blockedLabels(input), cleanup: "close_stopped_workspace" };
  }
  // A stop whose launches keep failing before any agent starts is explained by the failures: adding
  // another request repeats them, so the block carries the operator guidance instead.
  if (input.launchFailures?.length) {
    return { action: "block", reason: "launch_unprepared", labels: blockedLabels(input), cleanup: "close_stopped_workspace" };
  }
  if (input.storageExhaustion) {
    return { action: "block", reason: "storage_exhaustion", labels: blockedLabels(input), cleanup: "close_stopped_workspace" };
  }
  if (input.runtime.kind === "unobservable") {
    return { action: "block", reason: "runtime_unobservable", labels: blockedLabels(input), cleanup: "preserve_workspace" };
  }
  return { action: "restore_request", labels: restoreRequestLabels(input), cleanup: "close_stopped_workspace" };
}

function eventId(event: JsonObject): string {
  return String(event.id || event.node_id || "");
}

function eventTime(event: JsonObject): number {
  return Date.parse(String(event.created_at || event.createdAt || ""));
}

/**
 * One label move can add a request label and the blocked label together, and GitHub stamps both
 * with the same second. A request no later than the block was part of that block rather than an
 * answer to it, so only a strictly later request survives the cutoff.
 */
function requestAfterInvalidationCutoff(request: JsonObject, cutoff: JsonObject): boolean {
  return Boolean(eventId(request) && eventId(cutoff)) && eventTime(request) > eventTime(cutoff);
}

function eventActor(event: JsonObject): string {
  return String(event.actor?.login || event.user?.login || "").toLowerCase();
}

function eventLabel(event: JsonObject): string {
  return String(event.label?.name || "");
}

function eventAction(event: JsonObject): string {
  return String(event.event || "").toLowerCase();
}

/**
 * The newest block the pull request reached. Eligibility counts a block whoever applied it: a
 * cutoff only ever denies work, so a person stopping a pull request by hand has to outrank the
 * requests before it just as an Automation host does. Binding expiry invalidation instead needs a
 * block deadloop itself made, so that caller names the Automation host.
 */
function latestBlockedEvent(
  events: JsonObject[],
  blockedLabel: string,
  automationLogin?: string,
): JsonObject | null {
  const owner = automationLogin?.toLowerCase();
  return events.filter((event) => eventAction(event) === "labeled"
    && eventLabel(event) === blockedLabel
    && (owner === undefined || eventActor(event) === owner)
    && eventId(event))
    .sort(compareGithubTimelineEvents)
    .at(-1) || null;
}

function recoveryMarker(number: number, head: string, reason: string, cutoffEventId: string): string {
  const value = Buffer.from(JSON.stringify({ number, head: head.toLowerCase(), reason, cutoffEventId })).toString("base64url");
  return `<!-- deadloop:work-authority-block v1=${value} -->`;
}

/**
 * Operator guidance for a pull request whose Agent requests keep failing before any agent starts.
 * Each entry maps a recurring failure shape to what an operator can actually do about it.
 */
function launchFailureGuidance(failures: string[]): string {
  const shapes = [
    {
      matches: (text: string) => containsStorageExhaustion(text),
      action: "the host ran out of storage: free up capacity on the machine running deadloop, then add a new Agent request",
    },
    {
      matches: (text: string) => text.includes("does not resolve to the recorded canonical checkout") || text.includes("canonical checkout preparation"),
      action: "the canonical checkout is missing or diverged: recreate it by hand, or fix why it went away; the next request prepares it again once the cause is resolved",
    },
    {
      matches: (text: string) => text.includes("open attempt workspace"),
      action: "a retained attempt workspace is still open: resolve the named attempt (close its workspace or run the abandonment driver)",
    },
    {
      matches: (text: string) => text.includes("cannot fast-forward") || text.includes("uncommitted work") || text.includes("alignment"),
      action: "the retained checkout holds work that cannot be fast-forwarded: inspect it and commit or discard the work by hand",
    },
  ];
  const text = failures.join(" ");
  const matched = shapes.filter((shape) => shape.matches(text)).map((shape) => shape.action);
  return matched.length ? matched.join("\n") : "- inspect the retained attempt journals under the deadloop state directory";
}

function recoveryComment(number: number, head: string, reason: string, cutoffEventId: string, launchFailures?: string[]): string {
  const readable: Record<string, string> = {
    runtime_unobservable: "the execution runtime could not describe this pull request's attempt",
    completion_handoff_refused: "the completion report could not be handed over for this pull request state",
    storage_exhaustion: "the host ran out of storage while the attempt was running (a write failed with ENOSPC or EDQUOT)",
  };
  let explanation = `${readable[reason] || reason}`;
  if (reason === "launch_unprepared") {
    // The recorded errors quote runtime output that can carry absolute host paths, so the published
    // bullets scrub those fragments first. The count still reflects every recorded request cycle.
    const recorded = launchFailures || [];
    const failures = [...new Set(recorded.map((failure) => redactLocalDetail(failure)))];
    explanation = `${recorded.length} Agent request(s) failed to launch before any agent started:\n`
      + failures.map((failure) => `- ${failure}`).join("\n")
      + `\n\nAdding another Agent request now repeats the same failure.`
      + `\nOperator actions:\n${launchFailureGuidance(failures)}`;
  }
  if (reason === "storage_exhaustion") {
    explanation = `${explanation}\n\nThe stopped attempt will not retry automatically and consumed no retry allowance.`
      + `\nOperator actions:`
      + `\n- free up storage on the machine running deadloop`
      + `\n- add a new Agent request once storage is available`;
  }
  return `deadloop blocked this PR because ${explanation}. No old completion report may update the PR; inspect the retained attempt evidence, then add a new Agent request after resolving the blocker.\n\n${recoveryMarker(number, head, reason, cutoffEventId)}`;
}

function sameLabels(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

type ReconciliationOperations = {
  automationLogin: string;
  blockStarted?: { reason: string; timelineEventIds: string[] };
  recordBlockStarted?(input: { reason: string; timelineEventIds: string[] }): void | Promise<void>;
  completeBlock?(cutoffEventId: string): void | Promise<void>;
  listTimelineEvents(): JsonObject[] | Promise<JsonObject[]>;
  listComments(): JsonObject[] | Promise<JsonObject[]>;
  replaceLabels(labels: string[], options: { invalidatesRequests: boolean }): void | Promise<void>;
  comment(body: string): void | Promise<void>;
  closeStoppedWorkspace?(): boolean | Promise<boolean>;
};

/** Executes only recovery effects. It exposes no push, ready, merge, or request-claim operation. */
async function applyPrWorkAuthorityReconciliation(
  input: ReconciliationInput,
  operations: ReconciliationOperations,
): Promise<{ action: string; cutoffEventId?: string; cleanup: string }> {
  const decision = reconcilePrWorkAuthority(input);
  if (decision.action === "keep_active") return { action: decision.action, cleanup: "none" };

  const currentLabels = labelNames(input.pr.labels);
  const labelsChange = !sameLabels(currentLabels, decision.labels);
  if (decision.action === "restore_request") {
    if (labelsChange) await operations.replaceLabels(decision.labels, { invalidatesRequests: false });
    const closed = await operations.closeStoppedWorkspace?.();
    return { action: decision.action, cleanup: closed === true ? "workspace_closed" : "preserve_workspace" };
  }
  const recordedTimelineEventIds = operations.blockStarted?.reason === decision.reason
    ? operations.blockStarted.timelineEventIds
    : undefined;
  const timelineBaseline = labelsChange && !recordedTimelineEventIds
    ? await operations.listTimelineEvents()
    : [];
  const timelineBaselineIds = recordedTimelineEventIds || timelineBaseline.map(eventId);
  if (labelsChange && !recordedTimelineEventIds) {
    await operations.recordBlockStarted?.({ reason: decision.reason, timelineEventIds: timelineBaselineIds });
  }
  // A block invalidates every request: the stopped work is not wanted until a person asks again,
  // so the label replacement is full rather than preserving concurrent requests.
  if (labelsChange) await operations.replaceLabels(decision.labels, { invalidatesRequests: true });

  const events = await operations.listTimelineEvents();
  const baselineIds = new Set(timelineBaselineIds);
  const newBlockedEvents = events.filter((event) => !baselineIds.has(eventId(event))
    && eventAction(event) === "labeled"
    && eventLabel(event) === input.blockedLabel
    && eventActor(event) === operations.automationLogin.toLowerCase());
  const cutoff = labelsChange || recordedTimelineEventIds
    ? newBlockedEvents.length === 1 ? newBlockedEvents[0] : null
    : latestBlockedEvent(events, input.blockedLabel, operations.automationLogin);
  if (!cutoff) return { action: "blocked_cutoff_unproven", cleanup: "preserve_workspace" };
  const cutoffEventId = eventId(cutoff);
  const body = recoveryComment(input.pr.number, input.pr.headRefOid, decision.reason, cutoffEventId, input.launchFailures);
  const comments = await operations.listComments();
  const alreadyExplained = comments.some((comment) => {
    const marker = parseRecoveryMarker(comment.body);
    return String(comment.author?.login || comment.user?.login || "").toLowerCase() === operations.automationLogin.toLowerCase()
      && Number(marker?.number) === input.pr.number
      && String(marker?.head || "").toLowerCase() === input.pr.headRefOid.toLowerCase()
      && String(marker?.cutoffEventId || "") === cutoffEventId;
  });
  if (!alreadyExplained) await operations.comment(body);
  await operations.completeBlock?.(cutoffEventId);

  const closed = decision.cleanup === "close_stopped_workspace"
    ? await operations.closeStoppedWorkspace?.() : undefined;
  return {
    action: decision.action,
    cutoffEventId,
    cleanup: decision.cleanup === "close_stopped_workspace" ? (closed === true ? "workspace_closed" : "preserve_workspace") : decision.cleanup,
  };
}

function parseRecoveryMarker(body: unknown): JsonObject | null {
  const matches = [...String(body || "").matchAll(/<!--\s*deadloop:work-authority-block\s+v1=([A-Za-z0-9_-]+)\s*-->/g)];
  if (matches.length !== 1) return null;
  try {
    const value = JSON.parse(Buffer.from(matches[0][1], "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function postBlockRequestIsEligible(input: {
  request: JsonObject;
  events: JsonObject[];
  blockedLabel: string;
}): boolean {
  // Deadloop's own blocks leave no request behind, so this ordering only ever decides requests a
  // person left in place — and a person stopping a pull request by hand writes a block deadloop
  // never explained. Counting a block whoever applied it is what lets that stop outrank the
  // requests that preceded it, and what keeps such a block recoverable at all. The timeline is
  // fully paginated, so a blocked pull request with no blocked event is evidence this host cannot
  // trust.
  const cutoff = latestBlockedEvent(input.events, input.blockedLabel);
  return cutoff !== null && requestAfterInvalidationCutoff(input.request, cutoff);
}

module.exports = {
  applyPrWorkAuthorityReconciliation,
  parseRecoveryMarker,
  postBlockRequestIsEligible,
  reconcilePrWorkAuthority,
  recoveryComment,
  requestAfterInvalidationCutoff,
};
