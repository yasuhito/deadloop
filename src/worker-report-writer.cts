//
// The deterministic writer for the Issue Worker's canonical V1 completion report.
//
// The Worker prompt used to make the model transcribe the whole report: the V1 identity from
// `attempt.json`, `outputRevision` from `git rev-parse HEAD`, and a final hand-written
// `promise.json`. Every transcription is a chance to stop the attempt with an invalid report, so
// this writer takes the fixed fields back: the model supplies only the meaning (status, summary,
// validation commands, or the blocked reason, explanation, and recovery), and the writer injects
// the identity from the attempt record and the worktree HEAD it observes itself.
//
// Refusals fail closed and name the offending field. The canonical promise file is only replaced
// atomically after the finished report passes `validateCompletionReportBinding`; every earlier
// failure leaves an existing report untouched.
//
// The agent-run CLI for this judgment is `extensions/deadloop/automations/write-worker-report.cts`.

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { readAttemptRecord, validateCompletionReportBinding } = require("./attempt-lifecycle-runtime.cjs");
const { WORKER_STOP_CODES } = require("./stop-codes.cts");

const ATTEMPT_RECORD_FILE = "attempt.json";
const RUNS_DIRECTORY = "runs";
// The only phase that accepts a report: the host advances it to report_received when it consumes one.
const REPORT_ACCEPTING_PHASE = "agent_started";
const GIT_TIMEOUT_MS = 15_000;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
// Identity, target, and delivery fields the writer injects from the attempt record. A payload that
// names any of them is refused with the field, never silently ignored.
const FORBIDDEN_PAYLOAD_FIELDS = [
  "schemaVersion", "attemptId", "role", "target", "repository", "inputRevision", "outputRevision",
  "worktree", "worktreePath", "promiseFile", "outputFile", "file", "output",
];
const BLOCKED_RESULT_FIELDS = ["reason", "explanation", "recovery", "informationRequest"];

class WorkerReportRefusal extends Error {
  code: string;
  fields: string[];

  constructor(code: string, message: string, fields: string[] = []) {
    super(message);
    this.name = "WorkerReportRefusal";
    this.code = code;
    this.fields = fields;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && Boolean(value.trim());
}

function nonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => nonEmptyString(entry));
}

/** The attempt record must be one direct child of a runs directory, like the host writes it. */
function canonicalAttemptRecordFile(attemptRecordFile: string): { attemptRecord: string; runDir: string } {
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(String(attemptRecordFile || "")));
  } catch {
    throw new WorkerReportRefusal("attempt_record_missing", `attempt record does not exist: ${attemptRecordFile}`);
  }
  const runDir = path.dirname(resolved);
  if (path.basename(resolved) !== ATTEMPT_RECORD_FILE || path.basename(path.dirname(runDir)) !== RUNS_DIRECTORY) {
    throw new WorkerReportRefusal(
      "attempt_record_not_canonical",
      `attempt record must be <stateDir>/${RUNS_DIRECTORY}/<launch>/${ATTEMPT_RECORD_FILE}: ${resolved}`,
    );
  }
  return { attemptRecord: resolved, runDir };
}

function readCanonicalAttemptRecord(runDir: string): Record<string, any> {
  try {
    return readAttemptRecord(runDir);
  } catch (error) {
    throw new WorkerReportRefusal(
      "invalid_attempt_record",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Only a Worker attempt in the report-accepting phase may have its canonical promise written. */
function assertWorkerReportAccepting(record: Record<string, any>): void {
  if (record.role !== "worker") {
    throw new WorkerReportRefusal("attempt_role_not_worker", `attempt role is ${record.role}, not worker`);
  }
  if (record.phase !== REPORT_ACCEPTING_PHASE) {
    throw new WorkerReportRefusal(
      "attempt_phase_not_accepting_report",
      `attempt phase is ${record.phase}; only ${REPORT_ACCEPTING_PHASE} accepts a report`,
    );
  }
}

function collectForbiddenFields(value: unknown, prefix: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectForbiddenFields(entry, `${prefix}[${index}]`, found));
    return;
  }
  if (!plainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const fieldPath = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_PAYLOAD_FIELDS.includes(key)) found.push(fieldPath);
    else collectForbiddenFields(child, fieldPath, found);
  }
}

function refuseMissing(field: string, requirement: string): never {
  throw new WorkerReportRefusal("missing_payload_field", `${requirement} is required: ${field}`, [field]);
}

function refuseUnknown(field: string, allowed: string[]): never {
  throw new WorkerReportRefusal(
    "unknown_payload_field",
    `payload field ${field} is not accepted here; allowed fields: ${allowed.join(", ")}`,
    [field],
  );
}

