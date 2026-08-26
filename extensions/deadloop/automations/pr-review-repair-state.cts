const { createHash } = require("node:crypto") as typeof import("node:crypto");
const { reportNamesStorageExhaustion } = require("../../../src/storage-exhaustion.cjs");

type JsonObject = Record<string, any>;

function encodeMarkerPayload(value: JsonObject): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeMarkerPayload(value: string): JsonObject | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const REPAIR_MARKER_RE = /<!--\s*deadloop:review-repair-attempt\s+key=([0-9a-f]+)\s+head=([0-9a-f]+)\s+review=([0-9a-f]+)(?:\s+findings=([1-9][0-9]*))?(?:\s+data=([A-Za-z0-9_-]+))?\s*-->/gi;
const TECHNICAL_MARKER_RE = /<!--\s*deadloop:review-technical-failure\s+head=([0-9a-f]+)\s*-->/gi;

function normalizedFinding(finding: JsonObject): JsonObject {
  const normalized: JsonObject = {
    title: String(finding.title || "").trim(),
    body: String(finding.body || "").trim(),
  };
  if (finding.path) normalized.path = String(finding.path).trim();
  if (finding.line !== undefined) normalized.line = Number(finding.line);
  if (finding.severity) normalized.severity = String(finding.severity).toLowerCase();
  return normalized;
}

function reviewResultFingerprint(findings: JsonObject[]): string {
  const canonical = findings
    .map(normalizedFinding)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash("sha256").update(`${JSON.stringify(canonical)}\n`).digest("hex").slice(0, 20);
}

function reviewOutcomeFingerprint(
  outcome: string,
  reason: string,
  summary: string,
  findings: JsonObject[] = [],
  advisories: JsonObject[] = [],
): string {
  // changes_requested shares its fingerprint with the repair attempt key, which
  // selectRepairAttempt recomputes from findings alone.
  if (outcome === "changes_requested") return reviewResultFingerprint(findings);
  return createHash("sha256")
    .update(`${JSON.stringify({
      outcome,
      reason: reason.trim(),
      summary: summary.trim(),
      advisories: advisories.map(normalizedFinding),
    })}\n`)
    .digest("hex")
    .slice(0, 20);
}

function repairAttemptKey(headOid: string, reviewFingerprint: string): string {
  return createHash("sha256")
    .update(`${headOid.toLowerCase()}\n${reviewFingerprint.toLowerCase()}\n`)
    .digest("hex")
    .slice(0, 20);
}

function renderRepairMarker(headOid: string, reviewFingerprint: string, payload?: JsonObject): string {
  const data = payload ? ` data=${encodeMarkerPayload(payload)}` : "";
  return `<!-- deadloop:review-repair-attempt key=${repairAttemptKey(headOid, reviewFingerprint)} head=${headOid.toLowerCase()} review=${reviewFingerprint.toLowerCase()}${data} -->`;
}

function repairAttempts(comments: JsonObject[], authorLogin?: string): JsonObject[] {
  const attempts: JsonObject[] = [];
  for (const comment of comments || []) {
    if (authorLogin && String(comment?.author?.login || "").toLowerCase() !== authorLogin.toLowerCase()) continue;
    const body = String(comment?.body || "");
    REPAIR_MARKER_RE.lastIndex = 0;
    for (let match = REPAIR_MARKER_RE.exec(body); match; match = REPAIR_MARKER_RE.exec(body)) {
      attempts.push({
        key: match[1].toLowerCase(),
        headOid: match[2].toLowerCase(),
        reviewFingerprint: match[3].toLowerCase(),
        ...(match[4] === undefined ? {} : { findingCount: Number(match[4]) }),
        ...(match[5] ? { payload: decodeMarkerPayload(match[5]) } : {}),
      });
    }
  }
  return attempts;
}

function selectRepairAttempt(comments: JsonObject[], headOid: string, findings: JsonObject[], authorLogin: string): JsonObject {
  const reviewFingerprint = reviewResultFingerprint(findings);
  const key = repairAttemptKey(headOid, reviewFingerprint);
  const attempts = repairAttempts(comments, authorLogin);
  if (attempts.some((attempt) => attempt.key === key)) {
    return { action: "already_attempted", reason: "duplicate_dispatch", key, reviewFingerprint };
  }
  return { action: "launch_repair", reason: "repair_progress_reported", key, reviewFingerprint };
}

function decideTechnicalReviewFailure(comments: JsonObject[], headOid: string, report?: JsonObject): JsonObject {
  // A blocked report naming an observed ENOSPC/EDQUOT names its cause. Retrying consumes the one
  // technical allowance without addressing that cause, so the stop keeps it and skips the retry.
  if (reportNamesStorageExhaustion(report)) {
    return { action: "storage_exhaustion", reason: "observed_storage_exhaustion", failures: 0 };
  }
  const failures = technicalFailureCount(comments, headOid);
  return failures < 1
    ? { action: "retry", reason: "first_technical_failure", failures }
    : { action: "human_required", reason: "technical_retry_exhausted", failures };
}

function renderTechnicalFailureMarker(headOid: string): string {
  return `<!-- deadloop:review-technical-failure head=${headOid.toLowerCase()} -->`;
}

function technicalFailureCount(comments: JsonObject[], headOid: string): number {
  let count = 0;
  for (const comment of comments || []) {
    const body = String(comment?.body || "");
    TECHNICAL_MARKER_RE.lastIndex = 0;
    for (let match = TECHNICAL_MARKER_RE.exec(body); match; match = TECHNICAL_MARKER_RE.exec(body)) {
      if (match[1].toLowerCase() === headOid.toLowerCase()) count += 1;
    }
  }
  return count;
}

module.exports = {
  decodeMarkerPayload,
  decideTechnicalReviewFailure,
  encodeMarkerPayload,
  renderRepairMarker,
  renderTechnicalFailureMarker,
  repairAttemptKey,
  repairAttempts,
  reviewOutcomeFingerprint,
  reviewResultFingerprint,
  selectRepairAttempt,
  technicalFailureCount,
};
