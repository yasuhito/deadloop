import { describe, expect, it } from "vitest";

const {
  applyPrWorkAuthorityReconciliation,
  parseRecoveryMarker,
  postBlockRequestIsEligible,
  reconcilePrWorkAuthority,
  recoveryComment,
} = require("../src/pr-work-authority-reconciliation.cts");

const HEAD = "a".repeat(40);
const base = {
  pr: { number: 24, headRefOid: HEAD, labels: ["agent:in-progress", "customer:keep"] },
  runtime: { kind: "stopped" },
  requestLabels: ["agent:update-branch", "agent:implement", "agent:review"],
  inProgressLabel: "agent:in-progress",
  blockedLabel: "agent:blocked",
  restoreRequestLabel: "agent:review",
};

describe("one-axis reconciliation of stopped attempts", () => {
  it("keeps an attempt active when the runtime reports it running", () => {
    expect(reconcilePrWorkAuthority({ ...base, runtime: { kind: "running" } }).action).toBe("keep_active");
  });

  it("returns a stopped attempt to its request state", () => {
    expect(reconcilePrWorkAuthority(base).action).toBe("restore_request");
  });

  it("restores the request label the attempt consumed", () => {
    expect(reconcilePrWorkAuthority(base).labels).toContain("agent:review");
  });

  it("keeps a request queued while the attempt ran", () => {
    const decision = reconcilePrWorkAuthority({
      ...base,
      pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] },
      restoreRequestLabel: "agent:implement",
    });
    expect(decision.labels).toContain("agent:review");
  });

  it("drops the active attempt state when restoring the request state", () => {
    const decision = reconcilePrWorkAuthority(base);
    expect(decision.labels).not.toContain("agent:in-progress");
  });

  it("closes the stopped workspace as part of returning to the request state", () => {
    expect(reconcilePrWorkAuthority(base).cleanup).toBe("close_stopped_workspace");
  });
});

