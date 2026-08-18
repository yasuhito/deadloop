#!/usr/bin/env node
// Validate a worker promise JSON file. CommonJS-shaped so it can run directly
// with `node extract-worker-promise.cts`.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

type PromiseValidation = Record<string, any>;

const VALID_PROMISE_STATUSES = new Set(["complete", "blocked"]);
const VALID_FINDING_SEVERITIES = new Set(["blocker", "major", "minor"]);
// Mirrors PriorRequiredFindingDisposition in src/reviewer-outcome-contract-types.ts.
// This helper stays dependency-free so it can validate a promise on its own.
const VALID_PRIOR_FINDING_DISPOSITIONS = new Set(["none", "all_resolved", "persisted", "regressed", "mixed"]);
const SUCCESSFUL_ATTEMPT_PHASES = new Set([
  "prepared",
  "github_claimed",
  "workspace_opened",
  "agent_started",
  "report_received",
  "github_persisted",
  "workspace_closed",
]);
const ATTEMPT_ROLES = new Set(["worker", "explorer", "reviewer", "review-repair", "branch-update"]);

function validFinding(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const finding = value as PromiseValidation;
  if (typeof finding.title !== "string" || !finding.title.trim()) return false;
  if (typeof finding.body !== "string" || !finding.body.trim()) return false;
  if (finding.path !== undefined && (typeof finding.path !== "string" || !finding.path.trim())) return false;
  if (finding.line !== undefined && (!Number.isInteger(finding.line) || finding.line < 1)) return false;
  if (finding.severity !== undefined && !VALID_FINDING_SEVERITIES.has(finding.severity)) return false;
  return true;
}

function validRepair(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const repair = value as PromiseValidation;
  return (
    typeof repair.title === "string" &&
    Boolean(repair.title.trim()) &&
    typeof repair.summary === "string" &&
    Boolean(repair.summary.trim()) &&
    Array.isArray(repair.paths) &&
    repair.paths.length > 0 &&
    repair.paths.every((entry: unknown) => typeof entry === "string" && Boolean(entry.trim()))
  );
}

function validCheck(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const check = value as PromiseValidation;
  return typeof check.command === "string" && Boolean(check.command.trim()) && check.result === "passed";
}

function validStringList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
    && value.every((entry: unknown) => typeof entry === "string" && Boolean(entry.trim()));
}

