/**
 * What a stopped attempt proved it completed, in the one shape every role answers.
 *
 * An agent stops the moment it writes its completion report, so the runtime alone cannot tell a
 * finished attempt from an abandoned one. Each role proves it differently: a writing role moves the
 * head, so its proof is the finalizer's receipt for that push; a review changes nothing on the
 * branch, so its proof is the report itself, strongly bound to the attempt journal and naming the
 * revision it reviewed.
 *
 * Both answers are the same two facts. `expectedHead` is the revision the completion is bound to,
 * which its handler revalidates against before mutating anything. `currentHeadOid` is the head the
 * attempt still expects to own, so a caller holding the live pull request can tell whether this
 * proof still describes the head in front of it. Currency is deliberately left to that caller.
 */

const { provenPushedHeadTransition } = require("./pushed-head-proof.cts");
const { validatePromise } = require("./extract-worker-promise.cts");

const path = require("node:path") as typeof import("node:path");

type JsonObject = Record<string, any>;

type ProvenCompletion = { expectedHead: string; currentHeadOid: string };

const ATTEMPT_RECORD_FILE = "attempt.json";

function commitSha(value: unknown): string {
  const text = String(value || "").toLowerCase();
  return /^[0-9a-f]{40}$/.test(text) ? text : "";
}

/**
 * The review this attempt proved it completed, or null when it proved none.
 *
 * A review produces no push, so its only durable evidence is the report. That makes the binding do
 * all of the work: the report has to validate strongly against this attempt's own journal, and the
 * head it says it reviewed has to be the head the attempt was launched against. A report that
 * reviewed some other revision proves nothing about the pull request this attempt claimed.
 */
function provenReviewCompletion(runDir: string, record: JsonObject): ProvenCompletion | null {
  const promiseFile = path.resolve(String(record.promiseFile || ""));
  if (path.dirname(promiseFile) !== path.resolve(runDir)) return null;
  const validation = validatePromise(promiseFile, path.join(runDir, ATTEMPT_RECORD_FILE));
  const promise = validation.promise as JsonObject | undefined;
  if (validation.evidenceStrength !== "strong" || validation.status !== "complete" || !promise) return null;
  const reviewedHead = commitSha(promise.reviewedHead);
  if (!reviewedHead || reviewedHead !== commitSha(record.inputRevision?.head)) return null;
  return { expectedHead: reviewedHead, currentHeadOid: reviewedHead };
}

/** The completion this attempt proved, whichever way its role proves one. */
function provenAttemptCompletion(runDir: string, record: JsonObject): ProvenCompletion | null {
  if (String(record.role || "") === "reviewer") return provenReviewCompletion(runDir, record);
  const transition = provenPushedHeadTransition(runDir, record);
  return transition ? { expectedHead: transition.originalHeadOid, currentHeadOid: transition.headOid } : null;
}

module.exports = { provenAttemptCompletion, provenReviewCompletion };
