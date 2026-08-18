/**
 * Deterministic reviewer-result contract.
 *
 * The review agent owns the semantic comparison against the native PR history:
 * which findings must be fixed, which are only advisory, and how the prior
 * required findings were disposed of. This module owns the deterministic half:
 * given that structured judgment, which transition is allowed.
 */

import type { PriorRequiredFindingDisposition } from "./reviewer-outcome-contract-types";

type ReviewTransition = "approve" | "repair" | "human_required";

type ReviewTransitionReason =
  | "no_required_findings"
  | "repair_progress_reported"
  | "reviewer_human_required"
  | "prior_required_findings_persist"
  | "resolved_finding_regressed"
  | "prior_and_new_required_findings_mixed"
  | "repair_progress_not_reported";

type ReviewTransitionDecision = {
  transition: ReviewTransition;
  reason: ReviewTransitionReason;
};

/**
 * A reviewer result as reported, which may still be unvalidated. The whole
 * result may be passed; only the outcome and the prior-finding disposition take
 * part in the decision, so the remaining fields are named but ignored.
 */
type ReviewerResultJudgment = {
  outcome?: unknown;
  priorRequiredFindings?: unknown;
  reviewedHead?: unknown;
  findings?: unknown;
  advisories?: unknown;
};

const PRIOR_REQUIRED_FINDING_DISPOSITIONS: readonly PriorRequiredFindingDisposition[] = [
  "none",
  "all_resolved",
  "persisted",
  "regressed",
  "mixed",
];

/** Dispositions that let the review agent report repair progress. */
const REPAIR_PROGRESS_DISPOSITIONS = new Set<PriorRequiredFindingDisposition>(["none", "all_resolved"]);

const HUMAN_REQUIRED_REASONS: Record<string, ReviewTransitionReason> = {
  persisted: "prior_required_findings_persist",
  regressed: "resolved_finding_regressed",
  mixed: "prior_and_new_required_findings_mixed",
};

function isPriorRequiredFindingDisposition(value: unknown): value is PriorRequiredFindingDisposition {
  return PRIOR_REQUIRED_FINDING_DISPOSITIONS.includes(value as PriorRequiredFindingDisposition);
}

/**
 * Maps a validated reviewer judgment to the single transition deadloop may run.
 * Advisory observations never take part: only required findings and the prior
 * disposition decide whether automatic repair stays eligible.
 */
function decideReviewTransition(result: ReviewerResultJudgment): ReviewTransitionDecision {
  if (result.outcome === "approved") return { transition: "approve", reason: "no_required_findings" };
  if (result.outcome === "changes_requested") {
    const disposition = result.priorRequiredFindings;
    if (isPriorRequiredFindingDisposition(disposition) && REPAIR_PROGRESS_DISPOSITIONS.has(disposition)) {
      return { transition: "repair", reason: "repair_progress_reported" };
    }
    const reason = HUMAN_REQUIRED_REASONS[String(disposition)] ?? "repair_progress_not_reported";
    return { transition: "human_required", reason };
  }
  return {
    transition: "human_required",
    reason: result.outcome === "human_required" ? "reviewer_human_required" : "repair_progress_not_reported",
  };
}

module.exports = { decideReviewTransition, isPriorRequiredFindingDisposition };
