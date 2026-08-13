import fs from "node:fs";
import path from "node:path";

import type { RequiredVerificationContract } from "./required-verification";
import type { PriorRequiredFindingDisposition } from "./reviewer-outcome-contract";

const { isPriorRequiredFindingDisposition } = require("./reviewer-outcome-contract.ts");

export const ATTEMPT_RECORD_FILE = "attempt.json";
const ATTEMPT_RUN_DIR = Symbol.for("deadloop.attemptRunDir");

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
  | "launch_failed"
  | "abandoned"
  | "authority_released";

export function releasesAttemptOwnership(phase: AttemptPhase): boolean {
  return phase === "workspace_closed" || phase === "abandoned" || phase === "authority_released";
}

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

export type ReviewerFinding = {
  title: string;
  body: string;
  path?: string;
  line?: number;
  severity?: "blocker" | "major" | "minor";
};

/** An optional improvement the reviewer leaves behind; never part of the repair contract. */
export type ReviewerAdvisory = Omit<ReviewerFinding, "severity">;

export type ValidationCheck = { command: string; result: "passed" };
export type RepairOutcome = { title: string; summary: string; paths: string[] };
export type BlockedCompletionResult = {
  reason: string;
  explanation: string;
  recovery?: string;
  informationRequest?: string;
};

export type CompletionReportV1 = {
  schemaVersion: 1;
  attemptId: string;
  target: AttemptTarget & { repository: string };
  inputRevision: InputRevision;
  summary: string;
} & (
  | { role: AttemptRole; status: "blocked"; result: BlockedCompletionResult; evidence: Record<string, unknown> }
  | { role: "worker"; status: "complete"; result: { outputRevision: string }; evidence: { validations: string[] } }
  | {
      role: "reviewer";
      status: "complete";
      result: {
        outcome: "approved" | "changes_requested" | "human_required";
        reviewedHead: string;
        /** Required findings. They are the entire automatic-repair contract. */
        findings?: ReviewerFinding[];
        /** Advisory observations. They never reach automatic repair. */
        advisories?: ReviewerAdvisory[];
        /** How the reviewer disposed of the required findings raised before this review. */
        priorRequiredFindings?: PriorRequiredFindingDisposition;
      };
      evidence: { reviewed: string[] };
    }
  | {
      role: "review-repair";
      status: "complete";
      result:
        | { outcome: "repair_pushed"; outputRevision: string; repairs: RepairOutcome[] }
        | { outcome: "stale_head"; outputRevision: string };
      evidence: { finalizer: Record<string, unknown>; validations?: ValidationCheck[] };
    }
  | {
      role: "branch-update";
      status: "complete";
      result:
        | { outcome: "branch_update_pushed"; outputRevision: string }
        | { outcome: "stale_head"; outputRevision: string };
      evidence: { finalizer: Record<string, unknown>; validations?: ValidationCheck[] };
    }
);

type CompletionReportEnvelope = Omit<CompletionReportV1, "role" | "status" | "result" | "evidence"> & {
  role: AttemptRole;
  status: "complete" | "blocked";
  result: unknown;
  evidence: unknown;
};

export type ValidatedCompletionReport = {
  strength: "strong";
  report: CompletionReportV1;
};

export type AttemptAbandonment = {
  reason: "launch_failed_no_agent";
  abandonedAt: string;
};

export type AttemptAuthorityRelease = {
  reason: "github_authority_lost";
  releasedAt: string;
  cutoffEventId?: string;
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
  lastSuccessfulPhase: Exclude<AttemptPhase, "launch_failed" | "abandoned" | "authority_released">;
  launchError?: string;
  workspaceId?: string;
  tabId?: string;
  rootPaneId?: string;
  outputRevision?: string;
  autoMergePolicy?: boolean;
  reviewHistoryRequired?: boolean;
  requiredVerification?: RequiredVerificationContract;
  reviewClaim?: Record<string, unknown>;
  abandonment?: AttemptAbandonment;
  authorityRelease?: AttemptAuthorityRelease;
};

