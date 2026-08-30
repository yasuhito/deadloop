// Idempotent Issue notice for a persisted required-verification failure.
// A same-binding failure is not rerun per tick, so the Issue learns about the stall exactly once.

const { createHash } = require("node:crypto") as typeof import("node:crypto");
const fs = require("node:fs") as typeof import("node:fs");

type FailureBinding = {
  repository?: string;
  targetCommit?: string;
  command?: string;
  source?: { kind?: string; location?: string };
  baseRevision?: string;
};

type FailureRecord = {
  outcome?: string;
  exitCode?: number | null;
  terminationReason?: string;
  binding?: FailureBinding;
};

type GithubIssue = {
  number?: number;
  comments?: Array<{ body?: string | null }>;
};

type FailureNoticePlan = {
  fingerprint: string;
  comment?: string;
};

const LOG_TAIL_BYTES = 4000;

function fingerprintInput(record: FailureRecord): object {
  const binding = record.binding || {};
  return {
    outcome: String(record.outcome || ""),
    exitCode: record.exitCode === undefined ? null : record.exitCode,
    terminationReason: record.terminationReason ?? null,
    binding: {
      repository: String(binding.repository || ""),
      targetCommit: String(binding.targetCommit || ""),
      command: String(binding.command || ""),
      source: { kind: String(binding.source?.kind || ""), location: String(binding.source?.location || "") },
      baseRevision: String(binding.baseRevision || ""),
    },
  };
}

function failureFingerprint(record: FailureRecord): string {
  return createHash("sha256").update(JSON.stringify(fingerprintInput(record))).digest("hex");
}

function failureMarker(issueNumber: number, fingerprint: string): string {
  return `<!-- deadloop:required-verification-failed:v1 target=issue-${issueNumber} fingerprint=${fingerprint} -->`;
}

function hasFailureMarker(issue: GithubIssue, fingerprint: string): boolean {
  const marker = failureMarker(Number(issue.number || 0), fingerprint);
  return (issue.comments || []).some((comment) => String(comment.body || "").includes(marker));
}

/** Last bytes of the verification log for display; the log is evidence, not part of the fingerprint. */
function readLogTail(logPath: string): string {
  try {
    const stat = fs.lstatSync(logPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return "";
    const descriptor = fs.openSync(logPath, "r");
    try {
      const length = Math.min(stat.size, LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      const read = fs.readSync(descriptor, buffer, 0, length, stat.size - length);
      return buffer.toString("utf8", 0, read).trimEnd();
    } finally { fs.closeSync(descriptor); }
  } catch { return ""; }
}

function renderComment(issueNumber: number, record: FailureRecord, logTail: string, fingerprint: string): string {
  const binding = record.binding || {};
  return [
    failureMarker(issueNumber, fingerprint),
    "## Required verification failed",
    "",
    "The required-verification command failed for the current attempt inputs. The host keeps the failed evidence instead of rerunning the command on every tick; verification reruns only after an input changes (command, target commit, or base revision).",
    "",
    `- outcome: ${String(record.outcome || "unknown")}`,
    `- exit code: ${record.exitCode === null || record.exitCode === undefined ? "unknown" : String(record.exitCode)}`,
    ...(record.terminationReason ? [`- termination: ${record.terminationReason}`] : []),
    `- command: \`${String(binding.command || "unknown")}\``,
    `- target commit: ${String(binding.targetCommit || "unknown")}`,
    `- trusted base revision: ${String(binding.baseRevision || "unknown")}`,
    "",
    "Log tail:",
    "",
    "```",
    logTail || "(log unavailable)",
    "```",
    "",
    "Recovery:",
    "1. Fix the verification failure on the attempt branch, then let the attempt report completion again.",
    "2. Run `/deadloop-doctor` to inspect the retained attempt workspace.",
  ].join("\n");
}

function planVerificationFailureNotice(input: { issue: GithubIssue; record: FailureRecord; logTail: string }): FailureNoticePlan {
  const number = Number(input.issue.number || 0);
  if (!Number.isInteger(number) || number <= 0) throw new Error("required-verification failure notice requires an Issue number");
  const fingerprint = failureFingerprint(input.record);
  if (hasFailureMarker(input.issue, fingerprint)) return { fingerprint };
  return { fingerprint, comment: renderComment(number, input.record, input.logTail, fingerprint) };
}

module.exports = { failureFingerprint, failureMarker, hasFailureMarker, planVerificationFailureNotice, readLogTail };
