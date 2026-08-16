import { describe, expect, it } from "vitest";

const {
  closeExplorationWorkspace,
  hasExplorationPersistenceProof,
  removeExplorationWorktree,
  trustedExplorationResultComment,
} = require("../extensions/deadloop/automations/complete-issue-exploration.ts");
const { racedIssueRequestLabels } = require("../extensions/deadloop/automations/issue-request-claim.ts");

const claim = {
  binding: { requestEventId: "event-2" },
  requestLabel: "agent:explore",
  authorizedLogins: ["deadloop-bot"],
};
const body = "exploration result\n\n<!-- deadloop:issue-exploration-result request=event-2 -->";
const event = { id: "event-2", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:explore" } };
const consumedEvent = { id: "event-3", event: "unlabeled", created_at: "2026-08-16T00:00:01Z", label: { name: "agent:explore" } };
const record = {
  workspaceId: "workspace-1",
  worktreePath: "/worktrees/explore-42",
  branch: "agent/explore-42",
  agentName: "explorer-42",
};

function resultComment(login: string) {
  return {
    id: "comment-1",
    author: { login },
    body,
    createdAt: "2026-08-16T00:01:00Z",
    updatedAt: "2026-08-16T00:01:00Z",
  };
}

describe("Issue exploration completion", () => {
  it("does not trust a copied result marker from another commenter", () => {
    expect(trustedExplorationResultComment([resultComment("other-user")], claim, body)).toBeNull();
  });

  it("trusts the exact unedited result from an authorized Automation host", () => {
    expect(trustedExplorationResultComment([resultComment("deadloop-bot")], claim, body)?.id).toBe("comment-1");
  });

  it("recognizes GitHub persistence after the success label mutation", () => {
    expect(hasExplorationPersistenceProof(
      { labels: new Set(["ready-for-agent"]), events: [event, consumedEvent], comments: [resultComment("deadloop-bot")] },
      claim,
      body,
      false,
      { inProgress: "agent:in-progress", blocked: "agent:blocked" },
    )).toBe(true);
  });

  it("does not accept success after a raced implementation request was erased", () => {
    expect(hasExplorationPersistenceProof(
      {
        labels: new Set(["ready-for-agent"]),
        events: [event, consumedEvent, { id: "implement-2", event: "labeled", created_at: "2026-08-16T00:03:00Z", label: { name: "agent:implement" } }],
        comments: [resultComment("deadloop-bot")],
      },
      claim,
      body,
      false,
      { inProgress: "agent:in-progress", blocked: "agent:blocked", requests: ["agent:explore", "agent:implement"] },
    )).toBe(false);
  });

  it("does not accept a result while the exploration claim is still active", () => {
    expect(hasExplorationPersistenceProof(
      { labels: new Set(["agent:in-progress"]), events: [event], comments: [resultComment("deadloop-bot")] },
      claim,
      body,
      false,
      { inProgress: "agent:in-progress", blocked: "agent:blocked" },
    )).toBe(false);
  });

  it("rejects a failed result that preserves an implementation request from before the block", () => {
    expect(hasExplorationPersistenceProof(
      {
        labels: new Set(["agent:blocked", "agent:implement"]),
        events: [event, consumedEvent,
          { id: "implement-1", event: "labeled", created_at: "2026-08-16T00:00:30Z", label: { name: "agent:implement" } },
          { id: "block-1", event: "labeled", created_at: "2026-08-16T00:02:00Z", label: { name: "agent:blocked" } }],
        comments: [resultComment("deadloop-bot")],
      },
      claim,
      body,
      true,
      { inProgress: "agent:in-progress", blocked: "agent:blocked", requests: ["agent:explore", "agent:implement"] },
    )).toBe(false);
  });

  it("accepts a post-block request ordered later in the same second", () => {
    expect(hasExplorationPersistenceProof(
      {
        labels: new Set(["agent:blocked", "agent:implement"]),
        events: [event, consumedEvent,
          { id: "100", event: "labeled", created_at: "2026-08-16T00:02:00Z", label: { name: "agent:blocked" } },
          { id: "101", event: "labeled", created_at: "2026-08-16T00:02:00Z", label: { name: "agent:implement" } }],
        comments: [resultComment("deadloop-bot")],
      },
      claim,
      body,
      true,
      { inProgress: "agent:in-progress", blocked: "agent:blocked", requests: ["agent:explore", "agent:implement"] },
    )).toBe(true);
  });

  it("preserves a new request generation that races with completion", () => {
    expect(racedIssueRequestLabels(
      new Map([["agent:implement", "implement-1"]]),
      [{ id: "implement-2", event: "labeled", created_at: "2026-08-16T00:03:00Z", label: { name: "agent:implement" } }],
    )).toEqual(["agent:implement"]);
  });

  it("accepts retry after the exact exploration workspace is already absent", () => {
    let closeCalls = 0;
    closeExplorationWorkspace(record, { listWorkspaces: () => [], listAgents: () => [], closeWorkspace: () => { closeCalls += 1; } });
    expect(closeCalls).toBe(0);
  });

  it("accepts retry after the exact exploration worktree is already absent", () => {
    let removeCalls = 0;
    removeExplorationWorktree(record, "/repo", { listWorktrees: () => [], removeWorktree: () => { removeCalls += 1; } });
    expect(removeCalls).toBe(0);
  });
});