export type PreparedAttemptInput = AttemptIdentity & {
  branch: string;
  baseBranch?: string;
  worktreePath: string;
  agentName: string;
  workspaceLabel: string;
  promptFile: string;
  promiseFile: string;
  autoMergePolicy?: boolean;
  reviewHistoryRequired?: boolean;
  requiredVerification?: RequiredVerificationContract;
  reviewClaim?: Record<string, unknown>;
};

const SUCCESSFUL_PHASES: Exclude<AttemptPhase, "launch_failed" | "abandoned" | "authority_released">[] = [
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
  if (typeof value !== "string" || !value.trim()) fail(`${name} must be a non-empty string`);
  return value;
}

function commitSha(value: unknown, name: string): string {
  const revision = nonEmptyString(value, name);
  if (!/^[0-9a-f]{40}$/i.test(revision)) fail(`${name} must be a full 40-hex commit SHA`);
  return revision;
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
  const result: InputRevision = { head: commitSha(revision.head, `${name}.head`) };
  if (revision.base !== undefined) result.base = commitSha(revision.base, `${name}.base`);
  return result;
}

function parseRequiredVerification(value: unknown, required: boolean): RequiredVerificationContract | undefined {
  if (value === undefined && !required) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("requiredVerification must be an object");
  const contract = value as Record<string, unknown>;
  const source = contract.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) fail("requiredVerification.source must be an object");
  const sourceValue = source as Record<string, unknown>;
  if (sourceValue.kind !== "local" && sourceValue.kind !== "repo_policy" && sourceValue.kind !== "default") fail("requiredVerification.source.kind is invalid");
  const command = nonEmptyString(contract.command, "requiredVerification.command");
  const parsed: RequiredVerificationContract = {
    repository: nonEmptyString(contract.repository, "requiredVerification.repository"),
    command,
    source: { kind: sourceValue.kind, location: nonEmptyString(sourceValue.location, "requiredVerification.source.location") },
    baseRevision: commitSha(contract.baseRevision, "requiredVerification.baseRevision"),
  };
  if (contract.override !== undefined) {
    if (!contract.override || typeof contract.override !== "object" || Array.isArray(contract.override)) fail("requiredVerification.override must be an object");
    const override = contract.override as Record<string, unknown>;
    const overrideSource = override.source;
    if (!overrideSource || typeof overrideSource !== "object" || Array.isArray(overrideSource)) fail("requiredVerification.override.source must be an object");
    const sourceRecord = overrideSource as Record<string, unknown>;
    if (sourceRecord.kind !== "local" && sourceRecord.kind !== "repo_policy") fail("requiredVerification.override.source.kind is invalid");
    parsed.override = {
      source: { kind: sourceRecord.kind, location: nonEmptyString(sourceRecord.location, "requiredVerification.override.source.location") },
      command: nonEmptyString(override.command, "requiredVerification.override.command"),
    };
  }
  return parsed;
}