function sameText(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function validCommitSha(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function validObject(value: unknown): value is PromiseValidation {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validFinalizerCommon(promise: PromiseValidation): string | undefined {
  const finalizer = promise.evidence.finalizer;
  if (!validObject(finalizer) || !validNonEmptyString(finalizer.reason)) return "finalizer_evidence_required";
  if (!validCommitSha(finalizer.originalHeadOid) || !sameText(finalizer.originalHeadOid, promise.inputRevision.head)) {
    return "finalizer_input_head_mismatch";
  }
  if (promise.role === "branch-update" && (!validCommitSha(finalizer.baseHeadOid) || !sameText(finalizer.baseHeadOid, promise.inputRevision.base))) {
    return "finalizer_base_head_mismatch";
  }
  return undefined;
}

function validWriterResult(promise: PromiseValidation): string | undefined {
  if (!validCommitSha(promise.result.outputRevision)) {
    return promise.result.outcome === "stale_head" ? "stale_requires_output_revision" : "pushed_requires_output_revision";
  }
  const commonError = validFinalizerCommon(promise);
  if (commonError) return commonError;
  const finalizer = promise.evidence.finalizer;
  if (promise.result.outcome === "stale_head") {
    if (finalizer.action !== "stale_head") return "stale_requires_stale_finalizer";
    if (sameText(promise.result.outputRevision, promise.inputRevision.head)) return "stale_output_matches_input";
    if (!validCommitSha(finalizer.currentRemoteHeadOid)) return "stale_output_revision_mismatch";
    return sameText(finalizer.currentRemoteHeadOid, promise.result.outputRevision)
      ? undefined : "stale_output_revision_mismatch";
  }
  if (sameText(promise.result.outputRevision, promise.inputRevision.head)) return "pushed_output_matches_input";
  if (finalizer.action !== "pushed" || !sameText(finalizer.reason, promise.result.outcome)) return "pushed_finalizer_mismatch";
  if (!validCommitSha(finalizer.headOid) || !sameText(finalizer.headOid, promise.result.outputRevision)) return "pushed_output_revision_mismatch";
  if (!Array.isArray(finalizer.checks) || !finalizer.checks.length || !finalizer.checks.every(validCheck)) return "pushed_finalizer_requires_checks";
  return Array.isArray(promise.evidence.validations) && promise.evidence.validations.length
    && promise.evidence.validations.every(validCheck) ? undefined : "pushed_requires_validations";
}

function invalidPromise(filePath: string, error: string): PromiseValidation {
  return { status: "invalid", file: filePath, error };
}

function validNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && Boolean(value.trim());
}

function validV1Report(promise: PromiseValidation): string | undefined {
  if (!VALID_PROMISE_STATUSES.has(promise.status)) return "invalid_status";
  if (!validNonEmptyString(promise.attemptId)) return "invalid_attempt_id";
  if (!["worker", "explorer", "reviewer", "review-repair", "branch-update"].includes(promise.role)) return "invalid_role";
  if (!validObject(promise.target) || !validNonEmptyString(promise.target.repository)) return "invalid_target";
  if (!["issue", "pull-request"].includes(promise.target.kind) || !Number.isInteger(promise.target.number) || promise.target.number < 1) return "invalid_target";
  if (!validObject(promise.inputRevision) || !validCommitSha(promise.inputRevision.head)) return "invalid_input_revision";
  if (promise.inputRevision.base !== undefined && !validCommitSha(promise.inputRevision.base)) return "invalid_input_revision";
  if (!validNonEmptyString(promise.summary)) return "invalid_summary";
  if (!validObject(promise.result) || !validObject(promise.evidence)) return "missing_result_or_evidence";
  if (promise.status === "blocked") {
    if (!validNonEmptyString(promise.result.reason) || !validNonEmptyString(promise.result.explanation)) return "invalid_blocked_result";
    if (!validNonEmptyString(promise.result.recovery) && !validNonEmptyString(promise.result.informationRequest)) return "blocked_requires_guidance";
    return undefined;
  }
  if (promise.role === "worker") {
    return validCommitSha(promise.result.outputRevision) && validStringList(promise.evidence.validations)
      ? undefined : "worker_requires_output_and_validation";
  }
  if (promise.role === "explorer") {
    if (!["low", "medium", "high"].includes(promise.result.difficulty)) return "invalid_explorer_difficulty";
    for (const field of ["relevantFiles", "verifiedClaims", "disprovedClaims", "openQuestions"]) {
      if (!Array.isArray(promise.result[field]) || !promise.result[field].every((value: unknown) => typeof value === "string" && Boolean(value.trim()))) return `invalid_explorer_${field}`;
    }
    if (promise.result.approach !== undefined && !validNonEmptyString(promise.result.approach)) return "invalid_explorer_approach";
    return Array.isArray(promise.evidence.commands) && promise.evidence.commands.every((value: unknown) => typeof value === "string" && Boolean(value.trim()))
      ? undefined : "invalid_explorer_commands";
  }
  if (promise.role === "reviewer") {
    if (!["approved", "changes_requested", "human_required"].includes(promise.result.outcome)) return "invalid_reviewer_outcome";
    if (!validCommitSha(promise.result.reviewedHead) || !sameText(promise.result.reviewedHead, promise.inputRevision.head)) return "invalid_reviewed_head";
    if (promise.result.findings !== undefined && (!Array.isArray(promise.result.findings) || !promise.result.findings.every(validFinding))) return "invalid_reviewer_findings";
    if (promise.result.outcome === "changes_requested" && (!Array.isArray(promise.result.findings) || !promise.result.findings.length)) return "changes_requested_requires_findings";
    if (promise.result.outcome === "changes_requested" && promise.result.findings.some((finding: PromiseValidation) => !VALID_FINDING_SEVERITIES.has(finding.severity))) {
      return "changes_requested_requires_finding_severity";
    }
    if (promise.result.outcome === "approved" && Array.isArray(promise.result.findings) && promise.result.findings.length) {
      return "approved_requires_no_findings";
    }
    if (promise.result.advisories !== undefined && (!Array.isArray(promise.result.advisories) || !promise.result.advisories.every(validFinding))) {
      return "invalid_reviewer_advisories";
    }
    if (promise.result.priorRequiredFindings !== undefined && !VALID_PRIOR_FINDING_DISPOSITIONS.has(promise.result.priorRequiredFindings)) {
      return "invalid_prior_finding_disposition";
    }
    if (promise.result.outcome === "changes_requested" && promise.result.priorRequiredFindings === undefined) {
      return "changes_requested_requires_prior_finding_disposition";
    }
    if (!validStringList(promise.evidence.reviewed)) return "reviewer_requires_evidence";
    return promise.evidence.validations === undefined || validStringList(promise.evidence.validations)
      ? undefined : "reviewer_validations_must_be_a_string_list";
  }
  if (promise.role === "review-repair") {
    if (!["repair_pushed", "stale_head"].includes(promise.result.outcome)) return "invalid_review_repair_outcome";
    if (promise.result.outcome === "repair_pushed" && (!Array.isArray(promise.result.repairs) || !promise.result.repairs.length || !promise.result.repairs.every(validRepair))) {
      return "repair_pushed_requires_repairs";
    }
    return validWriterResult(promise);
  }
  if (!["branch_update_pushed", "stale_head"].includes(promise.result.outcome)) return "invalid_branch_update_outcome";
  return validWriterResult(promise);
}

function normalizeV1Report(promise: PromiseValidation): PromiseValidation {
  const result = promise.result as PromiseValidation;
  const evidence = promise.evidence as PromiseValidation;
  return {
    ...promise,
    ...result,
    ...(result.outcome ? { reason: result.outcome } : {}),
    ...(Array.isArray(result.repairs) ? { repairs: result.repairs } : {}),
    ...(Array.isArray(evidence.validations) ? { checks: evidence.validations } : {}),
  };
}

function validAttemptTarget(value: unknown): boolean {
  return validObject(value)
    && ["issue", "pull-request"].includes(value.kind)
    && Number.isInteger(value.number)
    && value.number >= 1;
}

function validAttemptRevision(value: unknown): boolean {
  return validObject(value)
    && validCommitSha(value.head)
    && (value.base === undefined || validCommitSha(value.base));
}

function validOptionalNonEmptyString(record: PromiseValidation, name: string): boolean {
  return record[name] === undefined || validNonEmptyString(record[name]);
}

function validCanonicalAttemptRecord(record: unknown): record is PromiseValidation {
  if (!validObject(record)) return false;
  if (!validNonEmptyString(record.attemptId) || !validNonEmptyString(record.launchUuid)) return false;
  if (!validNonEmptyString(record.project) || !validNonEmptyString(record.repository)) return false;
  if (!ATTEMPT_ROLES.has(record.role) || !validAttemptTarget(record.target) || !validAttemptRevision(record.inputRevision)) return false;
  if (!validNonEmptyString(record.branch) || !validOptionalNonEmptyString(record, "baseBranch")) return false;
  if (!validNonEmptyString(record.worktreePath) || !validNonEmptyString(record.agentName)) return false;
  if (!validNonEmptyString(record.workspaceLabel) || !validNonEmptyString(record.promptFile) || !validNonEmptyString(record.promiseFile)) return false;
  if (!SUCCESSFUL_ATTEMPT_PHASES.has(record.lastSuccessfulPhase)) return false;
  if (record.phase === "launch_failed") {
    if (!validNonEmptyString(record.launchError)) return false;
  } else if (!SUCCESSFUL_ATTEMPT_PHASES.has(record.phase) || record.phase !== record.lastSuccessfulPhase) {
    return false;
  }
  if (!validOptionalNonEmptyString(record, "launchError")) return false;
  if (!validOptionalNonEmptyString(record, "workspaceId") || !validOptionalNonEmptyString(record, "tabId")) return false;
  if (!validOptionalNonEmptyString(record, "rootPaneId")) return false;
  return record.outputRevision === undefined || validCommitSha(record.outputRevision);
}

function sameOptionalRevision(left: unknown, right: unknown): boolean {
  return left === undefined && right === undefined || sameText(left, right);
}

function reportMatchesRecord(promise: PromiseValidation, record: PromiseValidation): boolean {
  return promise.attemptId === record.attemptId && promise.role === record.role &&
    promise.target?.repository === record.repository && promise.target?.kind === record.target?.kind &&
    promise.target?.number === record.target?.number && sameText(promise.inputRevision?.head, record.inputRevision?.head) &&
    sameOptionalRevision(promise.inputRevision?.base, record.inputRevision?.base);
}

function validatePromise(filePath: string, attemptRecordFile?: string): PromiseValidation {
  if (!fs.existsSync(filePath)) return { status: "none", file: filePath };

  let payload: unknown;
  try {
    payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return invalidPromise(filePath, "invalid_json");
    return invalidPromise(filePath, `read_error: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return invalidPromise(filePath, "not_object");
  const promise = payload as PromiseValidation;
  if (promise.schemaVersion !== 1) return invalidPromise(filePath, "unknown_schema_version");
  const error = validV1Report(promise);
  if (error) return invalidPromise(filePath, error);
  const recordFile = attemptRecordFile || path.join(path.dirname(filePath), "attempt.json");
  const normalized = normalizeV1Report(promise);
  if (!fs.existsSync(recordFile)) {
    return { status: promise.status, file: filePath, promise: normalized, evidenceStrength: "unbound-v1" };
  }
  try {
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    if (!validCanonicalAttemptRecord(record)) return invalidPromise(filePath, "invalid_attempt_record");
    if (path.resolve(record.promiseFile) !== path.resolve(filePath)) {
      return invalidPromise(filePath, "attempt_promise_file_mismatch");
    }
    if (!reportMatchesRecord(promise, record)) return invalidPromise(filePath, "attempt_binding_mismatch");
    return { status: promise.status, file: filePath, promise: normalized, evidenceStrength: "strong", attemptRecord: recordFile };
  } catch (error) {
    return invalidPromise(filePath, `invalid_attempt_record: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requiredPromiseArg(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePromiseArgs(argv: string[]): PromiseValidation {
  const parsed: PromiseValidation = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (token === "--file") {
      parsed.file = requiredPromiseArg(argv, index, token);
      index += 1;
      continue;
    }
    if (token.startsWith("--file=")) {
      parsed.file = token.slice("--file=".length);
      continue;
    }
    if (token === "--attempt-record") {
      parsed.attemptRecord = requiredPromiseArg(argv, index, token);
      index += 1;
      continue;
    }
    if (token.startsWith("--attempt-record=")) {
      parsed.attemptRecord = token.slice("--attempt-record=".length);
      continue;
    }
    throw new Error(`unknown flag: ${token}`);
  }
  return parsed;
}

function promiseHelp(): string {
  return "Usage: extract-worker-promise.cts --file FILE [--attempt-record FILE]";
}

function main(argv: string[] = process.argv.slice(2)): number {
  const args = parsePromiseArgs(argv);
  if (args.help) {
    process.stdout.write(`${promiseHelp()}\n`);
    return 0;
  }
  if (!args.file) throw new Error("--file is required");
  const result = validatePromise(args.file, args.attemptRecord);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return VALID_PROMISE_STATUSES.has(result.status) ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`extract-worker-promise.cts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

module.exports = { validatePromise };