describe("blocks whose reasons name an operator action", () => {
  it("blocks when the runtime cannot describe the attempt", () => {
    expect(reconcilePrWorkAuthority({ ...base, runtime: { kind: "unobservable" } })).toMatchObject({
      action: "block", reason: "runtime_unobservable",
    });
  });

  it("keeps the workspace of an attempt the runtime cannot describe", () => {
    expect(reconcilePrWorkAuthority({ ...base, runtime: { kind: "unobservable" } }).cleanup).toBe("preserve_workspace");
  });

  it("blocks a proven completion whose handoff was refused with its own reason", () => {
    const decision = reconcilePrWorkAuthority({ ...base, completion: { kind: "handoff_refused" } });
    expect(decision.reason).toBe("completion_handoff_refused");
  });

  it("explains a refused handoff without blaming a vanished owner", () => {
    expect(recoveryComment(24, HEAD, "completion_handoff_refused", "event-30")).toContain("completion report could not be handed over");
  });

  it("blocks the request cycle when launches keep failing before any agent starts", () => {
    const decision = reconcilePrWorkAuthority({
      ...base,
      launchFailures: ["worktree agent/issue-42 does not resolve to the recorded canonical checkout"],
    });
    expect(decision.reason).toBe("launch_unprepared");
  });

  it("names the actual failure in the blocked explanation", () => {
    const body = recoveryComment(24, HEAD, "launch_unprepared", "event-30", [
      "worktree agent/issue-42 does not resolve to the recorded canonical checkout",
    ]);
    expect(body).toContain("does not resolve to the recorded canonical checkout");
  });

  it("does not block a request event newer than every recorded launch failure", () => {
    const decision = reconcilePrWorkAuthority({
      ...base,
      launchFailures: ["worktree agent/issue-42 already exists before create"],
      newerRequestThanFailure: true,
    });
    expect(decision.action).toBe("restore_request");
  });

  it("restores the request when no journal is left and a newer request outranks the failures", () => {
    const decision = reconcilePrWorkAuthority({
      ...base,
      runtime: { kind: "absent" },
      launchFailures: ["worktree agent/issue-42 already exists before create"],
      newerRequestThanFailure: true,
    });
    expect(decision.action).toBe("restore_request");
  });

  it("still blocks an unobservable attempt that a newer request cannot outrank", () => {
    const decision = reconcilePrWorkAuthority({
      ...base,
      runtime: { kind: "unobservable" },
      launchFailures: ["worktree agent/issue-42 already exists before create"],
      newerRequestThanFailure: true,
    });
    expect({ action: decision.action, reason: decision.reason }).toEqual({ action: "block", reason: "runtime_unobservable" });
  });

  it("fingersprints the failure set so an unchanged failure set explains once", () => {
    const failures = ["worktree agent/issue-42 already exists before create"];
    const first = parseRecoveryMarker(recoveryComment(24, HEAD, "launch_unprepared", "block-1", failures));
    const second = parseRecoveryMarker(recoveryComment(24, HEAD, "launch_unprepared", "block-2", failures));
    expect({ present: Boolean(first?.fingerprint), repeated: second?.fingerprint === first?.fingerprint })
      .toEqual({ present: true, repeated: true });
  });

  it("does not repeat the failure explanation while the failure set is unchanged", async () => {
    const comments: string[] = [];
    const failure = "worktree agent/issue-42 already exists before create";
    const operations = (posted: string[]) => ({
      automationLogin: "deadloop-bot",
      listTimelineEvents: () => [{ id: "block-1", event: "labeled", created_at: "2026-07-20T10:02:00Z", label: { name: "agent:blocked" }, actor: { login: "deadloop-bot" } }],
      listComments: () => posted.map((body) => ({ author: { login: "deadloop-bot" }, body })),
      replaceLabels: () => {},
      comment: (body: string) => { posted.push(body); },
    });
    const blockedInput = { ...base, pr: { ...base.pr, labels: ["customer:keep", "agent:blocked"] }, launchFailures: [failure] };
    await applyPrWorkAuthorityReconciliation(blockedInput, operations(comments));
    // A second block with the same failure set reaches a different cutoff event, and still must
    // not post the same explanation again.
    await applyPrWorkAuthorityReconciliation(blockedInput, operations([
      recoveryComment(24, HEAD, "launch_unprepared", "older-cutoff", [failure]),
    ]));
    expect(comments).toHaveLength(1);
  });

  it("counts every failed request cycle in the blocked explanation", () => {
    const body = recoveryComment(24, HEAD, "launch_unprepared", "event-30", [
      "checkout alignment stopped: cannot fast-forward", "checkout alignment stopped: cannot fast-forward",
    ]);
    expect(body).toContain("2 Agent request(s) failed to launch");
  });

  it("tells the operator what to do about the failing shape", () => {
    const body = recoveryComment(24, HEAD, "launch_unprepared", "event-30", [
      "worktree agent/issue-42 already has an open attempt workspace",
    ]);
    expect(body).toContain("resolve the named attempt");
  });

  it("keeps local paths out of the published failure explanation", () => {
    const body = recoveryComment(24, HEAD, "launch_unprepared", "event-30", [
      "Command failed: herdr worktree create --cwd /home/me/work/deadloop --path /home/me/work/deadloop/.worktrees/agent-issue-24 --json",
    ]);
    expect(body).not.toContain("/home/me");
  });

  it("names the omission instead of the local path", () => {
    const body = recoveryComment(24, HEAD, "launch_unprepared", "event-30", [
      "worktree create failed because /srv/deadloop/state/attempt.json is unusable",
    ]);
    expect(body).toContain("[internal path omitted]");
  });

  it("names storage exhaustion instead of an unknown cause when ENOSPC was observed", () => {
    expect(reconcilePrWorkAuthority({ ...base, storageExhaustion: true }).reason).toBe("storage_exhaustion");
  });

  it("tells the operator to free capacity before adding a new request", () => {
    const body = recoveryComment(24, HEAD, "storage_exhaustion", "event-30");
    expect(body).toContain("free up storage on the machine running deadloop");
  });

  it("adds free-capacity guidance to launch failures that name ENOSPC", () => {
    const body = recoveryComment(24, HEAD, "launch_unprepared", "event-30", [
      "worktree create failed with EDQUOT: disk quota exceeded",
    ]);
    expect(body).toContain("the host ran out of storage");
  });

  it("removes every request when blocking, so the loop cannot retry automatically", () => {
    const decision = reconcilePrWorkAuthority({
      ...base,
      pr: { ...base.pr, labels: [...base.pr.labels, "agent:review"] },
      storageExhaustion: true,
    });
    expect(decision.labels).toEqual(["customer:keep", "agent:blocked"]);
  });
});