function parseAttemptRecord(value: unknown): AttemptRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("record must be an object");
  const record = value as Record<string, unknown>;
  const role = record.role;
  if (role !== "worker" && role !== "reviewer" && role !== "review-repair" && role !== "branch-update")
    fail("role is invalid");
  const phase = record.phase;
  if (!SUCCESSFUL_PHASES.includes(phase as Exclude<AttemptPhase, "launch_failed" | "abandoned" | "authority_released">)
    && phase !== "launch_failed" && phase !== "abandoned" && phase !== "authority_released") fail("phase is invalid");
  const lastSuccessfulPhase = record.lastSuccessfulPhase;
  if (!SUCCESSFUL_PHASES.includes(lastSuccessfulPhase as Exclude<AttemptPhase, "launch_failed" | "abandoned" | "authority_released">))
    fail("lastSuccessfulPhase is invalid");
  if ((phase === "launch_failed" || phase === "abandoned") && typeof record.launchError !== "string") {
    fail(`${phase} requires launchError`);
  }
  if (phase !== "launch_failed" && phase !== "abandoned" && phase !== "authority_released" && phase !== lastSuccessfulPhase) {
    fail("successful phase must equal lastSuccessfulPhase");
  }
  let abandonment: AttemptAbandonment | undefined;
  if (phase === "abandoned") {
    if ((role !== "worker" && role !== "reviewer") || lastSuccessfulPhase !== "workspace_opened") {
      fail("abandoned requires a Worker or reviewer launch failure after workspace_opened");
    }
    for (const field of ["workspaceId", "tabId", "rootPaneId"] as const) {
      nonEmptyString(record[field], field);
    }
    if (!record.abandonment || typeof record.abandonment !== "object" || Array.isArray(record.abandonment)) {
      fail("abandoned requires abandonment evidence");
    }
    const evidence = record.abandonment as Record<string, unknown>;
    if (evidence.reason !== "launch_failed_no_agent") fail("abandonment.reason is invalid");
    const abandonedAt = nonEmptyString(evidence.abandonedAt, "abandonment.abandonedAt");
    if (!Number.isFinite(Date.parse(abandonedAt))) fail("abandonment.abandonedAt must be an ISO timestamp");
    abandonment = { reason: evidence.reason, abandonedAt };
  } else if (record.abandonment !== undefined) {
    fail("abandonment evidence requires abandoned phase");
  }
  let authorityRelease: AttemptAuthorityRelease | undefined;
  if (phase === "authority_released") {
    if (!record.authorityRelease || typeof record.authorityRelease !== "object" || Array.isArray(record.authorityRelease)) {
      fail("authority_released requires authorityRelease evidence");
    }
    const evidence = record.authorityRelease as Record<string, unknown>;
    if (evidence.reason !== "github_authority_lost") fail("authorityRelease.reason is invalid");
    const releasedAt = nonEmptyString(evidence.releasedAt, "authorityRelease.releasedAt");
    if (!Number.isFinite(Date.parse(releasedAt))) fail("authorityRelease.releasedAt must be an ISO timestamp");
    const cutoffEventId = evidence.cutoffEventId === undefined ? undefined : nonEmptyString(evidence.cutoffEventId, "authorityRelease.cutoffEventId");
    authorityRelease = { reason: evidence.reason, releasedAt, ...(cutoffEventId ? { cutoffEventId } : {}) };
  } else if (record.authorityRelease !== undefined) fail("authorityRelease evidence requires authority_released phase");

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
    lastSuccessfulPhase: lastSuccessfulPhase as Exclude<AttemptPhase, "launch_failed" | "abandoned" | "authority_released">,
    ...(record.launchError === undefined ? {} : { launchError: nonEmptyString(record.launchError, "launchError") }),
    ...(record.workspaceId === undefined ? {} : { workspaceId: nonEmptyString(record.workspaceId, "workspaceId") }),
    ...(record.tabId === undefined ? {} : { tabId: nonEmptyString(record.tabId, "tabId") }),
    ...(record.rootPaneId === undefined ? {} : { rootPaneId: nonEmptyString(record.rootPaneId, "rootPaneId") }),
    ...(record.outputRevision === undefined
      ? {}
      : { outputRevision: commitSha(record.outputRevision, "outputRevision") }),
    ...(record.autoMergePolicy === undefined
      ? {}
      : typeof record.autoMergePolicy === "boolean" ? { autoMergePolicy: record.autoMergePolicy } : fail("autoMergePolicy must be boolean")),
    ...(record.reviewHistoryRequired === undefined
      ? {}
      : typeof record.reviewHistoryRequired === "boolean" ? { reviewHistoryRequired: record.reviewHistoryRequired } : fail("reviewHistoryRequired must be boolean")),
    ...(parseRequiredVerification(record.requiredVerification, false)
      ? { requiredVerification: parseRequiredVerification(record.requiredVerification, true) }
      : {}),
    ...(record.reviewClaim === undefined
      ? {}
      : record.reviewClaim && typeof record.reviewClaim === "object" && !Array.isArray(record.reviewClaim)
        ? { reviewClaim: record.reviewClaim as Record<string, unknown> }
        : fail("reviewClaim must be an object")),
    ...(abandonment ? { abandonment } : {}),
    ...(authorityRelease ? { authorityRelease } : {}),
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

