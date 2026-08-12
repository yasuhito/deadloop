const FINDING_SEVERITIES = new Set(["blocker", "major", "minor"]);
const PRIOR_STATUSES = new Set(["none", "all_resolved", "persisted", "regressed", "mixed", "human_judgment"]);
const HUMAN_PRIOR_STATUSES = new Set(["persisted", "regressed", "mixed", "human_judgment"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validItem(value, severityRequired) {
  if (!isObject(value) || typeof value.title !== "string" || !value.title.trim()) return false;
  if (typeof value.body !== "string" || !value.body.trim()) return false;
  if (value.path !== undefined && (typeof value.path !== "string" || !value.path.trim())) return false;
  if (value.line !== undefined && (!Number.isInteger(value.line) || value.line < 1)) return false;
  const validSeverity = typeof value.severity === "string" && FINDING_SEVERITIES.has(value.severity);
  return (!severityRequired || validSeverity) && (value.severity === undefined || validSeverity);
}

function reviewerOutcomeValidationError(value) {
  if (!isObject(value) || !["approved", "changes_requested", "human_required"].includes(String(value.outcome))) {
    return "invalid_reviewer_outcome";
  }
  if (!Array.isArray(value.requiredFindings) || !value.requiredFindings.every((item) => validItem(item, true))) {
    return "invalid_required_findings";
  }
  if (!Array.isArray(value.advisoryObservations) || !value.advisoryObservations.every((item) => validItem(item, false))) {
    return "invalid_advisory_observations";
  }
  if (!isObject(value.priorFindingDisposition)
    || !PRIOR_STATUSES.has(String(value.priorFindingDisposition.status))
    || typeof value.priorFindingDisposition.summary !== "string"
    || !value.priorFindingDisposition.summary.trim()) {
    return "invalid_prior_finding_disposition";
  }

  const outcome = String(value.outcome);
  const priorStatus = String(value.priorFindingDisposition.status);
  if (outcome === "approved" && value.requiredFindings.length !== 0) return "approved_requires_zero_required_findings";
  if (outcome === "changes_requested" && value.requiredFindings.length === 0) return "changes_requested_requires_required_findings";
  if (outcome === "human_required") {
    if (!HUMAN_PRIOR_STATUSES.has(priorStatus)) return "human_required_requires_human_disposition";
    if (value.repairProgress !== undefined) return "human_required_forbids_repair_progress";
    return undefined;
  }
  if (HUMAN_PRIOR_STATUSES.has(priorStatus)) return "prior_disposition_requires_human_required";
  if (value.repairProgress === undefined) return undefined;
  if (outcome !== "changes_requested") return "repair_progress_requires_changes_requested";
  if (value.repairProgress === "initial_required_findings" && priorStatus === "none") return undefined;
  if (value.repairProgress === "all_prior_resolved_current_findings_new" && priorStatus === "all_resolved") return undefined;
  return "repair_progress_disposition_mismatch";
}

function reviewRepairEligible(value) {
  if (reviewerOutcomeValidationError(value) !== undefined || !isObject(value)) return false;
  return value.outcome === "changes_requested" && (
    value.repairProgress === "initial_required_findings"
    || value.repairProgress === "all_prior_resolved_current_findings_new"
  );
}

module.exports = { reviewerOutcomeValidationError, reviewRepairEligible };
