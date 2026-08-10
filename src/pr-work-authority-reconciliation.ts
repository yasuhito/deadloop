type JsonObject = Record<string, any>;
const GITHUB_STATE_RECONCILIATION_VERSION = 1;

type ClaimObservation =
  | { kind: "authorized" }
  | { kind: "expired" }
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "ambiguous" }
  | { kind: "superseded" };

type RuntimeObservation =
  | { kind: "live_matching_owner" }
  | { kind: "stopped_owned" }
  | { kind: "unreachable" }
  | { kind: "ambiguous" };

type ReconciliationInput = {
  pr: { number: number; headRefOid: string; labels: Array<string | { name?: string }> };
  claim: ClaimObservation;
  runtime: RuntimeObservation;
  requestEvents?: JsonObject[];
  requestLabels: string[];
  inProgressLabel: string;
  blockedLabel: string;
  journalPhase?: string;
};

type ReconciliationDecision =
  | { action: "keep_active"; cleanup: "none" }
  | { action: "keep_superseded"; labels: string[]; cleanup: "none" }
  | { action: "release_for_request"; reason: "request_superseded_active_attempt"; labels: string[]; cleanup: "close_owned_workspace" | "preserve_workspace" }
  | {
      action: "block";
      reason: "claim_expired" | "claim_missing" | "claim_malformed" | "claim_ambiguous" | "runtime_unreachable" | "runtime_ambiguous" | "runtime_owner_stopped";
      labels: string[];
      cleanup: "none" | "close_owned_workspace" | "preserve_workspace";
      invalidatesRequests: boolean;
    };