/**
 * Reads the committed record; an incomplete replacement never supersedes it.
 * A surviving temporary file marks a write which never committed, so it is never promoted.
 */
export function readAttemptRecord(runDir: string): AttemptRecord {
  const file = attemptRecordPath(runDir);
  if (!fs.existsSync(file)) throw new Error(`Attempt record is missing: ${file}`);
  const record = parseRecordFile(file);
  Object.defineProperty(record, ATTEMPT_RUN_DIR, { value: path.resolve(runDir), enumerable: false });
  return record;
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
  for (const field of ["branch", "baseBranch", "worktreePath", "agentName", "workspaceLabel", "promptFile", "promiseFile", "autoMergePolicy", "reviewHistoryRequired"] as const) {
    if (current[field] !== next[field]) throw new Error(`Attempt record ${field} cannot change`);
  }
  if (JSON.stringify(current.requiredVerification) !== JSON.stringify(next.requiredVerification)) throw new Error("Attempt record requiredVerification cannot change");
  if (current.reviewClaim !== undefined && JSON.stringify(current.reviewClaim) !== JSON.stringify(next.reviewClaim)) throw new Error("Attempt record reviewClaim cannot change");
  for (const field of ["workspaceId", "tabId", "rootPaneId", "outputRevision"] as const) {
    if (current[field] !== undefined && current[field] !== next[field]) throw new Error(`Attempt record ${field} cannot change`);
  }
  if (current.abandonment !== undefined && JSON.stringify(current.abandonment) !== JSON.stringify(next.abandonment)) {
    throw new Error("Attempt record abandonment evidence cannot change");
  }
  if (current.authorityRelease !== undefined && JSON.stringify(current.authorityRelease) !== JSON.stringify(next.authorityRelease)) {
    throw new Error("Attempt record authority-release evidence cannot change");
  }
  if (next.phase === "authority_released") {
    if (!next.authorityRelease) throw new Error("authority_released requires authority-release evidence");
    if (current.lastSuccessfulPhase !== next.lastSuccessfulPhase) throw new Error("Attempt record lastSuccessfulPhase cannot change");
    return;
  }
  if (current.phase === "launch_failed" && next.phase === "abandoned") {
    if (!next.abandonment) throw new Error("abandoned requires abandonment evidence");
    if (current.lastSuccessfulPhase !== next.lastSuccessfulPhase) throw new Error("Attempt record lastSuccessfulPhase cannot change");
    if (current.launchError !== next.launchError) throw new Error("Attempt record launchError cannot change");
    return;
  }
  if (current.phase === next.phase) {
    if (JSON.stringify(current) !== JSON.stringify(next)) throw new Error("Attempt record cannot be enriched without a phase transition");
    return;
  }
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

const NEXT_SUCCESS_PHASE: Partial<Record<AttemptPhase, AttemptPhase>> = {
  prepared: "github_claimed",
  github_claimed: "workspace_opened",
  workspace_opened: "agent_started",
  agent_started: "report_received",
  report_received: "github_persisted",
  github_persisted: "workspace_closed",
};

/** Advances a record by exactly one modeled successful phase, or records a launch failure. */
export function transitionAttempt(record: AttemptRecord, nextPhase: AttemptPhase, launchError?: string): AttemptRecord {
  parseAttemptRecord(record);
  if (record.phase === "launch_failed" || record.phase === "workspace_closed" || record.phase === "abandoned" || record.phase === "authority_released") {
    throw new Error(`Attempt phase ${record.phase} is terminal`);
  }
  if (nextPhase === "launch_failed") {
    if (!launchError) throw new Error("launch_failed requires an error");
    return { ...record, phase: "launch_failed", launchError, lastSuccessfulPhase: record.lastSuccessfulPhase };
  }
  if (nextPhase === "abandoned") throw new Error("Use abandonPersistedAttempt for abandoned transitions");
  if (nextPhase === "authority_released") throw new Error("Use releasePersistedAttemptAuthority for authority release");
  if (NEXT_SUCCESS_PHASE[record.phase] !== nextPhase) {
    throw new Error(`Attempt phase ${record.phase} cannot transition to ${nextPhase}`);
  }
  return { ...record, phase: nextPhase, lastSuccessfulPhase: nextPhase };
}

/** Records a strong terminal report and its role-specific output before GitHub persistence checks. */
export function recordPersistedCompletionReport(runDir: string, report: CompletionReportV1): AttemptRecord {
  const current = readAttemptRecord(runDir);
  validateCompletionReportBinding(current, report);
  if (current.phase !== "agent_started") throw new Error(`Attempt phase ${current.phase} cannot receive a report`);
  const outputRevision = report.status === "complete" && report.role !== "reviewer"
    ? report.result.outputRevision
    : undefined;
  const next: AttemptRecord = {
    ...current,
    ...(outputRevision ? { outputRevision } : {}),
    phase: "report_received",
    lastSuccessfulPhase: "report_received",
  };
  writeAttemptRecordAtomically(attemptRecordPath(runDir), next);
  return next;
}

export function releasePersistedAttemptAuthority(
  runDir: string,
  releasedAt: string,
  cutoffEventId?: string,
): AttemptRecord {
  const current = readAttemptRecord(runDir);
  if (current.phase === "authority_released") return current;
  if (releasesAttemptOwnership(current.phase)) throw new Error(`Attempt phase ${current.phase} already released ownership`);
  if (!Number.isFinite(Date.parse(releasedAt))) throw new Error("releasedAt must be an ISO timestamp");
  const next: AttemptRecord = {
    ...current,
    phase: "authority_released",
    authorityRelease: {
      reason: "github_authority_lost",
      releasedAt,
      ...(cutoffEventId ? { cutoffEventId } : {}),
    },
  };
  writeAttemptRecordAtomically(attemptRecordPath(runDir), next);
  return next;
}

export function abandonPersistedAttempt(runDir: string, abandonedAt: string): AttemptRecord {
  const current = readAttemptRecord(runDir);
  if (current.phase === "abandoned") return current;
  if (current.phase !== "launch_failed") throw new Error(`Attempt phase ${current.phase} is not launch_failed`);
  if ((current.role !== "worker" && current.role !== "reviewer") || current.lastSuccessfulPhase !== "workspace_opened") {
    throw new Error("Only a Worker or reviewer launch failure after workspace_opened can be abandoned");
  }
  if (!current.workspaceId || !current.tabId || !current.rootPaneId) {
    throw new Error("Abandonment requires complete workspace ownership evidence");
  }
  const next: AttemptRecord = {
    ...current,
    phase: "abandoned",
    abandonment: { reason: "launch_failed_no_agent", abandonedAt },
  };
  writeAttemptRecordAtomically(attemptRecordPath(runDir), next);
  return next;
}

/** Advances a persisted record through one legal transition. */
export function transitionPersistedAttempt(
  runDir: string,
  nextPhase: AttemptPhase,
  launchError?: string,
): AttemptRecord {
  const current = readAttemptRecord(runDir);
  if ((nextPhase === "github_persisted" || nextPhase === "workspace_closed") && current.phase === nextPhase) return current;
  const record = transitionAttempt(current, nextPhase, launchError);
  writeAttemptRecordAtomically(attemptRecordPath(runDir), record);
  return record;
}

function sameOptionalRevision(left: string | undefined, right: string | undefined): boolean {
  return left === undefined && right === undefined
    || typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function sameRevision(left: InputRevision, right: InputRevision): boolean {
  return sameOptionalRevision(left.head, right.head) && sameOptionalRevision(left.base, right.base);
}

export function parseCompletionReportV1(value: unknown): CompletionReportEnvelope {
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
  if (typeof report.summary !== "string" || !report.summary.trim()) throw new Error("Completion report summary is invalid");
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

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, name: string): void {
  if (typeof value[name] !== "string" || !value[name].trim()) throw new Error(`${name} must be a non-empty string`);
}

function requiredCommitSha(value: Record<string, unknown>, name: string): void {
  if (typeof value[name] !== "string" || !/^[0-9a-f]{40}$/i.test(value[name])) {
    throw new Error(`${name} must be a full 40-hex commit SHA`);
  }
}

function validateBlockedResult(result: unknown): void {
  const blocked = object(result, "Blocked completion result");
  requiredString(blocked, "reason");
  requiredString(blocked, "explanation");
  if (
    (typeof blocked.recovery !== "string" || !blocked.recovery.trim()) &&
    (typeof blocked.informationRequest !== "string" || !blocked.informationRequest.trim())
  ) {
    throw new Error("Blocked completion result requires recovery or informationRequest");
  }
}

const FINDING_SEVERITIES = new Set(["blocker", "major", "minor"]);

function nonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && Boolean(entry.trim()));
}

