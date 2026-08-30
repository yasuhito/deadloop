// Expand a completion report's short commit SHAs to full 40-hex SHAs before validation.
//
// A worker or reviewer may report `outputRevision` / `reviewedHead` as a short SHA. When the short
// SHA resolves to exactly one commit in the attempt worktree (`git rev-parse --verify
// <short>^{commit}`), the host normalizes it before validating instead of invalidating the whole
// report. An ambiguous short SHA is rejected with the field name and the expected format so a stop
// comment can name both.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

const SHORT_SHA_PATTERN = /^[0-9a-f]{4,39}$/i;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;

function ambiguousShortShaError(field, shortSha) {
  return Object.assign(
    new Error(`${field} must be a full 40-hex commit SHA; short SHA "${shortSha}" is ambiguous and cannot be expanded`),
    { code: "ambiguous_short_sha", field },
  );
}

function isShortCommitSha(value) {
  return typeof value === "string" && SHORT_SHA_PATTERN.test(value);
}

/** Resolves to the full 40-hex SHA, or returns undefined when the revision cannot be resolved. */
function defaultResolveShortCommitSha(worktreePath, field, shortSha) {
  const run = spawnSync("git", ["-C", worktreePath, "rev-parse", "--verify", `${shortSha}^{commit}`], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (run.status === 0 && FULL_SHA_PATTERN.test(String(run.stdout).trim())) {
    return String(run.stdout).trim();
  }
  if (/ambiguous/i.test(String(run.stderr))) throw ambiguousShortShaError(field, shortSha);
  return undefined;
}

function commitShaFieldsForRole(role) {
  return role === "reviewer" ? ["reviewedHead"] : ["outputRevision"];
}

/**
 * Returns the report with every agent-written commit SHA field expanded to 40 hex digits. Only a
 * uniquely resolvable short SHA is expanded; an ambiguous one throws. Any other value is left for
 * the completion validators to reject with their own field-naming messages.
 */
function normalizeCompletionReportCommitShas(record, report, deps = {}) {
  if (!report || typeof report !== "object" || report.status !== "complete") return report;
  const result = report.result;
  if (!result || typeof result !== "object") return report;
  const worktreePath = typeof record?.worktreePath === "string" ? record.worktreePath : "";
  if (!worktreePath) return report;
  const resolveShortCommitSha = deps.resolveShortCommitSha || defaultResolveShortCommitSha;
  const expansions = {};
  for (const field of commitShaFieldsForRole(report.role)) {
    const value = result[field];
    if (!isShortCommitSha(value)) continue;
    const resolved = resolveShortCommitSha(worktreePath, field, value);
    if (resolved !== undefined) expansions[field] = resolved;
  }
  return Object.keys(expansions).length ? { ...report, result: { ...result, ...expansions } } : report;
}

/**
 * Reads the attempt's completion report from `record.promiseFile` with its short commit SHAs
 * expanded, so every step that binds the report to a commit sees the same normalized value the
 * validators saw. Callers that must not normalize (e.g. evidence copies) read the file directly.
 */
function readNormalizedCompletionReport(record, deps = {}) {
  const report = JSON.parse(fs.readFileSync(String(record.promiseFile), "utf8"));
  return normalizeCompletionReportCommitShas(record, report, deps);
}
module.exports = {
  ambiguousShortShaError,
  readNormalizedCompletionReport,
  commitShaFieldsForRole,
  isShortCommitSha,
  normalizeCompletionReportCommitShas,
};
