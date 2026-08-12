export type ReviewItem = {
  title: string;
  body: string;
  path?: string;
  line?: number;
  severity?: "blocker" | "major" | "minor";
};

export type PriorFindingDisposition = {
  status: "none" | "all_resolved" | "persisted" | "regressed" | "mixed" | "human_judgment";
  summary: string;
};

export type RepairProgress = "initial_required_findings" | "all_prior_resolved_current_findings_new";

export type ReviewerOutcome = {
  outcome: "approved" | "changes_requested" | "human_required";
  reviewedHead: string;
  requiredFindings: ReviewItem[];
  advisoryObservations: ReviewItem[];
  priorFindingDisposition: PriorFindingDisposition;
  repairProgress?: RepairProgress;
};

const contract = require("./reviewer-outcome-contract.cjs") as {
  reviewerOutcomeValidationError(value: unknown): string | undefined;
  reviewRepairEligible(value: unknown): boolean;
};

/** Validates only deterministic report shape and allowed transitions, never semantic finding identity. */
export const reviewerOutcomeValidationError = contract.reviewerOutcomeValidationError;
export const reviewRepairEligible = contract.reviewRepairEligible;
