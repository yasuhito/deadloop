import { describe, expect, it } from "vitest";

const {
  activeReviewRequest,
  renderReviewClaimComment,
  selectReviewClaimWinner,
} = require("../extensions/deadloop/automations/pr-review-claim.ts");

const head = "a".repeat(40);
const request = { id: "event-22", event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } };
const binding = {
  repositoryId: "R_123",
  repository: "owner/repo",
  targetNumber: 24,
  requestEventId: "event-22",
  role: "reviewer",
  revision: head,
  owner: "host-a",
};

function claim(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    createdAt: "2026-07-20T10:01:00Z",
    author: { login: "deadloop-a" },
    body: renderReviewClaimComment(binding),
    ...overrides,
  };
}

describe("PR review GitHub claim", () => {
  it("identifies the latest review label event", () => {
    expect(activeReviewRequest([request, { ...request, id: "event-23", created_at: "2026-07-20T10:02:00Z" }], "agent:review")?.id).toBe("event-23");
  });

  it("chooses the earliest valid GitHub claim", () => {
    expect(selectReviewClaimWinner([claim({ id: 102, createdAt: "2026-07-20T10:02:00Z" }), claim()], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)?.id).toBe(101);
  });

  it("rejects a malformed claim", () => {
    expect(selectReviewClaimWinner([claim({ body: "<!-- deadloop:review-claim nope -->" })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("rejects a claim from an unauthorized identity", () => {
    expect(selectReviewClaimWinner([claim({ author: { login: "stranger" } })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("rejects a claim for another revision", () => {
    const wrong = { ...binding, revision: "b".repeat(40) };
    expect(selectReviewClaimWinner([claim({ body: renderReviewClaimComment(wrong) })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("rejects a claim for an older request event", () => {
    const old = { ...binding, requestEventId: "event-21" };
    expect(selectReviewClaimWinner([claim({ body: renderReviewClaimComment(old) })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("does not let marker expiry extend authority", () => {
    const original = renderReviewClaimComment(binding);
    const encoded = original.match(/v1=([A-Za-z0-9_-]+)/)?.[1] || "";
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const extended = Buffer.from(JSON.stringify({ ...payload, expiresAt: "2099-01-01T00:00:00Z" })).toString("base64url");
    const body = original.replace(encoded, extended);
    expect(selectReviewClaimWinner([claim({ body, createdAt: "2026-07-20T08:00:00Z" })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });
});
