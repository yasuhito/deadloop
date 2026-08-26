const { compareGithubTimelineEvents } = require("./github-timeline-order.cts");

/**
 * Deterministic pull request Agent-request order.
 *
 * A pull request may carry several waiting Agent requests at once: a review
 * request queued while a repair is still running, a branch update raised on top
 * of both. GitHub keeps them all, so the order in which deadloop consumes them
 * must be a property of the workflow rather than of whichever driver happened to
 * look first. Every consumer reads that order from here.
 */

/** The role a request hands the work to. */
type PrRequestRole = "branch-update" | "review-repair" | "reviewer";

/** The configured request-label names, one per role. */
type PrRequestLabels = {
  updateBranch: string;
  implement: string;
  review: string;
};

type PrRequest = {
  role: PrRequestRole;
  label: string;
};

type TimelineEvent = Record<string, any>;

/** Latest labeled event for one configured request label, ordered by server event identity. */
function latestPrRequestEvent(events: TimelineEvent[], requestLabel: string): TimelineEvent | null {
  const matching = events.filter((event) =>
    String(event.event || "").toLowerCase() === "labeled"
    && String(event.label?.name || "") === requestLabel
    && String(event.id || event.node_id || ""),
  );
  matching.sort(compareGithubTimelineEvents);
  return matching.at(-1) || null;
}

/**
 * Processing order: a branch update first, because a conflicted head makes both
 * later roles work against a revision that cannot merge; then the repair, which
 * produces the head a review would otherwise have to redo; the review last.
 */
const PR_REQUEST_ORDER: ReadonlyArray<{ role: PrRequestRole; key: keyof PrRequestLabels }> = [
  { role: "branch-update", key: "updateBranch" },
  { role: "review-repair", key: "implement" },
  { role: "reviewer", key: "review" },
];

function orderedPrRequestLabels(requestLabels: PrRequestLabels): string[] {
  return PR_REQUEST_ORDER.map((entry) => requestLabels[entry.key]);
}

/** The one request label a role consumes. An unknown role must never reach a GitHub mutation. */
function prRequestLabelForRole(requestLabels: PrRequestLabels, role: string): string {
  const entry = PR_REQUEST_ORDER.find((candidate) => candidate.role === role);
  const label = entry && requestLabels[entry.key];
  if (!label) throw new Error(`current configuration has no request label for the ${role} role`);
  return label;
}

/** The single request to consume next, or null when the pull request has none waiting. */
function selectPrRequest(labels: Iterable<string>, requestLabels: PrRequestLabels): PrRequest | null {
  const present = new Set(labels);
  for (const entry of PR_REQUEST_ORDER) {
    const label = requestLabels[entry.key];
    if (label && present.has(label)) return { role: entry.role, label };
  }
  return null;
}

/**
 * The label move that stops a pull request deadloop decided it cannot finish safely.
 *
 * A stopped pull request holds no waiting Agent request. "Deadloop stopped this" and "deadloop is
 * still asked to work on this" are not both true, and a request left behind is one every other
 * path reads as work to resume — which is how a stop becomes a loop rather than a handoff. A
 * person restarts the work by adding a request label, and that event necessarily follows the
 * block, so the ordering alone separates a real restart from the leftovers of the stop.
 *
 * The block itself is not lifted here. It is lifted when a new attempt claims the target and
 * replaces every managed label, so a pull request still carrying it is one nothing has started on.
 */
function blockedPrLabelMove(
  requestLabels: PrRequestLabels,
  inProgressLabel: string,
  blockedLabel: string,
): { remove: string[]; add: string[] } {
  return {
    remove: [...orderedPrRequestLabels(requestLabels), inProgressLabel].filter(Boolean),
    add: [blockedLabel],
  };
}

module.exports = { blockedPrLabelMove, latestPrRequestEvent, orderedPrRequestLabels, prRequestLabelForRole, selectPrRequest };
