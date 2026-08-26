import { describe, expect, it } from "vitest";

const {
  IncompletePrHistoryObservationError,
  advancePrHistoryAfterDeterministicComment,
  comparePrHistoryObservations,
  observePrHistory,
} = require("../src/pr-review-history.cts");

function apiPages(items: unknown[]) {
  return [items];
}

function fixtureRunner(overrides: Record<string, unknown> = {}) {
  const pull = {
    number: 12,
    state: "open",
    head: { ref: "feature", sha: "a".repeat(40) },
    base: { ref: "main", sha: "b".repeat(40) },
  };
  const collections: Record<string, unknown> = {
    commits: [{ data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: "a".repeat(40) } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }],
    "issues-comments": apiPages([{ id: 1, body: "comment", user: { login: "alice" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]),
    reviews: apiPages([{ id: 2, body: "review", user: { login: "bob" }, state: "COMMENTED", commit_id: "a".repeat(40), submitted_at: "2026-01-01T00:00:00Z" }]),
    "review-comments": apiPages([{ id: 3, body: "inline", user: { login: "carol" }, commit_id: "a".repeat(40), path: "src/a.ts", line: 4, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }]),
  };
  let pullReads = 0;
  return {
    runJson(args: string[]) {
      const endpoint = args.find((argument) => argument.startsWith("repos/")) || "";
      if (args.includes("graphql")) return overrides.commits ?? collections.commits;
      if (endpoint === "repos/owner/repo/pulls/12") {
        pullReads += 1;
        const snapshot = { ...pull, ...overrides.pull as object };
        return pullReads > 1 && overrides.confirmPull ? { ...snapshot, ...overrides.confirmPull as object } : snapshot;
      }
      if (endpoint.includes("/issues/12/comments")) return overrides.comments ?? collections["issues-comments"];
      if (endpoint.includes("/reviews")) return overrides.reviews ?? collections.reviews;
      if (endpoint.includes("/comments")) return overrides.inlineComments ?? collections["review-comments"];
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
    runText() {
      return String(overrides.diff ?? "diff --git a/src/a.ts b/src/a.ts\n");
    },
  };
}

describe("PR review history observation", () => {
  it("permits an unchanged history revision", () => {
    const first = observePrHistory("owner/repo", 12, fixtureRunner());
    const second = observePrHistory("owner/repo", 12, fixtureRunner());
    expect(comparePrHistoryObservations(first, second).kind).toBe("unchanged");
  });

  it("makes an added conversation comment stale", () => {
    const first = observePrHistory("owner/repo", 12, fixtureRunner());
    const second = observePrHistory("owner/repo", 12, fixtureRunner({ comments: apiPages([
      { id: 1, body: "comment", user: { login: "alice" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { id: 4, body: "new", user: { login: "dana" }, created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
    ]) }));
    expect(comparePrHistoryObservations(first, second).changed).toContain("conversationComments");
  });

  it("makes an edited conversation comment stale", () => {
    const first = observePrHistory("owner/repo", 12, fixtureRunner());
    const second = observePrHistory("owner/repo", 12, fixtureRunner({ comments: apiPages([
      { id: 1, body: "edited", user: { login: "alice" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
    ]) }));
    expect(comparePrHistoryObservations(first, second).changed).toContain("conversationComments");
  });

  it("makes a deleted conversation comment stale", () => {
    const first = observePrHistory("owner/repo", 12, fixtureRunner());
    const second = observePrHistory("owner/repo", 12, fixtureRunner({ comments: apiPages([]) }));
    expect(comparePrHistoryObservations(first, second).changed).toContain("conversationComments");
  });

  it("makes an inline review comment stale", () => {
    const first = observePrHistory("owner/repo", 12, fixtureRunner());
    const second = observePrHistory("owner/repo", 12, fixtureRunner({ inlineComments: apiPages([]) }));
    expect(comparePrHistoryObservations(first, second).changed).toContain("inlineReviewComments");
  });

  it("makes an exact diff change stale", () => {
    const first = observePrHistory("owner/repo", 12, fixtureRunner());
    const second = observePrHistory("owner/repo", 12, fixtureRunner({ diff: "different diff\n" }));
    expect(comparePrHistoryObservations(first, second).changed).toContain("diff");
  });

  it("accepts only one deterministic conversation comment when advancing a revision", () => {
    const first = observePrHistory("owner/repo", 12, fixtureRunner());
    const second = observePrHistory("owner/repo", 12, fixtureRunner({ comments: apiPages([
      { id: 1, body: "comment", user: { login: "alice" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { id: 4, body: "persisted result", user: { login: "bot" }, created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
    ]) }));
    expect(advancePrHistoryAfterDeterministicComment(first, second, {
      id: "4", author: "bot", body: "persisted result",
    }).kind).toBe("accepted");
  });

  it("rejects an unrelated comment while advancing a revision", () => {
    const first = observePrHistory("owner/repo", 12, fixtureRunner());
    const second = observePrHistory("owner/repo", 12, fixtureRunner({ comments: apiPages([
      { id: 1, body: "comment", user: { login: "alice" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { id: 4, body: "persisted result", user: { login: "bot" }, created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
      { id: 5, body: "race", user: { login: "mallory" }, created_at: "2026-01-02T00:00:01Z", updated_at: "2026-01-02T00:00:01Z" },
    ]) }));
    expect(advancePrHistoryAfterDeterministicComment(first, second, {
      id: "4", author: "bot", body: "persisted result",
    }).kind).toBe("stale");
  });

  it("rejects a same-body replacement with a foreign identity", () => {
    const first = observePrHistory("owner/repo", 12, fixtureRunner());
    const second = observePrHistory("owner/repo", 12, fixtureRunner({ comments: apiPages([
      { id: 1, body: "comment", user: { login: "alice" }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
      { id: 9, body: "persisted result", user: { login: "mallory" }, created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" },
    ]) }));

    expect(advancePrHistoryAfterDeterministicComment(first, second, {
      id: "4", author: "bot", body: "persisted result",
    }).kind).toBe("stale");
  });

  it("fails technically when a paginated collection is incomplete", () => {
    expect(() => observePrHistory("owner/repo", 12, fixtureRunner({ reviews: { items: [] } }))).toThrow(IncompletePrHistoryObservationError);
  });

  it("rejects a snapshot when the PR head changes during observation", () => {
    expect(() => observePrHistory("owner/repo", 12, fixtureRunner({
      confirmPull: { head: { ref: "feature", sha: "c".repeat(40) } },
    }))).toThrow("PR head or base changed while history was being observed");
  });

  it("rejects a snapshot when the PR base changes during observation", () => {
    expect(() => observePrHistory("owner/repo", 12, fixtureRunner({
      confirmPull: { base: { ref: "main", sha: "d".repeat(40) } },
    }))).toThrow("PR head or base changed while history was being observed");
  });

  it("rejects a snapshot when the PR state changes during observation", () => {
    expect(() => observePrHistory("owner/repo", 12, fixtureRunner({
      confirmPull: { state: "closed" },
    }))).toThrow("PR head or base changed while history was being observed");
  });

  it("rejects a snapshot whose commit sequence does not end at the observed head", () => {
    expect(() => observePrHistory("owner/repo", 12, fixtureRunner({
      commits: [{ data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: "e".repeat(40) } }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }],
    }))).toThrow("commit sequence does not end at the observed PR head");
  });

  it("rejects a snapshot whose observed PR number differs from the request", () => {
    expect(() => observePrHistory("owner/repo", 12, fixtureRunner({
      pull: { number: 13 },
    }))).toThrow("observed PR number does not match the requested PR");
  });
});
