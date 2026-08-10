import { describe, expect, it } from "vitest";

const {
  applyPrWorkAuthorityReconciliation,
  migrationDecision,
  postBlockRequestIsEligible,
  reconcilePrWorkAuthority,
  recoveryComment,
  requestAfterInvalidationCutoff,
} = require("../src/pr-work-authority-reconciliation.ts");

const base = {
  pr: {
    number: 42,
    headRefOid: "a".repeat(40),
    labels: ["agent:in-progress", "customer:keep"],
  },
  claim: { kind: "authorized" },
  runtime: { kind: "live_matching_owner" },
  requestEvents: [{ id: "10", event: "labeled", created_at: "2026-08-01T10:00:00Z", label: { name: "agent:review" } }],
  requestLabels: ["agent:update-branch", "agent:implement", "agent:review"],
  inProgressLabel: "agent:in-progress",
  blockedLabel: "agent:blocked",
};

describe("PR work-authority reconciliation", () => {
  it("keeps a live matching claim unchanged", () => {
    expect(reconcilePrWorkAuthority(base).action).toBe("keep_active");
  });

  it("blocks an expired claim with one replacement label set", () => {
    expect(reconcilePrWorkAuthority({ ...base, claim: { kind: "expired" } }).labels).toEqual(["customer:keep", "agent:blocked"]);
  });

  it("blocks missing claim evidence", () => {
    expect(reconcilePrWorkAuthority({ ...base, claim: { kind: "missing" } }).action).toBe("block");
  });

  it("blocks malformed claim evidence", () => {
    expect(reconcilePrWorkAuthority({ ...base, claim: { kind: "malformed" } }).reason).toBe("claim_malformed");
  });

  it("blocks unreachable runtime", () => {
    expect(reconcilePrWorkAuthority({ ...base, runtime: { kind: "unreachable" } }).reason).toBe("runtime_unreachable");
  });

  it("releases safely stopped owned runtime", () => {
    expect(reconcilePrWorkAuthority({ ...base, runtime: { kind: "stopped_owned" } }).cleanup).toBe("close_owned_workspace");
  });

  it("preserves ambiguous runtime", () => {
    expect(reconcilePrWorkAuthority({ ...base, runtime: { kind: "ambiguous" } }).cleanup).toBe("preserve_workspace");
  });

  it("keeps a queued request during normal supersession", () => {
    expect(reconcilePrWorkAuthority({ ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] }, claim: { kind: "superseded" } }).labels).toContain("agent:review");
  });

  it("does not release a live superseded owner", () => {
    expect(reconcilePrWorkAuthority({ ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] }, claim: { kind: "superseded" } }).action).toBe("keep_superseded");
  });

  it("releases a stopped superseded owner for its queued request", () => {
    expect(reconcilePrWorkAuthority({ ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] }, claim: { kind: "superseded" }, runtime: { kind: "stopped_owned" } }).action).toBe("release_for_request");
  });

  it("removes the temporary block after safe supersession cleanup", () => {
    expect(reconcilePrWorkAuthority({ ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review", "agent:blocked"] }, claim: { kind: "superseded" }, runtime: { kind: "stopped_owned" } }).labels).not.toContain("agent:blocked");
  });

  it("preserves a superseding request when runtime ownership is ambiguous", () => {
    expect(reconcilePrWorkAuthority({ ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] }, claim: { kind: "superseded" }, runtime: { kind: "ambiguous" } }).labels).toContain("agent:review");
  });

  it("invalidates a queued request during expiry", () => {
    expect(reconcilePrWorkAuthority({ ...base, pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] }, claim: { kind: "expired" } }).labels).not.toContain("agent:review");
  });

  it("orders a request before the blocked cutoff as invalid", () => {
    expect(requestAfterInvalidationCutoff(
      { id: "20", created_at: "2026-08-01T10:00:00Z" },
      { id: "21", created_at: "2026-08-01T10:00:00Z" },
    )).toBe(false);
  });

  it("orders a request after the blocked cutoff as eligible", () => {
    expect(requestAfterInvalidationCutoff(
      { id: "22", created_at: "2026-08-01T10:00:01Z" },
      { id: "21", created_at: "2026-08-01T10:00:00Z" },
    )).toBe(true);
  });

  it("requires a bound recovery marker before selecting a post-block request", () => {
    const cutoff = { id: "30", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } };
    const request = { id: "31", event: "labeled", created_at: "2026-08-01T10:02:00Z", actor: { login: "human" }, label: { name: "agent:review" } };
    expect(postBlockRequestIsEligible({ pr: base.pr, request, events: [cutoff, request], comments: [], authorizedLogins: ["deadloop-bot"], blockedLabel: "agent:blocked" })).toBe(false);
  });

  it("selects a post-block request bound by the recovery marker", () => {
    const cutoff = { id: "30", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } };
    const request = { id: "31", event: "labeled", created_at: "2026-08-01T10:02:00Z", actor: { login: "human" }, label: { name: "agent:review" } };
    const comments = [{ author: { login: "deadloop-bot" }, body: recoveryComment(base.pr.number, base.pr.headRefOid, "claim_expired", "30") }];
    expect(postBlockRequestIsEligible({ pr: base.pr, request, events: [cutoff, request], comments, authorizedLogins: ["deadloop-bot"], blockedLabel: "agent:blocked" })).toBe(true);
  });

  it("validates a post-block request with a configured blocked label", () => {
    const cutoff = { id: "40", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "custom:blocked" } };
    const request = { id: "41", event: "labeled", created_at: "2026-08-01T10:02:00Z", actor: { login: "human" }, label: { name: "agent:review" } };
    const comments = [{ author: { login: "deadloop-bot" }, body: recoveryComment(base.pr.number, base.pr.headRefOid, "claim_expired", "40") }];
    expect(postBlockRequestIsEligible({ pr: base.pr, request, events: [cutoff, request], comments, authorizedLogins: ["deadloop-bot"], blockedLabel: "custom:blocked" })).toBe(true);
  });

  it("does not let report_received imply active work", () => {
    expect(reconcilePrWorkAuthority({ ...base, journalPhase: "report_received", claim: { kind: "missing" } }).action).toBe("block");
  });

  it("creates one recovery comment across repeated reconciliation", async () => {
    const comments: Array<Record<string, unknown>> = [];
    const input = { ...base, pr: { ...base.pr, labels: [...base.pr.labels] }, claim: { kind: "expired" } };
    const operations = {
      automationLogin: "deadloop-bot",
      listTimelineEvents: () => input.pr.labels.includes("agent:blocked") ? [{ id: "30", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } }] : [],
      listComments: () => comments,
      replaceLabels: (next: string[]) => { input.pr.labels = next; },
      comment: (body: string) => comments.push({ body, author: { login: "deadloop-bot" } }),
    };

    await applyPrWorkAuthorityReconciliation(input, operations);
    await applyPrWorkAuthorityReconciliation(input, operations);
    expect(comments).toHaveLength(1);
  });

  it("releases ownership only after an owned workspace closes", async () => {
    let released = false;
    const result = await applyPrWorkAuthorityReconciliation(
      { ...base, claim: { kind: "expired" }, runtime: { kind: "stopped_owned" } },
      {
        automationLogin: "deadloop-bot",
        listTimelineEvents: (() => { let reads = 0; return () => ++reads === 1 ? [] : [{ id: "30", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } }]; })(),
        listComments: () => [],
        replaceLabels: () => {},
        comment: () => {},
        closeOwnedWorkspace: () => true,
        releaseLocalOwnership: () => { released = true; },
      },
    );
    expect({ released, cleanup: result.cleanup }).toEqual({ released: true, cleanup: "ownership_released" });
  });

  it("preserves ownership when an owned workspace does not close", async () => {
    const result = await applyPrWorkAuthorityReconciliation(
      { ...base, claim: { kind: "expired" }, runtime: { kind: "stopped_owned" } },
      {
        automationLogin: "deadloop-bot",
        listTimelineEvents: (() => { let reads = 0; return () => ++reads === 1 ? [] : [{ id: "30", event: "labeled", created_at: "2026-08-01T10:01:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:blocked" } }]; })(),
        listComments: () => [],
        replaceLabels: () => {},
        comment: () => {},
        closeOwnedWorkspace: () => false,
      },
    );
    expect(result.cleanup).toBe("preserve_workspace");
  });
});

