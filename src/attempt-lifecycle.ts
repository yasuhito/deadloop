import fs from "node:fs";
import path from "node:path";

export const ATTEMPT_RECORD_FILE = "attempt.json";

export type AttemptRole = "worker" | "reviewer" | "review-repair" | "branch-update";
export type AttemptTargetKind = "issue" | "pull-request";
export type AttemptPhase =
  | "prepared"
  | "github_claimed"
  | "workspace_opened"
  | "agent_started"
  | "report_received"
  | "github_persisted"
  | "workspace_closed"
  | "launch_failed";

export type AttemptTarget = {
  kind: AttemptTargetKind;
  number: number;
};

export type InputRevision = {
  head: string;
  base?: string;
};

/** Identity which binds a launch record and its completion report. */
export type AttemptIdentity = {
  attemptId: string;
  launchUuid: string;
  project: string;
  repository: string;
  role: AttemptRole;
  target: AttemptTarget;
  inputRevision: InputRevision;
};

export type CompletionReportV1 = {
  schemaVersion: 1;
  attemptId: string;
  role: AttemptRole;
  target: AttemptTarget & { repository: string };
  inputRevision: InputRevision;
  status: "complete" | "blocked";
  summary: string;
  result: unknown;
  evidence: unknown;
};

export type AttemptRecord = AttemptIdentity & {
  branch: string;
  baseBranch?: string;
  worktreePath: string;
  agentName: string;
  workspaceLabel: string;
  promptFile: string;
  promiseFile: string;
  phase: AttemptPhase;
  lastSuccessfulPhase: Exclude<AttemptPhase, "launch_failed">;
  launchError?: string;
  workspaceId?: string;
  tabId?: string;
  rootPaneId?: string;
  outputRevision?: string;
};

export type PreparedAttemptInput = AttemptIdentity & {
  branch: string;
  baseBranch?: string;
  worktreePath: string;
  agentName: string;
  workspaceLabel: string;
  promptFile: string;
  promiseFile: string;
};

const SUCCESSFUL_PHASES: Exclude<AttemptPhase, "launch_failed">[] = [
  "prepared",
  "github_claimed",
  "workspace_opened",
  "agent_started",
  "report_received",
  "github_persisted",
  "workspace_closed",
];

function fail(message: string): never {
  throw new Error(`Invalid attempt record: ${message}`);
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) fail(`${name} must be a non-empty string`);
  return value;
}

function parseTarget(value: unknown, name: string): AttemptTarget {
  if (!value || typeof value !== "object") fail(`${name} must be an object`);
  const target = value as Record<string, unknown>;
  if (target.kind !== "issue" && target.kind !== "pull-request") fail(`${name}.kind is invalid`);
  if (!Number.isInteger(target.number) || (target.number as number) < 1) fail(`${name}.number is invalid`);
  return { kind: target.kind, number: target.number as number };
}

function parseRevision(value: unknown, name: string): InputRevision {
  if (!value || typeof value !== "object") fail(`${name} must be an object`);
  const revision = value as Record<string, unknown>;
  const result: InputRevision = { head: nonEmptyString(revision.head, `${name}.head`) };
  if (revision.base !== undefined) result.base = nonEmptyString(revision.base, `${name}.base`);
  return result;
}

