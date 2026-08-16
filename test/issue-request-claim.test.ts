import { describe, expect, it } from "vitest";

const {
  activeIssueRequest,
  claimedIssueRequestGenerationIsCurrent,
  compareIssueEvents,
  issueRequestRevision,
  observeIssueRequestLabels,
  parseIssueClaim,
  renderIssueClaimComment,
  selectIssueClaimWinner,
} = require("../extensions/deadloop/automations/issue-request-claim.ts");

const binding = {
  repositoryId: "R_1", repository: "owner/repo", targetNumber: 42, requestEventId: "event-2",
  role: "explorer", revision: "2026-07-08T00:00:00Z", owner: "host-a",
  authority: { durationSeconds: 300 },
  activeState: { managedLabels: ["agent:explore", "agent:implement", "agent:in-progress", "agent:blocked"], requestLabel: "agent:explore", requiredLabels: ["agent:in-progress"] },
};

function comment(id: number, ownerBinding = binding, createdAt = "2026-07-08T00:00:00Z") {
  return { id, createdAt, updatedAt: createdAt, author: { login: "bot" }, body: renderIssueClaimComment(ownerBinding) };
}

describe("Issue request claim", () => {
  it("selects the latest request generation", () => {
    expect(activeIssueRequest([
      { id: "event-1", event: "labeled", created_at: "2026-07-07T00:00:00Z", label: { name: "agent:explore" } },
      { id: "event-2", event: "labeled", created_at: "2026-07-08T00:00:00Z", label: { name: "agent:explore" } },
    ], "agent:explore").id).toBe("event-2");
  });

  it("binds the claim revision to the immutable request event", () => {
    expect(issueRequestRevision({ created_at: "2026-07-08T00:00:00Z" })).toBe("2026-07-08T00:00:00Z");
  });

  it("observes a request added between the event and label reads", () => {
    const labels: Array<{ name: string }> = [];
    const observation = observeIssueRequestLabels({
      listIssueTimelineEvents: () => { labels.push({ name: "agent:implement" }); return []; },
      listIssueLabels: () => labels,
    }, "owner/repo", 42);
    expect(observation.labels.has("agent:implement")).toBe(true);
  });

  it("rejects a newer claimed request generation before label replacement", () => {
    expect(claimedIssueRequestGenerationIsCurrent({ events: [
      { id: "event-3", event: "labeled", created_at: "2026-07-09T00:00:00Z", label: { name: "agent:explore" } },
    ], labels: new Set(["agent:explore"]) }, "agent:explore", "event-2")).toBe(false);
  });

  it("rejects a claimed request removed after its event was observed", () => {
    expect(claimedIssueRequestGenerationIsCurrent({ events: [
      { id: "event-2", event: "labeled", created_at: "2026-07-08T00:00:00Z", label: { name: "agent:explore" } },
    ], labels: new Set() }, "agent:explore", "event-2")).toBe(false);
  });

  it("orders a same-second retry after the block by stable event ID", () => {
    expect(compareIssueEvents(
      { id: "101", created_at: "2026-07-08T00:00:00Z" },
      { id: "100", created_at: "2026-07-08T00:00:00Z" },
    )).toBeGreaterThan(0);
  });

  it("round-trips the issue claim marker", () => {
    expect(parseIssueClaim(renderIssueClaimComment(binding)).requestEventId).toBe("event-2");
  });

  it("selects the earliest authorized remote claim from the local binding", () => {
    const earlier = comment(1, { ...binding, owner: "host-b" }, "2026-07-08T00:00:01Z");
    const own = comment(2, binding, "2026-07-08T00:00:02Z");
    expect(selectIssueClaimWinner([own, earlier], binding, ["bot"], new Date("2026-07-08T00:00:03Z")).id).toBe(1);
  });

  it("rejects an expired claim at the exact boundary", () => {
    expect(selectIssueClaimWinner([comment(1)], binding, ["bot"], new Date("2026-07-08T00:05:00Z"))).toBeNull();
  });
});