describe("legacy PR migration guard", () => {
  it("keeps PR 227 blocked before deployment", () => {
    expect(migrationDecision({ repository: "yasuhito/deadloop", number: 227, deployed: false, conflicting: false }).action).toBe("keep_blocked");
  });

  it("makes PR 227 review-eligible after deployment", () => {
    expect(migrationDecision({ repository: "yasuhito/deadloop", number: 227, deployed: true, conflicting: false }).requestLabel).toBe("agent:review");
  });

  it("keeps PR 228 blocked before deployment", () => {
    expect(migrationDecision({ repository: "yasuhito/deadloop", number: 228, deployed: false, conflicting: true }).action).toBe("keep_blocked");
  });

  it("turns conflicting PR 228 into an update request after deployment", () => {
    expect(migrationDecision({ repository: "yasuhito/deadloop", number: 228, deployed: true, conflicting: true }).requestLabel).toBe("agent:update-branch");
  });

  it.each([229, 236])("keeps PR %s blocked before deployment", (number) => {
    expect(migrationDecision({ repository: "yasuhito/deadloop", number, deployed: false, conflicting: false }).action).toBe("keep_blocked");
  });

  it.each([229, 236])("makes PR %s review-eligible after deployment", (number) => {
    expect(migrationDecision({ repository: "yasuhito/deadloop", number, deployed: true, conflicting: false }).requestLabel).toBe("agent:review");
  });
});