function parseAttemptRecord(value: unknown): AttemptRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("record must be an object");
  const record = value as Record<string, unknown>;
  const role = record.role;
  if (role !== "worker" && role !== "reviewer" && role !== "review-repair" && role !== "branch-update")
    fail("role is invalid");
  const phase = record.phase;
  if (!SUCCESSFUL_PHASES.includes(phase as Exclude<AttemptPhase, "launch_failed">) && phase !== "launch_failed")
    fail("phase is invalid");
  const lastSuccessfulPhase = record.lastSuccessfulPhase;
  if (!SUCCESSFUL_PHASES.includes(lastSuccessfulPhase as Exclude<AttemptPhase, "launch_failed">))
    fail("lastSuccessfulPhase is invalid");
  if (phase === "launch_failed" && typeof record.launchError !== "string") fail("launch_failed requires launchError");
  if (phase !== "launch_failed" && phase !== lastSuccessfulPhase)
    fail("successful phase must equal lastSuccessfulPhase");

  return {
    attemptId: nonEmptyString(record.attemptId, "attemptId"),
    launchUuid: nonEmptyString(record.launchUuid, "launchUuid"),
    project: nonEmptyString(record.project, "project"),
    repository: nonEmptyString(record.repository, "repository"),
    role,
    target: parseTarget(record.target, "target"),
    inputRevision: parseRevision(record.inputRevision, "inputRevision"),
    branch: nonEmptyString(record.branch, "branch"),
    ...(record.baseBranch === undefined ? {} : { baseBranch: nonEmptyString(record.baseBranch, "baseBranch") }),
    worktreePath: nonEmptyString(record.worktreePath, "worktreePath"),
    agentName: nonEmptyString(record.agentName, "agentName"),
    workspaceLabel: nonEmptyString(record.workspaceLabel, "workspaceLabel"),
    promptFile: nonEmptyString(record.promptFile, "promptFile"),
    promiseFile: nonEmptyString(record.promiseFile, "promiseFile"),
    phase: phase as AttemptPhase,
    lastSuccessfulPhase: lastSuccessfulPhase as Exclude<AttemptPhase, "launch_failed">,
    ...(record.launchError === undefined ? {} : { launchError: nonEmptyString(record.launchError, "launchError") }),
    ...(record.workspaceId === undefined ? {} : { workspaceId: nonEmptyString(record.workspaceId, "workspaceId") }),
    ...(record.tabId === undefined ? {} : { tabId: nonEmptyString(record.tabId, "tabId") }),
    ...(record.rootPaneId === undefined ? {} : { rootPaneId: nonEmptyString(record.rootPaneId, "rootPaneId") }),
    ...(record.outputRevision === undefined
      ? {}
      : { outputRevision: nonEmptyString(record.outputRevision, "outputRevision") }),
  };
}

export function attemptRecordPath(runDir: string): string {
  return path.join(runDir, ATTEMPT_RECORD_FILE);
}

