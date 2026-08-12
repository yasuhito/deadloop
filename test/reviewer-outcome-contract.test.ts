import { describe, expect, it } from "vitest";

import {
  reviewerOutcomeValidationError,
  reviewRepairEligible,
} from "../src/reviewer-outcome-contract";

const finding = { title: "Race", body: "The stale head can be pushed.", severity: "major" as const };
const advisory = { title: "Naming", body: "A clearer name would help." };
const priorNone = { status: "none" as const, summary: "No prior required findings." };
const priorResolved = { status: "all_resolved" as const, summary: "All prior required findings are resolved." };

function result(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "approved",
    reviewedHead: "a".repeat(40),
    requiredFindings: [],
    advisoryObservations: [],
    priorFindingDisposition: priorNone,
    ...overrides,
  };
}

describe("reviewer outcome contract", () => {
  it("accepts approval without required findings or advisories", () => {
    expect(reviewerOutcomeValidationError(result())).toBeUndefined();
  });

  it("accepts approval with advisory observations", () => {
    expect(reviewerOutcomeValidationError(result({ advisoryObservations: [advisory] }))).toBeUndefined();
  });

  it("rejects approval with a required finding", () => {
    expect(reviewerOutcomeValidationError(result({ requiredFindings: [finding] }))).toBe("approved_requires_zero_required_findings");
  });

  it("rejects changes requested without a required finding", () => {
    expect(reviewerOutcomeValidationError(result({ outcome: "changes_requested" }))).toBe("changes_requested_requires_required_findings");
  });

  it("does not make changes requested eligible without repair progress", () => {
    expect(reviewRepairEligible(result({ outcome: "changes_requested", requiredFindings: [finding] }))).toBe(false);
  });

  it("allows initial required findings to report repair progress", () => {
    expect(reviewRepairEligible(result({ outcome: "changes_requested", requiredFindings: [finding], repairProgress: "initial_required_findings" }))).toBe(true);
  });

  it("allows entirely new findings after prior findings resolve", () => {
    expect(reviewRepairEligible(result({ outcome: "changes_requested", requiredFindings: [finding], priorFindingDisposition: priorResolved, repairProgress: "all_prior_resolved_current_findings_new" }))).toBe(true);
  });

  it("requires human handoff for a persisted prior finding", () => {
    expect(reviewerOutcomeValidationError(result({ outcome: "changes_requested", requiredFindings: [finding], priorFindingDisposition: { status: "persisted", summary: "A prior finding remains." } }))).toBe("prior_disposition_requires_human_required");
  });

  it("requires human handoff for a regressed prior finding", () => {
    expect(reviewerOutcomeValidationError(result({ outcome: "approved", priorFindingDisposition: { status: "regressed", summary: "A resolved finding returned." } }))).toBe("prior_disposition_requires_human_required");
  });

  it("requires human handoff for mixed prior and new findings", () => {
    expect(reviewerOutcomeValidationError(result({ outcome: "changes_requested", requiredFindings: [finding], priorFindingDisposition: { status: "mixed", summary: "Prior and new findings are mixed." } }))).toBe("prior_disposition_requires_human_required");
  });

  it("accepts a human-required product judgment", () => {
    expect(reviewerOutcomeValidationError(result({ outcome: "human_required", priorFindingDisposition: { status: "human_judgment", summary: "Product intent is ambiguous." } }))).toBeUndefined();
  });

  it("does not put advisory observations in the repair contract", () => {
    expect(reviewRepairEligible(result({ outcome: "changes_requested", requiredFindings: [finding], advisoryObservations: [advisory], repairProgress: "initial_required_findings" }))).toBe(true);
  });
});