/** Validates the semantic payload and returns only the meaning the model decided. */
function parseWorkerPayload(payload: unknown): {
  status: "complete" | "blocked";
  summary: string;
  validations?: string[];
  blockedResult?: Record<string, string>;
} {
  if (!plainObject(payload)) {
    throw new WorkerReportRefusal("invalid_payload", "payload must be one JSON object");
  }
  const forbidden: string[] = [];
  collectForbiddenFields(payload, "", forbidden);
  if (forbidden.length) {
    throw new WorkerReportRefusal(
      "forbidden_payload_fields",
      `the writer injects these from the attempt record; the payload must not specify them: ${forbidden.join(", ")}`,
      forbidden,
    );
  }
  const status = payload.status;
  if (status !== "complete" && status !== "blocked") {
    throw new WorkerReportRefusal(
      "invalid_payload_status",
      `payload status must be "complete" or "blocked": ${JSON.stringify(status) ?? "unknown"}`,
      ["status"],
    );
  }
  if (!nonEmptyString(payload.summary)) refuseMissing("summary", "a non-empty summary");
  if (status === "complete") {
    for (const key of Object.keys(payload)) {
      if (!["status", "summary", "evidence"].includes(key)) {
        refuseUnknown(key, ["status", "summary", "evidence"]);
      }
    }
    if (!plainObject(payload.evidence)) refuseMissing("evidence", "a complete payload needs evidence.validations");
    for (const key of Object.keys(payload.evidence)) {
      if (key !== "validations") refuseUnknown(key, ["validations"]);
    }
    if (!nonEmptyStringArray(payload.evidence.validations)) {
      refuseMissing("evidence.validations", "a non-empty list of validation commands and results");
    }
    return { status, summary: payload.summary as string, validations: payload.evidence.validations as string[] };
  }
  for (const key of Object.keys(payload)) {
    if (!["status", "summary", "result"].includes(key)) {
      refuseUnknown(key, ["status", "summary", "result"]);
    }
  }
  if (!plainObject(payload.result)) refuseMissing("result", "a blocked payload needs a result");
  for (const key of Object.keys(payload.result)) {
    if (!BLOCKED_RESULT_FIELDS.includes(key)) refuseUnknown(key, BLOCKED_RESULT_FIELDS);
  }
  const blocked = payload.result as Record<string, unknown>;
  for (const field of ["reason", "explanation", "recovery", "informationRequest"]) {
    if (blocked[field] !== undefined && !nonEmptyString(blocked[field])) {
      throw new WorkerReportRefusal(
        "invalid_payload_field",
        `blocked result ${field} must be a non-empty string: ${JSON.stringify(blocked[field]) ?? "unknown"}`,
        [`result.${field}`],
      );
    }
  }
  if (!nonEmptyString(blocked.reason)) refuseMissing("result.reason", "a non-empty blocked result reason");
  if (!nonEmptyString(blocked.explanation)) refuseMissing("result.explanation", "a non-empty blocked result explanation");
  if (!nonEmptyString(blocked.recovery) && !nonEmptyString(blocked.informationRequest)) {
    refuseMissing("result.recovery", "a blocked result recovery or informationRequest");
  }
  if (!WORKER_STOP_CODES.includes(blocked.reason as string)) {
    throw new WorkerReportRefusal(
      "invalid_blocked_reason",
      `blocked result reason must be one stop code (${WORKER_STOP_CODES.join("|")}): ${JSON.stringify(blocked.reason)}`,
      ["result.reason"],
    );
  }
  return {
    status,
    summary: payload.summary as string,
    blockedResult: blocked as Record<string, string>,
  };
}

type GitResult = { status: number; stdout: string; stderr: string };