function parseRecordFile(file: string): AttemptRecord {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid attempt record: malformed JSON at ${file}`, { cause: error });
  }
  return parseAttemptRecord(value);
}

/** Reads the committed record; an incomplete replacement never supersedes it. */
export function readAttemptRecord(runDir: string): AttemptRecord {
  const file = attemptRecordPath(runDir);
  if (fs.existsSync(file)) return parseRecordFile(file);

  const temporary = `${file}.tmp`;
  if (!fs.existsSync(temporary)) throw new Error(`Attempt record is missing: ${file}`);
  const recovered = parseRecordFile(temporary);
  fs.renameSync(temporary, file);
  return recovered;
}

/** Atomically replaces a valid record and refuses to overwrite malformed state. */
function sameAttemptIdentity(left: AttemptRecord, right: AttemptRecord): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.launchUuid === right.launchUuid &&
    left.project === right.project &&
    left.repository === right.repository &&
    left.role === right.role &&
    left.target.kind === right.target.kind &&
    left.target.number === right.target.number &&
    sameRevision(left.inputRevision, right.inputRevision)
  );
}

function assertRecordAdvance(current: AttemptRecord, next: AttemptRecord): void {
  if (!sameAttemptIdentity(current, next)) throw new Error("Attempt record identity cannot change");
  if (current.phase === next.phase) return;
  transitionAttempt(current, next.phase, next.launchError);
}

export function writeAttemptRecordAtomically(file: string, record: AttemptRecord): void {
  parseAttemptRecord(record);
  if (fs.existsSync(file)) assertRecordAdvance(parseRecordFile(file), record);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** Creates and durably stores the prepared record before an external mutation. */
export function createPreparedAttempt(runDir: string, input: PreparedAttemptInput): AttemptRecord {
  const record: AttemptRecord = {
    ...input,
    phase: "prepared",
    lastSuccessfulPhase: "prepared",
  };
  writeAttemptRecordAtomically(attemptRecordPath(runDir), record);
  return record;
}

/** Runs a modeled external mutation only after its prepared record is durable. */
export function withPreparedAttempt<T>(
  runDir: string,
  input: PreparedAttemptInput,
  mutation: (record: AttemptRecord) => T,
): { record: AttemptRecord; result: T } {
  const record = createPreparedAttempt(runDir, input);
  return { record, result: mutation(record) };
}

export function transitionAttempt(record: AttemptRecord, nextPhase: AttemptPhase, launchError?: string): AttemptRecord {
  parseAttemptRecord(record);
  if (record.phase === "launch_failed" || record.phase === "workspace_closed") {
    throw new Error(`Attempt phase ${record.phase} is terminal`);
  }
  if (nextPhase === "launch_failed") {
    if (!launchError) throw new Error("launch_failed requires an error");
    return { ...record, phase: "launch_failed", launchError, lastSuccessfulPhase: record.lastSuccessfulPhase };
  }
  const expected =
    SUCCESSFUL_PHASES[SUCCESSFUL_PHASES.indexOf(record.phase as Exclude<AttemptPhase, "launch_failed">) + 1];
  if (nextPhase !== expected) throw new Error(`Expected next attempt phase ${expected}, received ${nextPhase}`);
  return { ...record, phase: nextPhase, lastSuccessfulPhase: nextPhase };
}

/** Advances a persisted record through one legal transition. */
export function transitionPersistedAttempt(
  runDir: string,
  nextPhase: AttemptPhase,
  launchError?: string,
): AttemptRecord {
  const record = transitionAttempt(readAttemptRecord(runDir), nextPhase, launchError);
  writeAttemptRecordAtomically(attemptRecordPath(runDir), record);
  return record;
}

function sameRevision(left: InputRevision, right: InputRevision): boolean {
  return left.head === right.head && left.base === right.base;
}

function parseCompletionReportV1(value: unknown): CompletionReportV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Completion report must be an object");
  }
  const report = value as Record<string, unknown>;
  if (report.schemaVersion !== 1) throw new Error("Completion report schemaVersion is not V1");
  const role = report.role;
  if (role !== "worker" && role !== "reviewer" && role !== "review-repair" && role !== "branch-update") {
    throw new Error("Completion report role is invalid");
  }
  if (!report.target || typeof report.target !== "object") throw new Error("Completion report target is invalid");
  const target = report.target as Record<string, unknown>;
  if (report.status !== "complete" && report.status !== "blocked")
    throw new Error("Completion report status is invalid");
  if (typeof report.summary !== "string") throw new Error("Completion report summary is invalid");
  if (!("result" in report) || !("evidence" in report))
    throw new Error("Completion report requires result and evidence");
  return {
    schemaVersion: 1,
    attemptId: nonEmptyString(report.attemptId, "completion report attemptId"),
    role,
    target: {
      ...parseTarget(target, "completion report target"),
      repository: nonEmptyString(target.repository, "completion report repository"),
    },
    inputRevision: parseRevision(report.inputRevision, "completion report inputRevision"),
    status: report.status,
    summary: report.summary,
    result: report.result,
    evidence: report.evidence,
  };
}

/** Validates V1's common contract and identity binding; roles validate result and evidence separately. */
export function validateCompletionReportBinding(record: AttemptRecord, value: unknown): void {
  parseAttemptRecord(record);
  const report = parseCompletionReportV1(value);
  if (report.attemptId !== record.attemptId)
    throw new Error("Completion report attemptId does not match attempt record");
  if (report.role !== record.role) throw new Error("Completion report role does not match attempt record");
  if (report.target.repository !== record.repository)
    throw new Error("Completion report repository does not match attempt record");
  if (report.target.kind !== record.target.kind || report.target.number !== record.target.number) {
    throw new Error("Completion report target does not match attempt record");
  }
  if (!sameRevision(report.inputRevision, record.inputRevision)) {
    throw new Error("Completion report inputRevision does not match attempt record");
  }
}
