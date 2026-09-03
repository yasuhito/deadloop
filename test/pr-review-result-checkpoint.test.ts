import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

const { resolveReviewResultCheckpoint } = require("../extensions/deadloop/automations/pr-review-result-checkpoint.cts");

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const FINGERPRINT = "f".repeat(20);
const ATTEMPT_ID = "reviewer-attempt";
const LOGIN = "deadloop-bot";
const RESULT_MARKER = `<!-- deadloop:review-result head=${HEAD} review=${FINGERPRINT} outcome=approved -->`;
const ATTEMPT_MARKER_BODY = JSON.stringify({ attemptId: ATTEMPT_ID, role: "reviewer" });
const ATTEMPT_MARKER = `<!-- deadloop:attempt-result-v1 data=${Buffer.from(ATTEMPT_MARKER_BODY).toString("base64url")} -->`;
const RESULT_BODY = `## Review result: approved\n\n${RESULT_MARKER}\n${ATTEMPT_MARKER}`;

function diff(value: string) {
  return { sha256: createHash("sha256").update(value).digest("hex"), bytes: Buffer.byteLength(value) };
}

function observation(comments: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}) {
  const history = {
    pullRequest: { number: 243, state: "open", headRef: "agent/issue-243", headSha: HEAD, baseRef: "main", baseSha: BASE },
    commits: [{ sha: HEAD }],
    diff: diff("diff\n"),
    conversationComments: comments,
    submittedReviews: [],
    inlineReviewComments: [],
    ...overrides,
  };
  return {
    schemaVersion: 1,
    repository: "owner/repo",
    pullRequestNumber: 243,
    observedAt: "2026-01-01T00:00:00.000Z",
    revision: createHash("sha256").update(`${JSON.stringify(history)}\n`).digest("hex"),
    history,
    evidence: { exactDiff: "diff\n" },
  };
}

function comment(id: number, body: string, author = LOGIN) {
  return { id: String(id), nodeId: `node-${id}`, author, body, createdAt: "x", updatedAt: "x" };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    original: observation([]),
    live: observation([]),
    attemptId: ATTEMPT_ID,
    expectedHead: HEAD,
    outcome: "approved",
    reviewFingerprint: FINGERPRINT,
    automationLogin: LOGIN,
    liveComments: [],
    ...overrides,
  };
}

function acceptedCheckpoint(resultBody = RESULT_BODY, liveComments?: Array<Record<string, unknown>>) {
  const resultComment = comment(7, resultBody);
  return {
    accepted: observation([resultComment]),
    live: observation([resultComment]),
    liveComments: liveComments ?? [{ id: 7, author: { login: LOGIN }, body: resultBody }],
  };
}