function labelNames(labels: Array<string | { name?: string }>): string[] {
  return labels.map((label) => typeof label === "string" ? label : String(label.name || "")).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function blockLabels(input: ReconciliationInput, preserveRequests = false): string[] {
  const managed = new Set([...input.requestLabels, input.inProgressLabel, input.blockedLabel]);
  const requests = preserveRequests
    ? labelNames(input.pr.labels).filter((label) => input.requestLabels.includes(label))
    : [];
  return unique([
    ...labelNames(input.pr.labels).filter((label) => !managed.has(label)),
    ...requests,
    input.blockedLabel,
  ]);
}

function releaseLabels(input: ReconciliationInput): string[] {
  return labelNames(input.pr.labels).filter((label) => label !== input.inProgressLabel && label !== input.blockedLabel);
}

/**
 * Pure GitHub/workspace policy. Callers perform the returned full-label replacement in one API
 * mutation, then bind expiry invalidation to the resulting authenticated blocked event.
 */
function reconcilePrWorkAuthority(input: ReconciliationInput): ReconciliationDecision {
  if (input.claim.kind === "authorized" && input.runtime.kind === "live_matching_owner") {
    return { action: "keep_active", cleanup: "none" };
  }
  if (input.claim.kind === "superseded") {
    if (input.runtime.kind === "live_matching_owner") {
      return { action: "keep_superseded", labels: labelNames(input.pr.labels), cleanup: "none" };
    }
    if (input.runtime.kind === "stopped_owned") {
      return {
        action: "release_for_request",
        reason: "request_superseded_active_attempt",
        labels: releaseLabels(input),
        cleanup: "close_owned_workspace",
      };
    }
    const reason = input.runtime.kind === "unreachable" ? "runtime_unreachable" : "runtime_ambiguous";
    return {
      action: "block",
      reason,
      labels: blockLabels(input, true),
      cleanup: "preserve_workspace",
      invalidatesRequests: false,
    };
  }

  const cleanup = input.runtime.kind === "stopped_owned"
    ? "close_owned_workspace"
    : input.runtime.kind === "ambiguous" || input.runtime.kind === "unreachable"
      ? "preserve_workspace"
      : "none";
  const reason = input.claim.kind === "expired" ? "claim_expired"
    : input.claim.kind === "missing" ? "claim_missing"
      : input.claim.kind === "malformed" ? "claim_malformed"
        : input.claim.kind === "ambiguous" ? "claim_ambiguous"
          : input.runtime.kind === "unreachable" ? "runtime_unreachable"
            : input.runtime.kind === "ambiguous" ? "runtime_ambiguous"
              : "runtime_owner_stopped";
  return { action: "block", reason, labels: blockLabels(input), cleanup, invalidatesRequests: true };
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

function requestAfterInvalidationCutoff(request: JsonObject, cutoff: JsonObject): boolean {
  return Boolean(eventId(request) && eventId(cutoff)) && compareGithubEvents(request, cutoff) > 0;
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

function authenticatedBlockedCutoff(
  events: JsonObject[],
  automationLogin: string,
  blockedLabel: string,
): JsonObject | null {
  return events.filter((event) => eventAction(event) === "labeled"
    && eventLabel(event) === blockedLabel
    && eventActor(event) === automationLogin.toLowerCase()
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
    claim_expired: "the active claim expired",
    claim_missing: "the active claim comment or journal was missing",
    claim_malformed: "the active claim evidence was malformed",
    claim_ambiguous: "more than one possible owner or claim was observed",
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
  recordBlockStarted?(input: { reason: string; timelineEventIds: string[] }): void | Promise<void>;
  listTimelineEvents(): JsonObject[] | Promise<JsonObject[]>;
  listComments(): JsonObject[] | Promise<JsonObject[]>;
  replaceLabels(labels: string[]): void | Promise<void>;
  comment(body: string): void | Promise<void>;
  closeOwnedWorkspace?(): boolean | Promise<boolean>;
  releaseLocalOwnership?(cutoffEventId?: string): void | Promise<void>;
};

/** Executes only recovery effects. It exposes no push, ready, merge, or request-claim operation. */
async function applyPrWorkAuthorityReconciliation(
  input: ReconciliationInput,
  operations: ReconciliationOperations,
): Promise<{ action: string; cutoffEventId?: string; cleanup: string }> {
  const decision = reconcilePrWorkAuthority(input);
  if (decision.action === "keep_active" || decision.action === "keep_superseded") return { action: decision.action, cleanup: "none" };

  const currentLabels = labelNames(input.pr.labels);
  const labelsChange = !sameLabels(currentLabels, decision.labels);
  const timelineBaseline = decision.action === "block" && labelsChange
    ? await operations.listTimelineEvents()
    : [];
  if (decision.action === "block" && labelsChange) {
    await operations.recordBlockStarted?.({ reason: decision.reason, timelineEventIds: timelineBaseline.map(eventId) });
  }
  if (labelsChange) await operations.replaceLabels(decision.labels);

  let cutoffEventId: string | undefined;
  if (decision.action === "block") {
    const events = await operations.listTimelineEvents();
    const baselineIds = new Set(timelineBaseline.map(eventId));
    const newBlockedEvents = events.filter((event) => !baselineIds.has(eventId(event))
      && eventAction(event) === "labeled"
      && eventLabel(event) === input.blockedLabel
      && eventActor(event) === operations.automationLogin.toLowerCase());
    const cutoff = labelsChange
      ? newBlockedEvents.length === 1 ? newBlockedEvents[0] : null
      : authenticatedBlockedCutoff(events, operations.automationLogin, input.blockedLabel);
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
  pr: { number: number; headRefOid: string };
  request: JsonObject;
  events: JsonObject[];
  comments: JsonObject[];
  authorizedLogins: string[];
}): boolean {
  const authorized = new Set(input.authorizedLogins.map((login) => login.toLowerCase()));
  for (const comment of input.comments) {
    const author = String(comment.author?.login || comment.user?.login || "").toLowerCase();
    const marker = parseRecoveryMarker(comment.body);
    if (!authorized.has(author) || !marker
      || Number(marker.number) !== input.pr.number
      || String(marker.head || "").toLowerCase() !== input.pr.headRefOid.toLowerCase()) continue;
    const cutoff = input.events.find((event) => eventId(event) === String(marker.cutoffEventId || "")
      && eventAction(event) === "labeled" && eventLabel(event) === "agent:blocked" && eventActor(event) === author);
    if (cutoff && requestAfterInvalidationCutoff(input.request, cutoff)) return true;
  }
  return false;
}

const LEGACY_MIGRATION_PRS = new Set([227, 228, 229, 236]);

function migrationDecision(input: {
  repository: string;
  number: number;
  deployed: boolean;
  conflicting: boolean;
}): { action: "not_applicable" | "keep_blocked" | "request"; requestLabel?: "agent:review" | "agent:update-branch" } {
  if (input.repository.toLowerCase() !== "yasuhito/deadloop" || !LEGACY_MIGRATION_PRS.has(input.number)) {
    return { action: "not_applicable" };
  }
  if (!input.deployed) return { action: "keep_blocked" };
  return {
    action: "request",
    requestLabel: input.number === 228 && input.conflicting ? "agent:update-branch" : "agent:review",
  };
}

module.exports = {
  GITHUB_STATE_RECONCILIATION_VERSION,
  applyPrWorkAuthorityReconciliation,
  authenticatedBlockedCutoff,
  compareGithubEvents,
  migrationDecision,
  parseRecoveryMarker,
  postBlockRequestIsEligible,
  reconcilePrWorkAuthority,
  recoveryComment,
  requestAfterInvalidationCutoff,
};