describe("block application", () => {
  const blockEvents = [{ id: "block-1", event: "labeled", created_at: "2026-07-20T10:02:00Z", label: { name: "agent:blocked" }, actor: { login: "deadloop-bot" } }];
  // Labels already show the blocked state, so the cutoff comes from the single timeline read.
  const blocked = { ...base, pr: { ...base.pr, labels: ["customer:keep", "agent:blocked"] } };

  it("posts the launch failure evidence when reconciliation blocks", async () => {
    const comments: string[] = [];
    await applyPrWorkAuthorityReconciliation(
      { ...blocked, launchFailures: ["worktree agent/issue-42 does not resolve to the recorded canonical checkout"] },
      {
        automationLogin: "deadloop-bot",
        listTimelineEvents: () => blockEvents,
        listComments: () => [],
        replaceLabels: () => {},
        comment: (body: string) => { comments.push(body); },
      },
    );
    expect(comments.some((body) => body.includes("does not resolve to the recorded canonical checkout"))).toBe(true);
  });

  it("does not repeat the explanation when the same failure is reprocessed", async () => {
    const comments: string[] = [];
    const failure = "worktree agent/issue-42 does not resolve to the recorded canonical checkout";
    await applyPrWorkAuthorityReconciliation(
      { ...blocked, launchFailures: [failure] },
      {
        automationLogin: "deadloop-bot",
        listTimelineEvents: () => blockEvents,
        listComments: () => [{ author: { login: "deadloop-bot" }, body: recoveryComment(24, HEAD, "launch_unprepared", "block-1", [failure]) }],
        replaceLabels: () => {},
        comment: (body: string) => { comments.push(body); },
      },
    );
    expect(comments).toHaveLength(0);
  });

  it("posts exactly one idempotent comment when the stop blocks", async () => {
    const comments: string[] = [];
    const operations = (posted: string[]) => ({
      automationLogin: "deadloop-bot",
      listTimelineEvents: () => blockEvents,
      listComments: () => posted.map((body) => ({ author: { login: "deadloop-bot" }, body })),
      replaceLabels: () => {},
      comment: (body: string) => { posted.push(body); },
      closeStoppedWorkspace: () => true,
    });
    const blockedDecision = { ...blocked, storageExhaustion: true };
    await applyPrWorkAuthorityReconciliation(blockedDecision, operations(comments));
    await applyPrWorkAuthorityReconciliation(blockedDecision, operations(comments));
    expect(comments).toHaveLength(1);
  });

  it("posts a blocked explanation for an attempt the runtime cannot describe", async () => {
    const comments: string[] = [];
    let timelineReads = 0;
    await applyPrWorkAuthorityReconciliation(
      { ...base, runtime: { kind: "unobservable" } },
      {
        automationLogin: "deadloop-bot",
        listTimelineEvents: () => timelineReads++ === 0 ? [] : blockEvents,
        listComments: () => [],
        replaceLabels: () => {},
        comment: (body: string) => { comments.push(body); },
      },
    );
    expect(comments).toHaveLength(1);
  });

  it("moves labels without invalidating requests when restoring the request state", async () => {
    const invalidations: boolean[] = [];
    await applyPrWorkAuthorityReconciliation(base, {
      automationLogin: "deadloop-bot",
      listTimelineEvents: () => [],
      listComments: () => [],
      replaceLabels: (_labels: string[], options: { invalidatesRequests: boolean }) => { invalidations.push(options.invalidatesRequests); },
      closeStoppedWorkspace: () => true,
    });
    expect(invalidations).toEqual([false]);
  });
});

describe("requests queued after a block", () => {
  const events = [
    { id: "31", event: "labeled", created_at: "2026-07-20T10:02:00Z", label: { name: "agent:blocked" }, actor: { login: "deadloop-bot" } },
    { id: "32", event: "labeled", created_at: "2026-07-20T10:05:00Z", label: { name: "agent:review" }, actor: { login: "yasuhito" } },
  ];

  it("keeps a request added after the block queued for the next launch", () => {
    expect(postBlockRequestIsEligible({ request: events[1], events, blockedLabel: "agent:blocked" })).toBe(true);
  });
});

describe("published stop codes name one operation", () => {
  it("publishes free_storage for a launch failure shaped like storage exhaustion", () => {
    const body = recoveryComment(24, HEAD, "launch_unprepared", "event-30", [
      "worktree create failed with EDQUOT: disk quota exceeded",
    ]);
    expect(parseRecoveryMarker(body)?.reason).toBe("free_storage");
  });

  it("publishes fix_environment for a launch failure shaped like a diverged checkout", () => {
    const body = recoveryComment(24, HEAD, "launch_unprepared", "event-30", [
      "worktree agent/issue-42 does not resolve to the recorded canonical checkout",
    ]);
    expect(parseRecoveryMarker(body)?.reason).toBe("fix_environment");
  });

  it("publishes add_request for a stop the runtime could not describe", () => {
    const body = recoveryComment(24, HEAD, "runtime_unobservable", "event-30");
    expect(parseRecoveryMarker(body)?.reason).toBe("add_request");
  });
});
