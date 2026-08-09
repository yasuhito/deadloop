import { describe, expect, it } from "vitest";

const {
  activeReviewRequest,
  parseGithubRestDate,
  renderReviewClaimComment,
  selectReviewClaimWinner,
  validateActiveReviewClaim,
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

  it("uses the authenticated REST Date header as server time", () => {
    expect(parseGithubRestDate("HTTP/2 200\r\ndate: Mon, 20 Jul 2026 10:03:00 GMT\r\n", new Date("2026-07-20T10:02:00Z"))?.toISOString()).toBe("2026-07-20T10:03:00.000Z");
  });

  it("rejects a missing REST Date header", () => {
    expect(parseGithubRestDate("HTTP/2 200\r\n", new Date("2026-07-20T10:02:00Z"))).toBeNull();
  });

  it("rejects a malformed REST Date header", () => {
    expect(parseGithubRestDate("date: not-a-date", new Date("2026-07-20T10:02:00Z"))).toBeNull();
  });

  it("rejects REST Date evidence older than the protected observation", () => {
    expect(parseGithubRestDate("date: Mon, 20 Jul 2026 10:01:00 GMT", new Date("2026-07-20T10:02:00Z"))).toBeNull();
  });

  it("expires a claim at the exact authority boundary", () => {
    expect(selectReviewClaimWinner([claim()], binding, ["deadloop-a"], new Date("2026-07-20T11:01:00Z"), 3600)).toBeNull();
  });

  it("rejects later GitHub effects after the active claim is revoked", () => {
    const contract = {
      binding,
      commentId: "101",
      authorizedLogins: ["deadloop-a"],
      authoritySeconds: 3600,
      reviewLabel: "agent:review",
      reviewingLabel: "agent:reviewing",
      inProgressLabel: "agent:in-progress",
      blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:blocked" }] };
    const headers = "date: Mon, 20 Jul 2026 10:03:00 GMT";
    expect(validateActiveReviewClaim(pr, [request], [claim()], headers, contract)).toBe(false);
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
