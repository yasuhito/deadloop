import { describe, expect, it } from "vitest";

const { decideReviewTransition } = require("../src/reviewer-outcome-contract.ts");

const advisory = { title: "Naming", body: "A clearer name would help." };
const required = { title: "Unsafe fallback", body: "The fallback approves a failed review.", severity: "blocker" as const };

describe("reviewer outcome transition", () => {
  it("approves a result without required findings", () => {
    expect(decideReviewTransition({ outcome: "approved", findings: [] }).transition).toBe("approve");
  });

  it("approves a result that only carries advisory observations", () => {
    expect(decideReviewTransition({ outcome: "approved", findings: [], advisories: [advisory] }).transition).toBe("approve");
  });

  it("repairs new required findings reported without prior required findings", () => {
    expect(
      decideReviewTransition({ outcome: "changes_requested", findings: [required], priorRequiredFindings: "none" }).transition,
    ).toBe("repair");
  });

  it("repairs entirely new required findings reported after every prior finding resolved", () => {
    expect(
      decideReviewTransition({ outcome: "changes_requested", findings: [required], priorRequiredFindings: "all_resolved" }).transition,
    ).toBe("repair");
  });

  it("hands a persisted prior required finding to a human", () => {
    expect(
      decideReviewTransition({ outcome: "changes_requested", findings: [required], priorRequiredFindings: "persisted" }).transition,
    ).toBe("human_required");
  });

  it("hands a regressed prior required finding to a human", () => {
    expect(
      decideReviewTransition({ outcome: "changes_requested", findings: [required], priorRequiredFindings: "regressed" }).transition,
    ).toBe("human_required");
  });

  it("hands mixed prior and new required findings to a human", () => {
    expect(
      decideReviewTransition({ outcome: "changes_requested", findings: [required], priorRequiredFindings: "mixed" }).transition,
    ).toBe("human_required");
  });

  it("refuses repair when no repair progress is reported", () => {
    expect(decideReviewTransition({ outcome: "changes_requested", findings: [required] }).transition).toBe("human_required");
  });

  it("explains a missing repair-progress judgment", () => {
    expect(decideReviewTransition({ outcome: "changes_requested", findings: [required] }).reason).toBe("repair_progress_not_reported");
  });

  it("explains a persisted prior required finding", () => {
    expect(
      decideReviewTransition({ outcome: "changes_requested", findings: [required], priorRequiredFindings: "persisted" }).reason,
    ).toBe("prior_required_findings_persist");
  });

  it("explains a regressed prior required finding", () => {
    expect(
      decideReviewTransition({ outcome: "changes_requested", findings: [required], priorRequiredFindings: "regressed" }).reason,
    ).toBe("resolved_finding_regressed");
  });

  it("explains mixed prior and new required findings", () => {
    expect(
      decideReviewTransition({ outcome: "changes_requested", findings: [required], priorRequiredFindings: "mixed" }).reason,
    ).toBe("prior_and_new_required_findings_mixed");
  });

  it("keeps a reported human decision on the human path", () => {
    expect(decideReviewTransition({ outcome: "human_required", findings: [] }).transition).toBe("human_required");
  });

  it("ignores advisory observations when deciding repair eligibility", () => {
    expect(
      decideReviewTransition({ outcome: "approved", findings: [], advisories: [advisory, advisory] }).reason,
    ).toBe("no_required_findings");
  });

  it("refuses repair for an unknown outcome", () => {
    expect(decideReviewTransition({ outcome: "merged", findings: [] }).transition).toBe("human_required");
  });
});
