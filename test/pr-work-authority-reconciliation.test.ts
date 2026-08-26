import { describe, expect, it } from "vitest";

const {
  applyPrWorkAuthorityReconciliation,
  postBlockRequestIsEligible,
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

describe("launch failures recorded by the pull request's own attempts", () => {
  const missingJournal = {
    ...base,
    request: { kind: "missing" },
    runtime: { kind: "ambiguous" },
    pr: { ...base.pr, labels: ["agent:blocked"] },
  };

  it("blocks a missing journal with the recorded launch failures instead of attempt_missing", () => {
    const decision = reconcilePrWorkAuthority({
      ...missingJournal,
      launchFailures: ["worktree agent/issue-42 does not resolve to the recorded canonical checkout"],
    });
    expect(decision.reason).toBe("launch_unprepared");
  });

  it("keeps naming a missing journal when no launch failure is recorded", () => {
    expect(reconcilePrWorkAuthority(missingJournal).reason).toBe("attempt_missing");
  });

  it("names the actual failure in the blocked explanation", () => {
    const body = recoveryComment(24, "a".repeat(40), "launch_unprepared", "event-30", [
      "worktree agent/issue-42 does not resolve to the recorded canonical checkout",
    ]);
    expect(body).toContain("does not resolve to the recorded canonical checkout");
  });

  it("counts every failed request cycle in the blocked explanation", () => {
    const body = recoveryComment(24, "a".repeat(40), "launch_unprepared", "event-30", [
      "checkout alignment stopped: cannot fast-forward", "checkout alignment stopped: cannot fast-forward",
    ]);
    expect(body).toContain("2 Agent request(s) failed to launch");
  });

  it("tells the operator what to do about the failing shape", () => {
    const body = recoveryComment(24, "a".repeat(40), "launch_unprepared", "event-30", [
      "worktree agent/issue-42 already has an open attempt workspace",
    ]);
    expect(body).toContain("resolve the named attempt");
  });

  it("posts the launch failure evidence when reconciliation blocks", async () => {
    const comments: string[] = [];
    const events = [{ id: "block-1", event: "labeled", created_at: "2026-07-20T10:02:00Z", label: { name: "agent:blocked" }, actor: { login: "deadloop-bot" } }];
    await applyPrWorkAuthorityReconciliation(
      { ...missingJournal, launchFailures: ["worktree agent/issue-42 does not resolve to the recorded canonical checkout"] },
      {
        automationLogin: "deadloop-bot",
        // Labels already show the blocked state, so the cutoff comes from the single timeline read.
        listTimelineEvents: () => events,
        listComments: () => [],
        replaceLabels: () => {},
        comment: (body: string) => { comments.push(body); },
      },
    );
    expect(comments.some((body) => body.includes("does not resolve to the recorded canonical checkout"))).toBe(true);
  });

  // Launch errors quote runtime output, and that output embeds host command lines with absolute
  // local paths. The published explanation keeps the reason but scrubs the locations.
  it("keeps local paths out of the published failure explanation", () => {
    const body = recoveryComment(24, "a".repeat(40), "launch_unprepared", "event-30", [
      "Command failed: herdr worktree create --cwd /home/me/work/deadloop --path /home/me/work/deadloop/.worktrees/agent-issue-24 --json",
    ]);
    expect(body).not.toContain("/home/me");
  });

  it("names the omission instead of the local path", () => {
    const body = recoveryComment(24, "a".repeat(40), "launch_unprepared", "event-30", [
      "worktree create failed because /srv/deadloop/state/attempt.json is unusable",
    ]);
    expect(body).toContain("[internal path omitted]");
  });

  it("does not repeat the explanation when the same failure is reprocessed", async () => {
    const comments: string[] = [];
    const failure = "worktree agent/issue-42 does not resolve to the recorded canonical checkout";
    const events = [{ id: "block-1", event: "labeled", created_at: "2026-07-20T10:02:00Z", label: { name: "agent:blocked" }, actor: { login: "deadloop-bot" } }];
    await applyPrWorkAuthorityReconciliation(
      { ...missingJournal, launchFailures: [failure] },
      {
        automationLogin: "deadloop-bot",
        listTimelineEvents: () => events,
        listComments: () => [{ author: { login: "deadloop-bot" }, body: recoveryComment(24, "a".repeat(40), "launch_unprepared", "block-1", [failure]) }],
        replaceLabels: () => {},
        comment: (body: string) => { comments.push(body); },
      },
    );
    expect(comments).toHaveLength(0);
  });

  it("leaves no request behind for the loop to retry automatically", () => {
    const decision = reconcilePrWorkAuthority({
      ...missingJournal,
      pr: { ...missingJournal.pr, labels: [...missingJournal.pr.labels, "agent:review"] },
      launchFailures: ["worktree agent/issue-42 does not resolve to the recorded canonical checkout"],
    });
    expect(decision.labels).toEqual(["agent:blocked"]);
  });

  it("keeps a request added after the block queued for the next launch", () => {
    const events = [
      { id: "31", event: "labeled", created_at: "2026-07-20T10:02:00Z", label: { name: "agent:blocked" }, actor: { login: "deadloop-bot" } },
      { id: "32", event: "labeled", created_at: "2026-07-20T10:05:00Z", label: { name: "agent:review" }, actor: { login: "yasuhito" } },
    ];
    expect(postBlockRequestIsEligible({ request: events[1], events, blockedLabel: "agent:blocked" })).toBe(true);
  });
});

describe("storage exhaustion stops observed by deadloop itself", () => {
  const absentOwner = {
    ...base,
    runtime: { kind: "owner_absent_owned" },
    pr: { ...base.pr, labels: ["agent:blocked"] },
  };

  it("names storage exhaustion instead of an unknown cause when ENOSPC was observed", () => {
    expect(reconcilePrWorkAuthority({ ...absentOwner, storageExhaustion: true }).reason).toBe("storage_exhaustion");
  });

  it("keeps reporting a reportless termination as the generic owner-absent failure", () => {
    expect(reconcilePrWorkAuthority(absentOwner).reason).toBe("runtime_owner_absent");
  });

  it("keeps a live attempt running even when storage exhaustion was observed earlier", () => {
    expect(reconcilePrWorkAuthority({ ...base, storageExhaustion: true }).action).toBe("keep_active");
  });

  it("leaves no request behind for the loop to retry automatically", () => {
    const decision = reconcilePrWorkAuthority({
      ...absentOwner,
      pr: { ...absentOwner.pr, labels: [...absentOwner.pr.labels, "agent:review"] },
      storageExhaustion: true,
    });
    expect(decision.labels).toEqual(["agent:blocked"]);
  });

  it("tells the operator to free capacity before adding a new request", () => {
    const body = recoveryComment(24, "a".repeat(40), "storage_exhaustion", "event-30");
    expect(body).toContain("free up storage on the machine running deadloop");
  });

  it("names the recovery step of adding a new Agent request", () => {
    const body = recoveryComment(24, "a".repeat(40), "storage_exhaustion", "event-30");
    expect(body).toContain("add a new Agent request once storage is available");
  });

  it("posts exactly one idempotent comment when the stop blocks", async () => {
    const comments: string[] = [];
    const events = [{ id: "block-1", event: "labeled", created_at: "2026-07-20T10:02:00Z", label: { name: "agent:blocked" }, actor: { login: "deadloop-bot" } }];
    const operations = (posted: string[]) => ({
      automationLogin: "deadloop-bot",
      listTimelineEvents: () => events,
      listComments: () => posted.map((body) => ({ author: { login: "deadloop-bot" }, body })),
      replaceLabels: () => {},
      comment: (body: string) => { posted.push(body); },
      closeOwnedWorkspace: () => true,
    });
    await applyPrWorkAuthorityReconciliation({ ...absentOwner, storageExhaustion: true }, operations(comments));
    await applyPrWorkAuthorityReconciliation({ ...absentOwner, storageExhaustion: true }, operations(comments));
    expect(comments).toHaveLength(1);
  });

  it("adds free-capacity guidance to launch failures that name ENOSPC", () => {
    const body = recoveryComment(24, "a".repeat(40), "launch_unprepared", "event-30", [
      "worktree create failed with EDQUOT: disk quota exceeded",
    ]);
    expect(body).toContain("the host ran out of storage");
  });
});

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