describe("review result checkpoint", () => {
  it("keeps the original history when no accepted history was saved", () => {
    const resolved = resolveReviewResultCheckpoint(input());
    expect(resolved.origin).toBe("original");
  });

  it("keeps the original history when the accepted history file is unreadable", () => {
    const resolved = resolveReviewResultCheckpoint(input({ ...acceptedCheckpoint(), acceptedUnreadable: true }));
    expect(resolved.origin).toBe("original");
  });

  it("adopts the accepted history when the saved result comment proves the one-comment advance", () => {
    const resolved = resolveReviewResultCheckpoint(input(acceptedCheckpoint()));
    expect(resolved.origin).toBe("accepted");
  });

  it("reports live history as matching the adopted checkpoint", () => {
    const resolved = resolveReviewResultCheckpoint(input(acceptedCheckpoint()));
    expect(resolved.liveMatchesBaseline).toBe(true);
  });

  it("reports the live history as stale when a third-party comment follows the accepted history", () => {
    const state = acceptedCheckpoint();
    const resolved = resolveReviewResultCheckpoint(input({
      ...state,
      live: observation([comment(7, RESULT_BODY), comment(8, "a later human comment", "human")]),
    }));
    expect(resolved.liveMatchesBaseline).toBe(false);
  });

  it("reports the live history as stale when an accepted comment is edited", () => {
    const state = acceptedCheckpoint();
    const resolved = resolveReviewResultCheckpoint(input({
      ...state,
      live: observation([comment(7, `${RESULT_BODY} edited`)]),
    }));
    expect(resolved.liveMatchesBaseline).toBe(false);
  });

  it("reports the live history as stale when the result comment is deleted", () => {
    const state = acceptedCheckpoint();
    const resolved = resolveReviewResultCheckpoint(input({ ...state, live: observation([]) }));
    expect(resolved.liveMatchesBaseline).toBe(false);
  });

  it("reports the live history as stale when a submitted review follows the accepted history", () => {
    const state = acceptedCheckpoint();
    const submittedReview = [{ id: "9", author: "human", body: "LGTM", state: "APPROVED", commitId: HEAD, submittedAt: "x", createdAt: "x", updatedAt: "x" }];
    const resolved = resolveReviewResultCheckpoint(input({
      ...state,
      live: observation([comment(7, RESULT_BODY)], { submittedReviews: submittedReview }),
    }));
    expect(resolved.liveMatchesBaseline).toBe(false);
  });

  it("reports the live history as stale when an inline comment follows the accepted history", () => {
    const state = acceptedCheckpoint();
    const inline = [{ id: "10", author: "human", body: "nit", path: "src/a.ts", commitId: HEAD, originalCommitId: HEAD, line: 1, originalLine: 1, side: "RIGHT", startLine: null, startSide: "", inReplyToId: null, createdAt: "x", updatedAt: "x" }];
    const resolved = resolveReviewResultCheckpoint(input({
      ...state,
      live: observation([comment(7, RESULT_BODY)], { inlineReviewComments: inline }),
    }));
    expect(resolved.liveMatchesBaseline).toBe(false);
  });

  it("reports the live history as stale when the head changes after the accepted history", () => {
    const state = acceptedCheckpoint();
    const history = JSON.parse(JSON.stringify(state.live.history));
    history.pullRequest.headSha = "c".repeat(40);
    history.commits.push({ sha: "c".repeat(40) });
    const live = { ...state.live, history };
    const resolved = resolveReviewResultCheckpoint(input({ ...state, live }));
    expect(resolved.liveMatchesBaseline).toBe(false);
  });

  it("reports the live history as stale when the base changes after the accepted history", () => {
    const state = acceptedCheckpoint();
    const history = JSON.parse(JSON.stringify(state.live.history));
    history.pullRequest.baseSha = "d".repeat(40);
    const live = { ...state.live, history };
    const resolved = resolveReviewResultCheckpoint(input({ ...state, live }));
    expect(resolved.liveMatchesBaseline).toBe(false);
  });

  it("reports the live history as stale when the exact diff changes after the accepted history", () => {
    const state = acceptedCheckpoint();
    const history = JSON.parse(JSON.stringify(state.live.history));
    history.diff = diff("changed diff\n");
    const live = { ...state.live, history, evidence: { exactDiff: "changed diff\n" } };
    const resolved = resolveReviewResultCheckpoint(input({ ...state, live }));
    expect(resolved.liveMatchesBaseline).toBe(false);
  });

  it("rejects an accepted history that adds more than the one result comment", () => {
    const state = acceptedCheckpoint();
    const accepted = observation([comment(7, RESULT_BODY), comment(8, "unrelated", "human")]);
    const resolved = resolveReviewResultCheckpoint(input({ ...state, accepted, live: accepted }));
    expect(resolved.origin).toBe("original");
  });

  it("rejects an accepted history that edits an original comment instead of only adding one", () => {
    const state = acceptedCheckpoint();
    const accepted = observation([{ ...comment(1, "rewritten original", "human") }, comment(7, RESULT_BODY)]);
    const original = observation([comment(1, "original", "human")]);
    const resolved = resolveReviewResultCheckpoint(input({ ...state, original, accepted, live: accepted }));
    expect(resolved.origin).toBe("original");
  });

  it("rejects a saved comment whose review fingerprint differs from the dispatched result", () => {
    const resolved = resolveReviewResultCheckpoint(input(acceptedCheckpoint(RESULT_BODY.replace(FINGERPRINT, "e".repeat(20)))));
    expect(resolved.origin).toBe("original");
  });

  it("rejects a saved comment whose head differs from the expected head", () => {
    const resolved = resolveReviewResultCheckpoint(input(acceptedCheckpoint(RESULT_BODY.replace(HEAD, "c".repeat(40)))));
    expect(resolved.origin).toBe("original");
  });

  it("rejects a saved comment whose attempt persistence marker names another attempt", () => {
    const otherMarker = `<!-- deadloop:attempt-result-v1 data=${Buffer.from(JSON.stringify({ attemptId: "other-attempt", role: "reviewer" })).toString("base64url")} -->`;
    const resolved = resolveReviewResultCheckpoint(input(acceptedCheckpoint(`## Review result\n\n${RESULT_MARKER}\n${otherMarker}`)));
    expect(resolved.origin).toBe("original");
  });

  it("rejects a saved comment without the attempt persistence marker", () => {
    const resolved = resolveReviewResultCheckpoint(input(acceptedCheckpoint(`## Review result\n\n${RESULT_MARKER}`)));
    expect(resolved.origin).toBe("original");
  });

  it("rejects a saved comment authored by someone other than the automation login", () => {
    const state = acceptedCheckpoint();
    const accepted = observation([comment(7, RESULT_BODY, "someone-else")]);
    const resolved = resolveReviewResultCheckpoint(input({ ...state, accepted, live: accepted }));
    expect(resolved.origin).toBe("original");
  });

  it("reports the live history as stale when the saved result comment is absent from GitHub", () => {
    const resolved = resolveReviewResultCheckpoint(input(acceptedCheckpoint(RESULT_BODY, [])));
    expect(resolved.liveMatchesBaseline).toBe(false);
  });

  it("reports the live history as stale when the saved result comment body was mutated on GitHub", () => {
    const state = acceptedCheckpoint(RESULT_BODY, [{ id: 7, author: { login: LOGIN }, body: `${RESULT_BODY} tampered` }]);
    const resolved = resolveReviewResultCheckpoint(input(state));
    expect(resolved.liveMatchesBaseline).toBe(false);
  });

  it("keeps the original baseline when the accepted history equals the original history", () => {
    const original = observation([]);
    const resolved = resolveReviewResultCheckpoint(input({ original, accepted: original, live: original }));
    expect(resolved.origin).toBe("original");
  });
});
