import { describe, expect, it } from "vitest";

const {
  activeReviewRequest,
  parseGithubRestDate,
  parsePaginatedGithubJson,
  renderReviewClaimComment,
  selectReviewClaimWinner,
  validateActiveReviewClaim,
  validateRepairAuthorityTransition,
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
const liveTarget = { repositoryId: "R_123", repository: "owner/repo", targetNumber: 24 };

function claim(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    createdAt: "2026-07-20T10:01:00Z",
    updatedAt: "2026-07-20T10:01:00Z",
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
    expect(selectReviewClaimWinner([claim({ id: 102, createdAt: "2026-07-20T10:02:00Z", updatedAt: "2026-07-20T10:02:00Z" }), claim()], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)?.id).toBe(101);
  });

  it("rejects a malformed claim", () => {
    expect(selectReviewClaimWinner([claim({ body: "<!-- deadloop:review-claim nope -->" })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("rejects a claim from an unauthorized identity", () => {
    expect(selectReviewClaimWinner([claim({ author: { login: "stranger" } })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("rejects a claim without GitHub edit evidence", () => {
    const missing = claim();
    delete missing.updatedAt;
    expect(selectReviewClaimWinner([missing], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("rejects a claim with malformed GitHub edit evidence", () => {
    expect(selectReviewClaimWinner([claim({ updatedAt: "not-a-time" })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("rejects an old comment edited to another request generation", () => {
    const edited = { ...binding, requestEventId: "event-23" };
    expect(selectReviewClaimWinner([claim({ createdAt: "2026-07-20T09:00:00Z", body: renderReviewClaimComment(edited) })], edited, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 7200)).toBeNull();
  });

  it("rejects an old comment edited to another head", () => {
    const edited = { ...binding, revision: "b".repeat(40) };
    expect(selectReviewClaimWinner([claim({ createdAt: "2026-07-20T09:00:00Z", body: renderReviewClaimComment(edited) })], edited, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 7200)).toBeNull();
  });

  it("rejects an old comment edited to another owner", () => {
    const edited = { ...binding, owner: "host-b" };
    expect(selectReviewClaimWinner([claim({ createdAt: "2026-07-20T09:00:00Z", body: renderReviewClaimComment(edited) })], edited, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 7200)).toBeNull();
  });

  it("selects an unedited claim observed on a later page", () => {
    const editedOldClaim = claim({ id: 100, createdAt: "2026-07-20T09:00:00Z" });
    const comments = parsePaginatedGithubJson(JSON.stringify([[editedOldClaim], [claim()]]));
    expect(selectReviewClaimWinner(comments, binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 7200)?.id).toBe(101);
  });

  it("rejects a claim for another revision", () => {
    const wrong = { ...binding, revision: "b".repeat(40) };
    expect(selectReviewClaimWinner([claim({ body: renderReviewClaimComment(wrong) })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("rejects a claim for an older request event", () => {
    const old = { ...binding, requestEventId: "event-21" };
    expect(selectReviewClaimWinner([claim({ body: renderReviewClaimComment(old) })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("combines every GitHub REST page before claim authorization", () => {
    expect(parsePaginatedGithubJson(JSON.stringify([[{ id: 1 }], [{ id: 2 }]]))).toEqual([{ id: 1 }, { id: 2 }]);
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

  it("rejects a claim when the live repository ID differs", () => {
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], authoritySeconds: 3600,
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:in-progress" }] };

    expect(validateActiveReviewClaim(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, {
      repositoryId: "R_other", repository: "owner/repo", targetNumber: 24,
    })).toBe(false);
  });

  it("rejects a claim when the live canonical repository name differs", () => {
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], authoritySeconds: 3600,
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:in-progress" }] };

    expect(validateActiveReviewClaim(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, {
      repositoryId: "R_123", repository: "owner/renamed", targetNumber: 24,
    })).toBe(false);
  });

  it("rejects a claim when the live target PR differs", () => {
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], authoritySeconds: 3600,
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:in-progress" }] };

    expect(validateActiveReviewClaim(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, {
      repositoryId: "R_123", repository: "owner/repo", targetNumber: 25,
    })).toBe(false);
  });

  it("rejects legacy review labels without in-progress as active authority", () => {
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], authoritySeconds: 3600,
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:review" }, { name: "agent:reviewing" }] };

    expect(validateActiveReviewClaim(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, liveTarget)).toBe(false);
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
    expect(validateActiveReviewClaim(pr, [request], [claim()], headers, contract, liveTarget)).toBe(false);
  });

  it("rejects an edited winning marker whose owner no longer matches the persisted claim", () => {
    const editedBinding = { ...binding, owner: "host-b" };
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], authoritySeconds: 3600,
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:in-progress" }] };
    const edited = claim({ body: renderReviewClaimComment(editedBinding) });

    expect(validateActiveReviewClaim(pr, [request], [edited], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, liveTarget)).toBe(false);
  });

  it("rejects a repair transition when the live repository ID differs", () => {
    const repairedHead = "b".repeat(40);
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], authoritySeconds: 3600,
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: repairedHead, labels: [{ name: "agent:in-progress" }] };

    expect(validateRepairAuthorityTransition(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, {
      repositoryId: "R_other", repository: "owner/repo", targetNumber: 24,
    }, { originalHeadOid: head, headOid: repairedHead })).toBe(false);
  });

  it("rejects a repair transition when the live canonical repository name differs", () => {
    const repairedHead = "b".repeat(40);
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], authoritySeconds: 3600,
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: repairedHead, labels: [{ name: "agent:in-progress" }] };

    expect(validateRepairAuthorityTransition(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, {
      repositoryId: "R_123", repository: "owner/renamed", targetNumber: 24,
    }, { originalHeadOid: head, headOid: repairedHead })).toBe(false);
  });

  it("rejects a repair transition when the live target PR differs", () => {
    const repairedHead = "b".repeat(40);
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], authoritySeconds: 3600,
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: repairedHead, labels: [{ name: "agent:in-progress" }] };

    expect(validateRepairAuthorityTransition(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, {
      repositoryId: "R_123", repository: "owner/repo", targetNumber: 25,
    }, { originalHeadOid: head, headOid: repairedHead })).toBe(false);
  });

  it("requires an explicit repair transition before an old-head claim can authorize a repaired head", () => {
    const repairedHead = "b".repeat(40);
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], authoritySeconds: 3600,
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: repairedHead, labels: [{ name: "agent:in-progress" }, { name: "agent:reviewing" }] };

    expect(validateRepairAuthorityTransition(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, liveTarget, {
      originalHeadOid: head, headOid: repairedHead,
    })).toBe(true);
  });

  it("rejects an old-head claim as ordinary authority for a repaired head", () => {
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], authoritySeconds: 3600,
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: "b".repeat(40), labels: [{ name: "agent:in-progress" }, { name: "agent:reviewing" }] };

    expect(validateActiveReviewClaim(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, liveTarget)).toBe(false);
  });

  it("does not let marker expiry extend authority", () => {
    const original = renderReviewClaimComment(binding);
    const encoded = original.match(/v1=([A-Za-z0-9_-]+)/)?.[1] || "";
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const extended = Buffer.from(JSON.stringify({ ...payload, expiresAt: "2099-01-01T00:00:00Z" })).toString("base64url");
    const body = original.replace(encoded, extended);
    expect(selectReviewClaimWinner([claim({ body, createdAt: "2026-07-20T08:00:00Z", updatedAt: "2026-07-20T08:00:00Z" })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });
});
