const { createHash } = require("node:crypto") as typeof import("node:crypto");

type JsonObject = Record<string, any>;

const REPAIR_MARKER_RE = /<!--\s*deadloop:review-repair-attempt\s+key=([0-9a-f]+)\s+head=([0-9a-f]+)\s+review=([0-9a-f]+)\s*-->/gi;
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

function repairAttemptKey(headOid: string, reviewFingerprint: string): string {
  return createHash("sha256")
    .update(`${headOid.toLowerCase()}\n${reviewFingerprint.toLowerCase()}\n`)
    .digest("hex")
    .slice(0, 20);
}

function renderRepairMarker(headOid: string, reviewFingerprint: string): string {
  return `<!-- deadloop:review-repair-attempt key=${repairAttemptKey(headOid, reviewFingerprint)} head=${headOid.toLowerCase()} review=${reviewFingerprint.toLowerCase()} -->`;
}

function repairAttempts(comments: JsonObject[]): JsonObject[] {
  const attempts: JsonObject[] = [];
  for (const comment of comments || []) {
    const body = String(comment?.body || "");
    REPAIR_MARKER_RE.lastIndex = 0;
    for (let match = REPAIR_MARKER_RE.exec(body); match; match = REPAIR_MARKER_RE.exec(body)) {
      attempts.push({ key: match[1].toLowerCase(), headOid: match[2].toLowerCase(), reviewFingerprint: match[3].toLowerCase() });
    }
  }
  return attempts;
}

function selectRepairAttempt(comments: JsonObject[], headOid: string, findings: JsonObject[]): JsonObject {
  const reviewFingerprint = reviewResultFingerprint(findings);
  const key = repairAttemptKey(headOid, reviewFingerprint);
  const attempts = repairAttempts(comments);
  if (attempts.some((attempt) => attempt.reviewFingerprint === reviewFingerprint)) {
    return { action: "human_required", reason: "repeated_findings", key, reviewFingerprint };
  }
  if (attempts.some((attempt) => attempt.key === key)) {
    return { action: "human_required", reason: "attempt_exhausted", key, reviewFingerprint };
  }
  return { action: "launch_repair", reason: "actionable_findings", key, reviewFingerprint };
}

function decideTechnicalReviewFailure(comments: JsonObject[], headOid: string): JsonObject {
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
  decideTechnicalReviewFailure,
  renderRepairMarker,
  renderTechnicalFailureMarker,
  repairAttemptKey,
  repairAttempts,
  reviewResultFingerprint,
  selectRepairAttempt,
  technicalFailureCount,
};
