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
export type PrRequestRole = "branch-update" | "review-repair" | "reviewer";

/** The configured request-label names, one per role. */
export type PrRequestLabels = {
  updateBranch: string;
  implement: string;
  review: string;
};

export type PrRequest = {
  role: PrRequestRole;
  label: string;
};

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

module.exports = { orderedPrRequestLabels, prRequestLabelForRole, selectPrRequest };
