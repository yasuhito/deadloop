type JsonObject = Record<string, any>;

type RequestObservation = { kind: "current" | "superseded" | "missing" | "ambiguous" };
type RuntimeObservation =
  | { kind: "live_matching_owner" }
  | { kind: "stopped_owned" }
  | { kind: "unreachable" }
  | { kind: "ambiguous" };

type ReconciliationInput = {
  pr: { number: number; headRefOid: string; labels: Array<string | { name?: string }> };
  request: RequestObservation;
  runtime: RuntimeObservation;
  requestLabels: string[];
  inProgressLabel: string;
  blockedLabel: string;
};

type ReconciliationDecision =
  | { action: "keep_active"; cleanup: "none" }
  | { action: "release_for_request"; reason: "request_superseded_stopped_attempt"; labels: string[]; cleanup: "close_owned_workspace" }
  | { action: "block"; reason: "attempt_missing" | "attempt_ambiguous" | "runtime_unreachable" | "runtime_ambiguous" | "runtime_owner_stopped"; labels: string[]; cleanup: "none" | "close_owned_workspace" | "preserve_workspace"; invalidatesRequests: boolean };

function labelNames(labels: Array<string | { name?: string }>): string[] {
  return labels.map((label) => typeof label === "string" ? label : String(label.name || "")).filter(Boolean);
}

function unique(values: string[]): string[] { return [...new Set(values)]; }

function blockLabels(input: ReconciliationInput, preserveRequests = false): string[] {
  const managed = new Set([...input.requestLabels, input.inProgressLabel, input.blockedLabel]);
  const requests = preserveRequests ? labelNames(input.pr.labels).filter((label) => input.requestLabels.includes(label)) : [];
  return unique([...labelNames(input.pr.labels).filter((label) => !managed.has(label)), ...requests, input.blockedLabel]);
}

function releaseLabels(input: ReconciliationInput): string[] {
  return labelNames(input.pr.labels).filter((label) => label !== input.inProgressLabel);
}

/** Runtime alone answers liveness; request event ids only detect a later generation to expose. */
function reconcilePrWorkAuthority(input: ReconciliationInput): ReconciliationDecision {
  if (input.runtime.kind === "live_matching_owner") return { action: "keep_active", cleanup: "none" };
  if (input.request.kind === "superseded" && input.runtime.kind === "stopped_owned") {
    return { action: "release_for_request", reason: "request_superseded_stopped_attempt", labels: releaseLabels(input), cleanup: "close_owned_workspace" };
  }
  const preserveRequests = input.request.kind === "superseded";
  const cleanup = input.runtime.kind === "stopped_owned" ? "close_owned_workspace"
    : input.runtime.kind === "unreachable" || input.runtime.kind === "ambiguous" ? "preserve_workspace" : "none";
  const reason = input.request.kind === "missing" ? "attempt_missing"
    : input.request.kind === "ambiguous" ? "attempt_ambiguous"
      : input.runtime.kind === "unreachable" ? "runtime_unreachable"
        : input.runtime.kind === "ambiguous" ? "runtime_ambiguous" : "runtime_owner_stopped";
  return { action: "block", reason, labels: blockLabels(input, preserveRequests), cleanup, invalidatesRequests: !preserveRequests };
}

function eventTime(event: JsonObject): number {
  return Date.parse(String(event.created_at || event.createdAt || ""));
}

function eventId(event: JsonObject): string {
  return String(event.id || event.node_id || "");
}

/** GitHub event order: server timestamp first and immutable event ID as the tie-breaker. */
function compareGithubEvents(left: JsonObject, right: JsonObject): number {
  const time = eventTime(left) - eventTime(right);
  return time || eventId(left).localeCompare(eventId(right), undefined, { numeric: true });
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
    .sort(compareGithubEvents)
    .at(-1) || null;
}

function recoveryMarker(number: number, head: string, reason: string, cutoffEventId: string): string {
  const value = Buffer.from(JSON.stringify({ number, head: head.toLowerCase(), reason, cutoffEventId })).toString("base64url");
  return `<!-- deadloop:work-authority-block v1=${value} -->`;
}

function recoveryComment(number: number, head: string, reason: string, cutoffEventId: string): string {
  const readable: Record<string, string> = {
    attempt_missing: "the active attempt journal was missing",
    attempt_ambiguous: "the active attempt could not be identified uniquely",
    runtime_unreachable: "the execution runtime could not be reached",
    runtime_ambiguous: "workspace ownership could not be proven",
    runtime_owner_stopped: "the recorded owner had stopped",
  };
  return `deadloop blocked this PR because ${readable[reason] || reason}. No old completion report may update the PR; inspect the retained attempt evidence, then add a new Agent request after resolving the blocker.\n\n${recoveryMarker(number, head, reason, cutoffEventId)}`;
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
  recordReleaseStarted?(): void | Promise<void>;
  closeOwnedWorkspace?(): boolean | Promise<boolean>;
  releaseLocalOwnership?(cutoffEventId?: string): void | Promise<void>;
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
  if (decision.action === "release_for_request") {
    await operations.recordReleaseStarted?.();
    const closed = await operations.closeOwnedWorkspace?.();
    if (closed !== true) return { action: decision.action, cleanup: "preserve_workspace" };
    // Keep the local owner recoverable until GitHub visibly exposes the queued request.
    // A retry can finish either side of this journaled transition idempotently.
    if (labelsChange) await operations.replaceLabels(decision.labels, { invalidatesRequests: false });
    await operations.releaseLocalOwnership?.();
    return { action: decision.action, cleanup: "ownership_released" };
  }
  const recordedTimelineEventIds = decision.action === "block" && operations.blockStarted?.reason === decision.reason
    ? operations.blockStarted.timelineEventIds
    : undefined;
  const timelineBaseline = decision.action === "block" && labelsChange && !recordedTimelineEventIds
    ? await operations.listTimelineEvents()
    : [];
  const timelineBaselineIds = recordedTimelineEventIds || timelineBaseline.map(eventId);
  if (decision.action === "block" && labelsChange && !recordedTimelineEventIds) {
    await operations.recordBlockStarted?.({ reason: decision.reason, timelineEventIds: timelineBaselineIds });
  }
  if (labelsChange) await operations.replaceLabels(decision.labels, { invalidatesRequests: decision.invalidatesRequests });

  let cutoffEventId: string | undefined;
  if (decision.action === "block") {
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
    cutoffEventId = eventId(cutoff);
    const body = recoveryComment(input.pr.number, input.pr.headRefOid, decision.reason, cutoffEventId);
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
  }

  let cleanup: string = decision.cleanup;
  if (decision.cleanup === "close_owned_workspace") {
    const closed = await operations.closeOwnedWorkspace?.();
    if (closed === true) {
      await operations.releaseLocalOwnership?.(cutoffEventId);
      cleanup = "ownership_released";
    } else cleanup = "preserve_workspace";
  }
  return { action: decision.action, ...(cutoffEventId ? { cutoffEventId } : {}), cleanup };
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