function validFinding(value: unknown, severityRequired: boolean): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const finding = value as Record<string, unknown>;
  if (typeof finding.title !== "string" || !finding.title.trim()) return false;
  if (typeof finding.body !== "string" || !finding.body.trim()) return false;
  if (finding.path !== undefined && (typeof finding.path !== "string" || !finding.path.trim())) return false;
  if (finding.line !== undefined && (!Number.isInteger(finding.line) || (finding.line as number) < 1)) return false;
  if (severityRequired && !FINDING_SEVERITIES.has(finding.severity as string)) return false;
  return finding.severity === undefined || FINDING_SEVERITIES.has(finding.severity as string);
}

function validCheck(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const check = value as Record<string, unknown>;
  return typeof check.command === "string" && Boolean(check.command.trim()) && check.result === "passed";
}

function validRepair(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const repair = value as Record<string, unknown>;
  return typeof repair.title === "string" && Boolean(repair.title.trim())
    && typeof repair.summary === "string" && Boolean(repair.summary.trim())
    && nonEmptyStringArray(repair.paths);
}

function sameText(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function validateFinalizerCommon(report: CompletionReportEnvelope, evidence: Record<string, unknown>): Record<string, unknown> {
  const finalizer = object(evidence.finalizer, `${report.role} finalizer evidence`);
  requiredString(finalizer, "reason");
  requiredCommitSha(finalizer, "originalHeadOid");
  if (!sameText(finalizer.originalHeadOid, report.inputRevision.head)) {
    throw new Error(`${report.role} finalizer original head does not match input revision`);
  }
  if (report.role === "branch-update") {
    requiredCommitSha(finalizer, "baseHeadOid");
    if (!report.inputRevision.base || !sameText(finalizer.baseHeadOid, report.inputRevision.base)) {
      throw new Error("branch-update finalizer base head does not match input revision");
    }
  }
  return finalizer;
}

function validateWriterResult(report: CompletionReportEnvelope, result: Record<string, unknown>, evidence: Record<string, unknown>): void {
  requiredCommitSha(result, "outputRevision");
  const finalizer = validateFinalizerCommon(report, evidence);
  if (result.outcome === "stale_head") {
    if (finalizer.action !== "stale_head") throw new Error(`${report.role} stale outcome requires stale finalizer evidence`);
    if (sameText(result.outputRevision, report.inputRevision.head)) {
      throw new Error(`${report.role} stale outputRevision must differ from the input head`);
    }
    requiredCommitSha(finalizer, "currentRemoteHeadOid");
    if (!sameText(finalizer.currentRemoteHeadOid, result.outputRevision)) {
      throw new Error(`${report.role} outputRevision does not match finalizer current remote head`);
    }
    return;
  }

  if (sameText(result.outputRevision, report.inputRevision.head)) {
    throw new Error(`${report.role} pushed outputRevision must differ from the input head`);
  }
  if (finalizer.action !== "pushed") throw new Error(`${report.role} pushed outcome requires pushed finalizer evidence`);
  if (!sameText(finalizer.reason, result.outcome)) throw new Error(`${report.role} finalizer reason does not match outcome`);
  requiredCommitSha(finalizer, "headOid");
  if (!sameText(finalizer.headOid, result.outputRevision)) {
    throw new Error(`${report.role} outputRevision does not match finalizer head`);
  }
  if (!Array.isArray(finalizer.checks) || finalizer.checks.length === 0 || !finalizer.checks.every(validCheck)) {
    throw new Error(`${report.role} pushed finalizer requires passed checks`);
  }
  if (!Array.isArray(evidence.validations) || evidence.validations.length === 0 || !evidence.validations.every(validCheck)) {
    throw new Error(`${report.role} pushed completion requires validation evidence`);
  }
}

function validateCompleteResult(report: CompletionReportEnvelope): void {
  const result = object(report.result, "Completion result");
  const evidence = object(report.evidence, "Completion evidence");
  if (report.role === "worker") {
    requiredCommitSha(result, "outputRevision");
    if (!nonEmptyStringArray(evidence.validations)) throw new Error("Worker completion requires validation evidence");
    return;
  }
  if (report.role === "reviewer") {
    if (result.outcome !== "approved" && result.outcome !== "changes_requested" && result.outcome !== "human_required") {
      throw new Error("Reviewer completion outcome is invalid");
    }
    requiredCommitSha(result, "reviewedHead");
    if (!sameText(result.reviewedHead, report.inputRevision.head)) throw new Error("Reviewer completion reviewedHead does not match input revision");
    if (result.findings !== undefined && (!Array.isArray(result.findings) || !result.findings.every((finding) => validFinding(finding, result.outcome === "changes_requested")))) {
      const suffix = result.outcome === "changes_requested" ? " with severity" : "";
      throw new Error(`Reviewer completion has an invalid finding${suffix}`);
    }
    if (result.outcome === "changes_requested" && (!Array.isArray(result.findings) || result.findings.length === 0)) {
      throw new Error("Reviewer changes_requested requires findings with severity");
    }
    if (result.outcome === "approved" && Array.isArray(result.findings) && result.findings.length > 0) {
      throw new Error("Reviewer approved requires no required findings");
    }
    if (result.advisories !== undefined && (!Array.isArray(result.advisories) || !result.advisories.every((advisory) => validFinding(advisory, false)))) {
      throw new Error("Reviewer completion has an invalid advisory observation");
    }
    if (result.priorRequiredFindings !== undefined && !isPriorRequiredFindingDisposition(result.priorRequiredFindings)) {
      throw new Error("Reviewer completion has an invalid priorRequiredFindings disposition");
    }
    if (result.outcome === "changes_requested" && result.priorRequiredFindings === undefined) {
      throw new Error("Reviewer changes_requested requires a priorRequiredFindings disposition");
    }
    if (!nonEmptyStringArray(evidence.reviewed)) throw new Error("Reviewer completion requires review evidence");
    return;
  }
  if (report.role === "review-repair") {
    if (result.outcome !== "repair_pushed" && result.outcome !== "stale_head") {
      throw new Error("review-repair completion outcome is invalid");
    }
    if (result.outcome === "repair_pushed" && (!Array.isArray(result.repairs) || result.repairs.length === 0 || !result.repairs.every(validRepair))) {
      throw new Error("review-repair repair_pushed requires structured repairs");
    }
    validateWriterResult(report, result, evidence);
    return;
  }
  if (result.outcome !== "branch_update_pushed" && result.outcome !== "stale_head") {
    throw new Error("branch-update completion outcome is invalid");
  }
  validateWriterResult(report, result, evidence);
}

/** Validates V1's role-specific result and evidence before a journal is available. */
export function validateCompletionReportV1(value: unknown): CompletionReportV1 {
  const report = parseCompletionReportV1(value);
  if (report.status === "blocked") {
    validateBlockedResult(report.result);
    object(report.evidence, "Blocked completion evidence");
  } else validateCompleteResult(report);
  return report as CompletionReportV1;
}

/** Validates V1's common contract, identity binding, and role-specific evidence. */
export function validateCompletionReportBinding(record: AttemptRecord, value: unknown): ValidatedCompletionReport {
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
  if (report.status === "blocked") {
    validateBlockedResult(report.result);
    object(report.evidence, "Blocked completion evidence");
  } else validateCompleteResult(report);
  return { strength: "strong", report: report as CompletionReportV1 };
}
