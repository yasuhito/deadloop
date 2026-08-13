/**
 * What a writing attempt proved about the head it pushed.
 *
 * A writing role succeeds by moving the head its claim recorded, so success makes that revision
 * stale by construction. Separating "this attempt pushed the new head" from "somebody else pushed
 * it" needs a record the attempt did not author: the finalizer's receipt, written by the only code
 * allowed to push. The completion report is the attempt's own account, so it is read here only to
 * confirm it tells the same story as the receipt, bound to the canonical attempt journal.
 *
 * Currency is deliberately not decided here. This answers what the attempt produced; whether that
 * head is still the pull request's head belongs to whoever holds the live GitHub observation.
 */

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const { validatePromise } = require("./extract-worker-promise.ts");

type JsonObject = Record<string, any>;

export type PushedHeadTransition = { originalHeadOid: string; headOid: string };

const FINALIZER_RECEIPT_FILE = "finalizer-result.json";
const ATTEMPT_RECORD_FILE = "attempt.json";
const PUSHED_REASONS = new Set(["branch_update_pushed", "repair_pushed"]);

function commitSha(value: unknown): string {
  const text = String(value || "").toLowerCase();
  return /^[0-9a-f]{40}$/.test(text) ? text : "";
}

/** The finalizer's own record of the push it performed, or null when it recorded no push. */
function finalizerPushReceipt(runDir: string): JsonObject | null {
  let receipt: JsonObject;
  try {
    receipt = JSON.parse(fs.readFileSync(path.join(runDir, FINALIZER_RECEIPT_FILE), "utf8"));
  } catch {
    return null;
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  if (receipt.action !== "pushed" || !PUSHED_REASONS.has(String(receipt.reason || ""))) return null;
  return receipt;
}

/**
 * The head transition this attempt proved it produced, or null when it proved none.
 *
 * Both records have to name the same push: the receipt supplies the transition, and the completion
 * report, strongly bound to the attempt journal, has to agree on its role and its resulting head. A
 * receipt whose starting point is not the attempt's own input revision proves nothing about this
 * attempt, and neither does a report that a missing or mismatched journal leaves unbound.
 */
function provenPushedHeadTransition(runDir: string, record: JsonObject): PushedHeadTransition | null {
  const receipt = finalizerPushReceipt(runDir);
  if (!receipt) return null;
  const headOid = commitSha(receipt.headOid);
  const originalHeadOid = commitSha(receipt.originalHeadOid);
  if (!headOid || !originalHeadOid || headOid === originalHeadOid) return null;
  if (originalHeadOid !== commitSha(record.inputRevision?.head)) return null;

  const promiseFile = path.resolve(String(record.promiseFile || ""));
  if (path.dirname(promiseFile) !== path.resolve(runDir)) return null;
  const validation = validatePromise(promiseFile, path.join(runDir, ATTEMPT_RECORD_FILE));
  const promise = validation.promise as JsonObject | undefined;
  if (validation.evidenceStrength !== "strong" || validation.status !== "complete" || !promise) return null;
  if (String(promise.reason || "") !== String(receipt.reason)) return null;
  if (commitSha(promise.outputRevision) !== headOid) return null;
  return { originalHeadOid, headOid };
}

module.exports = { provenPushedHeadTransition };
