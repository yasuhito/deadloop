const PREFIX = "deadloop:attempt-result-v1";
function encode(value) { return Buffer.from(JSON.stringify(value), "utf8").toString("base64url"); }
function decode(value) { try { return JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { return null; } }
function renderAttemptPersistenceMarker(record, report, extra = {}) {
  const payload = {
    attemptId: record.attemptId, role: record.role, repository: record.repository, target: record.target,
    inputRevision: record.inputRevision, outcome: report.status === "blocked" ? "blocked" : record.role === "worker" ? "complete" : report.result.outcome,
    ...(report.status === "complete" && ["worker", "review-repair", "branch-update"].includes(record.role) ? { outputRevision: report.result.outputRevision } : {}),
    ...extra,
  };
  return `<!-- ${PREFIX} data=${encode(payload)} -->`;
}
function parseAttemptPersistenceMarkers(comments) {
  const pattern = new RegExp(`<!--\\s*${PREFIX}\\s+data=([A-Za-z0-9_-]+)\\s*-->`, "g");
  const values = [];
  for (const comment of comments || []) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(String(comment?.body || "")); match; match = pattern.exec(String(comment?.body || ""))) {
      const value = decode(match[1]);
      if (value && typeof value === "object" && !Array.isArray(value)) values.push(value);
    }
  }
  return values;
}
module.exports = { parseAttemptPersistenceMarkers, renderAttemptPersistenceMarker };
