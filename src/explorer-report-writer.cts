// Deterministically assembles an explorer's canonical V1 completion report.
// The model supplies only the investigation's meaning; identity and delivery are taken from the
// canonical attempt journal. Writing a report does not advance the journal or authorize any host
// side effect.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
const { readAttemptRecord, validateCompletionReportBinding } = require("./attempt-lifecycle-runtime.cjs");
const { WORKER_STOP_CODES } = require("./stop-codes.cts");

const REPORT_ACCEPTING_PHASE = "agent_started";
const FORBIDDEN_PAYLOAD_FIELDS = [
  "schemaVersion", "attemptId", "role", "target", "repository", "inputRevision", "outputRevision",
  "worktree", "worktreePath", "workspace", "workspaceId", "runDir", "runDirectory", "outputPath",
  "outputFile", "promiseFile",
];
const COMPLETE_RESULT_FIELDS = ["difficulty", "relevantFiles", "verifiedClaims", "disprovedClaims", "openQuestions", "approach"];
const BLOCKED_RESULT_FIELDS = ["reason", "explanation", "recovery", "informationRequest"];

class ExplorerReportRefusal extends Error {
  code: string;
  fields: string[];

  constructor(code: string, message: string, fields: string[] = []) {
    super(message);
    this.name = "ExplorerReportRefusal";
    this.code = code;
    this.fields = fields;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function threeSentenceSummary(value: unknown): value is string {
  return nonEmptyString(value) && /^(?:[^.!?。！？]+[.!?。！？]+\s*){3}$/u.test(value.trim());
}

function validStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function refuse(code: string, field: string, message: string): never {
  throw new ExplorerReportRefusal(code, `${message}: ${field}`, [field]);
}

function refuseUnknown(field: string, allowed: string[]): never {
  refuse("unknown_payload_field", field, `field is not accepted here; allowed fields are ${allowed.join(", ")}`);
}

function collectForbiddenFields(value: unknown, prefix: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectForbiddenFields(entry, `${prefix}[${index}]`, found));
    return;
  }
  if (!plainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (FORBIDDEN_PAYLOAD_FIELDS.includes(key)) found.push(field);
    else collectForbiddenFields(child, field, found);
  }
}

function canonicalAttemptLocation(attemptRecordFile: string): { runDir: string; record: Record<string, any> } {
  const requested = path.resolve(String(attemptRecordFile || ""));
  let resolved: string;
  try {
    resolved = fs.realpathSync(requested);
  } catch {
    throw new ExplorerReportRefusal("attempt_record_missing", `attempt record does not exist: ${attemptRecordFile}`);
  }
  if (resolved !== requested) {
    throw new ExplorerReportRefusal("attempt_record_not_canonical", `attempt record path must not contain symlinks: ${attemptRecordFile}`);
  }
  const runDir = path.dirname(resolved);
  if (path.basename(resolved) !== "attempt.json" || path.basename(path.dirname(runDir)) !== "runs") {
    throw new ExplorerReportRefusal("attempt_record_not_canonical", `attempt record must be <stateDir>/runs/<attempt>/attempt.json: ${resolved}`);
  }
  try {
    const record = readAttemptRecord(runDir);
    if (path.basename(runDir) !== record.launchUuid || record.attemptId !== record.launchUuid) {
      throw new ExplorerReportRefusal(
        "attempt_record_not_canonical",
        "explorer run directory, launch UUID, and attempt ID must identify the same attempt",
      );
    }
    return { runDir, record };
  } catch (error) {
    if (error instanceof ExplorerReportRefusal) throw error;
    throw new ExplorerReportRefusal("invalid_attempt_record", error instanceof Error ? error.message : String(error));
  }
}

function assertExplorerAttempt(record: Record<string, any>): void {
  if (record.role !== "explorer") {
    throw new ExplorerReportRefusal("attempt_role_not_explorer", `attempt role is ${record.role}, not explorer`);
  }
  if (record.target?.kind !== "issue") {
    throw new ExplorerReportRefusal("attempt_target_not_issue", `attempt target is ${record.target?.kind}, not issue`);
  }
  if (record.agentRequest?.role !== "explorer") {
    throw new ExplorerReportRefusal("attempt_request_not_explorer", "attempt is not bound to an explorer Agent request");
  }
  if (record.phase !== REPORT_ACCEPTING_PHASE) {
    throw new ExplorerReportRefusal(
      "attempt_phase_not_accepting_report",
      `attempt phase is ${record.phase}; only ${REPORT_ACCEPTING_PHASE} accepts a report`,
    );
  }
}

