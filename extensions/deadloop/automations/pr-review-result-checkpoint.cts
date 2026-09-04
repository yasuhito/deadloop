#!/usr/bin/env node
// Decide which stored review-history baseline a reviewer-dispatch retry may trust.
//
// The dispatcher saves the exact result comment and the accepted history observation
// (pr-review-history-accepted.json) before its downstream transitions. When the same pending
// completion is retried, the original pr-review-history.json would flag the dispatcher's own
// result comment as an external history change and discard a still-valid review. This module
// picks the retry baseline deterministically: the accepted history only when it provably is the
// original history advanced by exactly that one result comment, and the live GitHub history still
// matches it. Everything else fails closed to the original baseline, which then reports the
// external change as stale as before.

const { comparePrHistoryObservations, readPrHistoryObservation } = require("../../../src/pr-review-history.cts");
const { parseAttemptPersistenceMarkers } = require("../../../src/attempt-persistence-marker.cjs");
const { reviewCommentExists } = require("./pr-review-comments.cts");

type JsonObject = Record<string, any>;
type PrHistoryObservation = ReturnType<typeof readPrHistoryObservation>;

type ReviewResultCheckpoint = {
  baseline: PrHistoryObservation;
  origin: "original" | "accepted";
  liveMatchesBaseline: boolean;
  adoption:
    | "no_accepted_history"
    | "accepted_history_unreadable"
    | "not_one_comment_advance"
    | "result_comment_unproven"
    | "adopted";
  comparison?: JsonObject;
};

type ReviewResultCheckpointInput = {
  original: PrHistoryObservation;
  accepted?: PrHistoryObservation;
  acceptedUnreadable?: boolean;
  live: PrHistoryObservation;
  attemptId: string;
  expectedHead: string;
  outcome: string;
  reviewFingerprint: string;
  automationLogin: string;
  liveComments: JsonObject[];
};

function originalBaseline(input: ReviewResultCheckpointInput, adoption: ReviewResultCheckpoint["adoption"]): ReviewResultCheckpoint {
  const comparison = comparePrHistoryObservations(input.original, input.live);
  return {
    baseline: input.original,
    origin: "original",
    liveMatchesBaseline: comparison.kind === "unchanged",
    adoption,
    ...(comparison.kind === "stale" ? { comparison } : {}),
  };
}

/**
 * The single conversation comment the accepted history adds to the original history, or undefined
 * when the accepted history is not exactly the original history plus one new comment.
 */
function oneCommentAdvance(input: ReviewResultCheckpointInput): JsonObject | undefined {
  const forward = comparePrHistoryObservations(input.original, input.accepted);
  if (forward.kind !== "stale" || forward.changed.length !== 1 || forward.changed[0] !== "conversationComments") return undefined;
  const previous = new Map(
    input.original.history.conversationComments.map((comment: JsonObject) => [String(comment.id), JSON.stringify(comment)]),
  );
  const added = input.accepted.history.conversationComments.filter((comment: JsonObject) => !previous.has(String(comment.id)));
  const retained = input.accepted.history.conversationComments.filter((comment: JsonObject) => previous.has(String(comment.id)));
  if (added.length !== 1 || retained.length !== previous.size) return undefined;
  if (!retained.every((comment: JsonObject) => previous.get(String(comment.id)) === JSON.stringify(comment))) return undefined;
  return added[0];
}

/**
 * Proof that the accepted history's added comment is the exact result comment of this dispatch:
 * the automation login authored it, its review-result marker carries the expected head, outcome
 * and fingerprint, and its attempt persistence marker names this attempt.
 */
function isSavedResultComment(comment: JsonObject, input: ReviewResultCheckpointInput): boolean {
  if (String(comment.author || "").trim().toLowerCase() !== String(input.automationLogin || "").trim().toLowerCase()) return false;
  if (!reviewCommentExists([comment], input.expectedHead, input.reviewFingerprint, input.outcome)) return false;
  const markers = parseAttemptPersistenceMarkers([{ body: String(comment.body || "") }]);
  return markers.length === 1 && String(markers[0].attemptId || "") === String(input.attemptId || "");
}

function resolveReviewResultCheckpoint(input: ReviewResultCheckpointInput): ReviewResultCheckpoint {
  if (!input.accepted || input.acceptedUnreadable) {
    return originalBaseline(input, input.acceptedUnreadable ? "accepted_history_unreadable" : "no_accepted_history");
  }
  const added = oneCommentAdvance(input);
  if (!added) return originalBaseline(input, "not_one_comment_advance");
  if (!isSavedResultComment(added, input)) return originalBaseline(input, "result_comment_unproven");
  // The saved comment must still exist on GitHub with the same exact identity; its disappearance
  // or mutation after the accepted history was written is an external change, not a reason to
  // fall back to the original baseline.
  const live = (input.liveComments || []).find((entry: JsonObject) => String(entry?.id ?? entry?.node_id ?? "") === String(added.id));
  const identityIntact = Boolean(live)
    && String(live.author?.login ?? live.author ?? live.user?.login ?? "").toLowerCase() === String(added.author).toLowerCase()
    && String(live.body || "") === String(added.body);
  const comparison = comparePrHistoryObservations(input.accepted, input.live);
  if (!identityIntact || comparison.kind === "stale") {
    return {
      baseline: input.accepted,
      origin: "accepted",
      liveMatchesBaseline: false,
      adoption: "adopted",
      comparison: comparison.kind === "stale"
        ? comparison
        : { kind: "stale", expectedRevision: input.accepted.revision, actualRevision: input.live.revision, changed: ["resultComment"] },
    };
  }
  return { baseline: input.accepted, origin: "accepted", liveMatchesBaseline: true, adoption: "adopted" };
}

module.exports = { resolveReviewResultCheckpoint };