function runGit(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.error) {
    throw new WorkerReportRefusal("git_unavailable", `git could not run for the attempt worktree: ${result.error.message}`);
  }
  return { status: result.status ?? -1, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

function gitChecked(cwd: string, args: string[], code: string, message: string): string {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new WorkerReportRefusal(code, `${message}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function canonicalOrRefuse(value: string, code: string, message: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    throw new WorkerReportRefusal(code, `${message}: ${value}`);
  }
}

function parseWorktreeEntries(porcelain: string): { worktree: string; branch?: string }[] {
  return porcelain.split(/\r?\n\r?\n|\r?\n(?=worktree )/).map((block) => {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const worktree = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length) || "";
    const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
    return { worktree, ...(branch === undefined ? {} : { branch }) };
  }).filter((entry) => entry.worktree);
}

/**
 * Proves the recorded worktree is the live checkout this attempt is bound to and returns its
 * current HEAD as the full commit SHA the report's `outputRevision` must carry.
 */
function observeAttemptWorktree(record: Record<string, any>): { worktreePath: string; head: string } {
  const worktreePath = canonicalOrRefuse(
    path.resolve(String(record.worktreePath)),
    "worktree_missing",
    "the attempt worktree does not exist",
  );
  const observedTop = canonicalOrRefuse(
    gitChecked(worktreePath, ["rev-parse", "--show-toplevel"], "worktree_not_git", "the attempt worktree is not a Git checkout"),
    "worktree_not_canonical_root",
    "the attempt worktree Git root could not be resolved canonically",
  );
  if (observedTop !== worktreePath) {
    throw new WorkerReportRefusal(
      "worktree_not_canonical_root",
      `the attempt worktree path is not its canonical Git worktree root: ${worktreePath}`,
    );
  }
  // A registered entry whose directory is gone (a prunable leftover from any other tool) cannot be
  // the live attempt worktree proven above, so it is excluded from the proof instead of failing it.
  const entry = parseWorktreeEntries(
    gitChecked(worktreePath, ["worktree", "list", "--porcelain"], "worktree_not_registered", "the attempt worktree registration could not be read"),
  ).find((candidate) => {
    try {
      return fs.realpathSync(candidate.worktree) === worktreePath;
    } catch {
      return false;
    }
  });
  if (!entry) {
    throw new WorkerReportRefusal("worktree_not_registered", `the attempt worktree is not registered by its Git repository: ${worktreePath}`);
  }
  if (entry.branch !== `refs/heads/${record.branch}`) {
    throw new WorkerReportRefusal(
      "worktree_branch_not_checked_out",
      `the attempt worktree must have ${record.branch} checked out, found ${entry.branch || "a detached HEAD"}`,
    );
  }
  if (runGit(worktreePath, ["cat-file", "-e", `${record.inputRevision.head}^{commit}`]).status !== 0) {
    throw new WorkerReportRefusal(
      "worktree_missing_input_revision",
      `the attempt worktree does not hold the input revision ${record.inputRevision.head}`,
    );
  }
  const head = gitChecked(
    worktreePath,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "head_not_resolvable",
    "the attempt worktree HEAD does not resolve to exactly one commit",
  );
  if (!FULL_SHA_PATTERN.test(head)) {
    throw new WorkerReportRefusal("head_not_resolvable", `the attempt worktree HEAD is not a full commit SHA: ${head}`);
  }
  return { worktreePath, head: head.toLowerCase() };
}

/** Assembles the complete V1 report: fixed identity and observed revision, semantic payload beside them. */
function buildWorkerReport(
  record: Record<string, any>,
  payload: { status: "complete" | "blocked"; summary: string; validations?: string[]; blockedResult?: Record<string, string> },
  outputRevision: string,
): Record<string, unknown> {
  const identity = {
    schemaVersion: 1,
    attemptId: record.attemptId,
    role: record.role,
    target: { repository: record.repository, kind: record.target.kind, number: record.target.number },
    inputRevision: {
      head: record.inputRevision.head,
      ...(record.inputRevision.base === undefined ? {} : { base: record.inputRevision.base }),
    },
  };
  if (payload.status === "blocked") {
    return { ...identity, status: "blocked", summary: payload.summary, result: payload.blockedResult, evidence: {} };
  }
  return {
    ...identity,
    status: "complete",
    summary: payload.summary,
    result: { outputRevision },
    evidence: { validations: payload.validations },
  };
}

/** Replaces the canonical promise atomically: readers never observe a partial report. */
function writeCanonicalPromise(promiseFile: string, report: Record<string, unknown>): void {
  const temporary = `${promiseFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(report)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, promiseFile);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

type WriteWorkerReportInput = {
  attemptRecordFile: string;
  payload: unknown;
};

/**
 * Validates the attempt, payload, and worktree, then atomically writes the finished V1 report to
 * the attempt record's own promiseFile. Any refusal leaves the canonical promise unchanged.
 */
function writeWorkerReport(input: WriteWorkerReportInput): { status: "written"; file: string; report: Record<string, unknown> } {
  const { runDir } = canonicalAttemptRecordFile(input.attemptRecordFile);
  const record = readCanonicalAttemptRecord(runDir);
  assertWorkerReportAccepting(record);
  const payload = parseWorkerPayload(input.payload);
  const { head } = observeAttemptWorktree(record);
  const report = buildWorkerReport(record, payload, head);
  try {
    validateCompletionReportBinding(record, report);
  } catch (error) {
    throw new WorkerReportRefusal(
      "generated_report_invalid",
      error instanceof Error ? error.message : String(error),
    );
  }
  writeCanonicalPromise(record.promiseFile, report);
  return { status: "written", file: record.promiseFile, report };
}

module.exports = { WorkerReportRefusal, writeWorkerReport };