function canonicalPromiseFile(runDir: string, record: Record<string, any>): string {
  const expected = path.join(runDir, "promise.json");
  if (String(record.promiseFile || "") !== expected) {
    throw new ExplorerReportRefusal("promise_path_not_canonical", `promiseFile must be exactly this attempt's ${expected}`);
  }
  try {
    if (fs.lstatSync(expected).isSymbolicLink()) {
      throw new ExplorerReportRefusal("promise_path_symlink", `canonical promise must not be a symlink: ${expected}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return expected;
}

type ParsedPayload = {
  status: "complete" | "blocked";
  summary: string;
  result: Record<string, unknown>;
  evidence: Record<string, unknown>;
};

function parseCompletePayload(payload: Record<string, unknown>): ParsedPayload {
  if (!plainObject(payload.result)) refuse("missing_payload_field", "result", "a complete payload needs a result");
  for (const key of Object.keys(payload.result)) if (!COMPLETE_RESULT_FIELDS.includes(key)) refuseUnknown(`result.${key}`, COMPLETE_RESULT_FIELDS);
  const result = payload.result;
  if (!["low", "medium", "high"].includes(String(result.difficulty))) {
    refuse("invalid_payload_field", "result.difficulty", "difficulty must be low, medium, or high");
  }
  for (const field of ["relevantFiles", "verifiedClaims", "disprovedClaims", "openQuestions"]) {
    if (!validStringList(result[field])) refuse("invalid_payload_field", `result.${field}`, "field must be a list of non-empty strings");
  }
  if (result.approach !== undefined && !nonEmptyString(result.approach)) {
    refuse("invalid_payload_field", "result.approach", "approach must be a non-empty string when present");
  }
  if (!plainObject(payload.evidence)) refuse("missing_payload_field", "evidence", "a complete payload needs command evidence");
  for (const key of Object.keys(payload.evidence)) if (key !== "commands") refuseUnknown(`evidence.${key}`, ["commands"]);
  if (!validStringList(payload.evidence.commands)) {
    refuse("invalid_payload_field", "evidence.commands", "commands must be a list of non-empty strings");
  }
  return { status: "complete", summary: payload.summary as string, result, evidence: { commands: payload.evidence.commands } };
}

function parseBlockedPayload(payload: Record<string, unknown>): ParsedPayload {
  if (!plainObject(payload.result)) refuse("missing_payload_field", "result", "a blocked payload needs a result");
  for (const key of Object.keys(payload.result)) if (!BLOCKED_RESULT_FIELDS.includes(key)) refuseUnknown(`result.${key}`, BLOCKED_RESULT_FIELDS);
  const result = payload.result;
  for (const field of BLOCKED_RESULT_FIELDS) {
    if (result[field] !== undefined && !nonEmptyString(result[field])) {
      refuse("invalid_payload_field", `result.${field}`, "blocked result field must be a non-empty string");
    }
  }
  if (!nonEmptyString(result.reason)) refuse("missing_payload_field", "result.reason", "a blocked reason is required");
  if (!WORKER_STOP_CODES.includes(result.reason)) refuse("invalid_blocked_reason", "result.reason", `reason must be ${WORKER_STOP_CODES.join("|")}`);
  if (!nonEmptyString(result.explanation)) refuse("missing_payload_field", "result.explanation", "a blocked explanation is required");
  if (!nonEmptyString(result.recovery) && !nonEmptyString(result.informationRequest)) {
    refuse("missing_payload_field", "result.recovery", "recovery or informationRequest is required");
  }
  return { status: "blocked", summary: payload.summary as string, result, evidence: {} };
}

function parseExplorerPayload(payload: unknown): ParsedPayload {
  if (!plainObject(payload)) throw new ExplorerReportRefusal("invalid_payload", "payload must be one JSON object");
  const forbidden: string[] = [];
  collectForbiddenFields(payload, "", forbidden);
  if (forbidden.length) {
    throw new ExplorerReportRefusal(
      "forbidden_payload_fields",
      `the writer injects these fields; the payload must not specify them: ${forbidden.join(", ")}`,
      forbidden,
    );
  }
  if (payload.status !== "complete" && payload.status !== "blocked") {
    refuse("invalid_payload_status", "status", "status must be complete or blocked");
  }
  if (!threeSentenceSummary(payload.summary)) {
    refuse("invalid_payload_field", "summary", "summary must contain exactly three sentences ending in punctuation");
  }
  const allowed = payload.status === "complete" ? ["status", "summary", "result", "evidence"] : ["status", "summary", "result"];
  for (const key of Object.keys(payload)) if (!allowed.includes(key)) refuseUnknown(key, allowed);
  return payload.status === "complete" ? parseCompletePayload(payload) : parseBlockedPayload(payload);
}

function buildExplorerReport(record: Record<string, any>, payload: ParsedPayload): Record<string, unknown> {
  return {
    schemaVersion: 1,
    attemptId: record.attemptId,
    role: "explorer",
    target: { repository: record.repository, kind: "issue", number: record.target.number },
    inputRevision: {
      head: record.inputRevision.head,
      ...(record.inputRevision.base === undefined ? {} : { base: record.inputRevision.base }),
    },
    status: payload.status,
    summary: payload.summary,
    result: payload.result,
    evidence: payload.evidence,
  };
}

type AtomicOperations = {
  writeFileSync?: typeof fs.writeFileSync;
  renameSync?: typeof fs.renameSync;
  rmSync?: typeof fs.rmSync;
};

function writeAtomically(file: string, report: Record<string, unknown>, operations: AtomicOperations = {}): void {
  const writeFileSync = operations.writeFileSync || fs.writeFileSync;
  const renameSync = operations.renameSync || fs.renameSync;
  const rmSync = operations.rmSync || fs.rmSync;
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(report)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function writeExplorerReport(
  input: { attemptRecordFile: string; payload: unknown },
  operations: AtomicOperations = {},
): { status: "written"; file: string; report: Record<string, unknown> } {
  const { runDir, record } = canonicalAttemptLocation(input.attemptRecordFile);
  assertExplorerAttempt(record);
  const promiseFile = canonicalPromiseFile(runDir, record);
  const payload = parseExplorerPayload(input.payload);
  const report = buildExplorerReport(record, payload);
  try {
    validateCompletionReportBinding(record, report);
  } catch (error) {
    throw new ExplorerReportRefusal("generated_report_invalid", error instanceof Error ? error.message : String(error));
  }
  writeAtomically(promiseFile, report, operations);
  return { status: "written", file: promiseFile, report };
}

module.exports = { ExplorerReportRefusal, writeExplorerReport };
