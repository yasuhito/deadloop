import { describe, expect, it } from "vitest";

const {
  applyPrWorkAuthorityReconciliation,
  reconcilePrWorkAuthority,
  recoveryComment,
} = require("../src/pr-work-authority-reconciliation.cts");
const { classifyRequest } = require("../extensions/deadloop/automations/reconcile-pr-work-authority.cts");

const base = {
  pr: { number: 24, headRefOid: "a".repeat(40), labels: ["agent:in-progress", "customer:keep"] },
  request: { kind: "current" },
  runtime: { kind: "live_matching_owner" },
  requestLabels: ["agent:update-branch", "agent:implement", "agent:review"],
  inProgressLabel: "agent:in-progress",
  blockedLabel: "agent:blocked",
};

describe("PR runtime reconciliation", () => {
  it("keeps an attempt active when the runtime reports it live", () => {
    expect(reconcilePrWorkAuthority(base).action).toBe("keep_active");
  });

  it("blocks an attempt whose owner left before completion ran", () => {
    expect(reconcilePrWorkAuthority({ ...base, runtime: { kind: "owner_absent_owned" } }).action).toBe("block");
  });

  it("blocks a proven completion whose handoff was refused with its own reason", () => {
    const decision = reconcilePrWorkAuthority({ ...base, runtime: { kind: "owner_absent_owned" }, completion: { kind: "handoff_refused" } });

    expect(decision.reason).toBe("completion_handoff_refused");
  });

  it("explains a refused handoff without blaming a vanished owner", () => {
    expect(recoveryComment(24, "a".repeat(40), "completion_handoff_refused", "event-30")).toContain("completion report could not be handed over");
  });

  it("preserves a later request when the prior attempt's owner left", () => {
    const decision = reconcilePrWorkAuthority({
      ...base,
      pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] },
      request: { kind: "superseded" }, runtime: { kind: "owner_absent_owned" },
    });
    expect(decision.labels).toContain("agent:review");
  });

  it("binds a current request observation to the journaled event id", () => {
    const observed = classifyRequest([
      { id: "22", event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } },
    ], ["agent:review"], { requestEventId: "22" }, ["agent:review"]);
    expect(observed.request.kind).toBe("current");
  });

  it("detects a later request event without consulting comments", () => {
    const observed = classifyRequest([
      { id: "23", event: "labeled", created_at: "2026-07-20T10:01:00Z", label: { name: "agent:review" } },
    ], ["agent:review"], { requestEventId: "22" }, ["agent:review"]);
    expect(observed.request.kind).toBe("superseded");
  });

  it("keeps blocked recovery comments human readable", () => {
    expect(recoveryComment(24, "a".repeat(40), "runtime_owner_absent", "event-30")).toContain("no longer listed the recorded owner");
  });

  it("posts a blocked explanation for an absent owner", async () => {
    const comments: string[] = [];
    const events = [{ id: "block-1", event: "labeled", created_at: "2026-07-20T10:02:00Z", label: { name: "agent:blocked" }, actor: { login: "deadloop-bot" } }];
    let timelineReads = 0;
    await applyPrWorkAuthorityReconciliation(
      { ...base, runtime: { kind: "owner_absent_owned" } },
      {
        automationLogin: "deadloop-bot",
        listTimelineEvents: () => timelineReads++ === 0 ? [] : events,
        listComments: () => [],
        replaceLabels: () => {},
        comment: (body: string) => { comments.push(body); },
        closeOwnedWorkspace: () => true,
      },
    );
    expect(comments).toHaveLength(1);
  });
});
