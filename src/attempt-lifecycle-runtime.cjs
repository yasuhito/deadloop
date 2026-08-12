const fs = require("node:fs");
const path = require("node:path");

const ATTEMPT_RECORD_FILE = "attempt.json";
const ATTEMPT_RUN_DIR = Symbol.for("deadloop.attemptRunDir");
const SUCCESSFUL_PHASES = ["prepared", "github_claimed", "workspace_opened", "agent_started", "report_received", "github_persisted", "workspace_closed"];
const ROLES = new Set(["worker", "reviewer", "review-repair", "branch-update"]);
const NEXT = { prepared: "github_claimed", github_claimed: "workspace_opened", workspace_opened: "agent_started", agent_started: "report_received", report_received: "github_persisted", github_persisted: "workspace_closed" };

function attemptRecordPath(runDir) { return path.join(runDir, ATTEMPT_RECORD_FILE); }
function releasesAttemptOwnership(phase) { return phase === "workspace_closed" || phase === "abandoned" || phase === "authority_released"; }
function nonEmpty(value, field) { if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid attempt record: ${field} must be a non-empty string`); return value; }
function sha(value, field) { const text = nonEmpty(value, field); if (!/^[0-9a-f]{40}$/i.test(text)) throw new Error(`Invalid attempt record: ${field} must be a full 40-hex commit SHA`); return text; }
function requiredVerification(value, required) {
  if (value === undefined && !required) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid attempt record: requiredVerification must be an object");
  if (!value.source || typeof value.source !== "object" || Array.isArray(value.source) || !["local", "repo_policy"].includes(value.source.kind)) throw new Error("Invalid attempt record: requiredVerification.source is invalid");
  const contract = {
    repository: nonEmpty(value.repository, "requiredVerification.repository"),
    command: nonEmpty(value.command, "requiredVerification.command"),
    source: { kind: value.source.kind, location: nonEmpty(value.source.location, "requiredVerification.source.location") },
    baseRevision: sha(value.baseRevision, "requiredVerification.baseRevision"),
  };
  if (value.override !== undefined) {
    if (!value.override || typeof value.override !== "object" || Array.isArray(value.override) || !value.override.source || typeof value.override.source !== "object" || !["local", "repo_policy"].includes(value.override.source.kind)) throw new Error("Invalid attempt record: requiredVerification.override is invalid");
    contract.override = { source: { kind: value.override.source.kind, location: nonEmpty(value.override.source.location, "requiredVerification.override.source.location") }, command: nonEmpty(value.override.command, "requiredVerification.override.command") };
  }
  return contract;
}
function parseAttemptRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid attempt record: record must be an object");
  if (!ROLES.has(value.role)) throw new Error("Invalid attempt record: role is invalid");
  if (!SUCCESSFUL_PHASES.includes(value.phase) && value.phase !== "launch_failed" && value.phase !== "abandoned" && value.phase !== "authority_released") throw new Error("Invalid attempt record: phase is invalid");
  if (!SUCCESSFUL_PHASES.includes(value.lastSuccessfulPhase)) throw new Error("Invalid attempt record: lastSuccessfulPhase is invalid");
  if (value.phase === "launch_failed" || value.phase === "abandoned") nonEmpty(value.launchError, "launchError");
  if (value.phase !== "launch_failed" && value.phase !== "abandoned" && value.phase !== "authority_released" && value.phase !== value.lastSuccessfulPhase) throw new Error("Invalid attempt record: successful phase must equal lastSuccessfulPhase");
  let abandonment;
  if (value.phase === "abandoned") {
    if (!["worker", "reviewer"].includes(value.role) || value.lastSuccessfulPhase !== "workspace_opened") throw new Error("Invalid attempt record: abandoned requires a Worker or reviewer launch failure after workspace_opened");
    for (const field of ["workspaceId", "tabId", "rootPaneId"]) nonEmpty(value[field], field);
    if (!value.abandonment || typeof value.abandonment !== "object" || Array.isArray(value.abandonment)) throw new Error("Invalid attempt record: abandoned requires abandonment evidence");
    if (value.abandonment.reason !== "launch_failed_no_agent") throw new Error("Invalid attempt record: abandonment.reason is invalid");
    const abandonedAt = nonEmpty(value.abandonment.abandonedAt, "abandonment.abandonedAt");
    if (!Number.isFinite(Date.parse(abandonedAt))) throw new Error("Invalid attempt record: abandonment.abandonedAt must be an ISO timestamp");
    abandonment = { reason: value.abandonment.reason, abandonedAt };
  } else if (value.abandonment !== undefined) throw new Error("Invalid attempt record: abandonment evidence requires abandoned phase");
  let authorityRelease;
  if (value.phase === "authority_released") {
    if (!value.authorityRelease || typeof value.authorityRelease !== "object" || Array.isArray(value.authorityRelease)) throw new Error("Invalid attempt record: authority_released requires authorityRelease evidence");
    if (value.authorityRelease.reason !== "github_authority_lost") throw new Error("Invalid attempt record: authorityRelease.reason is invalid");
    const releasedAt = nonEmpty(value.authorityRelease.releasedAt, "authorityRelease.releasedAt");
    if (!Number.isFinite(Date.parse(releasedAt))) throw new Error("Invalid attempt record: authorityRelease.releasedAt must be an ISO timestamp");
    const cutoffEventId = value.authorityRelease.cutoffEventId === undefined ? undefined : nonEmpty(value.authorityRelease.cutoffEventId, "authorityRelease.cutoffEventId");
    authorityRelease = { reason: value.authorityRelease.reason, releasedAt, ...(cutoffEventId ? { cutoffEventId } : {}) };
  } else if (value.authorityRelease !== undefined) throw new Error("Invalid attempt record: authorityRelease evidence requires authority_released phase");
  if (!value.target || !["issue", "pull-request"].includes(value.target.kind) || !Number.isInteger(value.target.number) || value.target.number < 1) throw new Error("Invalid attempt record: target is invalid");
  if (!value.inputRevision || typeof value.inputRevision !== "object") throw new Error("Invalid attempt record: inputRevision must be an object");
  sha(value.inputRevision.head, "inputRevision.head");
  if (value.inputRevision.base !== undefined) sha(value.inputRevision.base, "inputRevision.base");
  for (const field of ["attemptId", "launchUuid", "project", "repository", "branch", "worktreePath", "agentName", "workspaceLabel", "promptFile", "promiseFile"]) nonEmpty(value[field], field);
  for (const field of ["baseBranch", "workspaceId", "tabId", "rootPaneId"]) if (value[field] !== undefined) nonEmpty(value[field], field);
  if (value.outputRevision !== undefined) sha(value.outputRevision, "outputRevision");
  if (value.autoMergePolicy !== undefined && typeof value.autoMergePolicy !== "boolean") throw new Error("Invalid attempt record: autoMergePolicy must be boolean");
  if (value.reviewHistoryRequired !== undefined && typeof value.reviewHistoryRequired !== "boolean") throw new Error("Invalid attempt record: reviewHistoryRequired must be boolean");
  if (value.reviewClaim !== undefined && (!value.reviewClaim || typeof value.reviewClaim !== "object" || Array.isArray(value.reviewClaim))) throw new Error("Invalid attempt record: reviewClaim must be an object");
  return {
    attemptId: nonEmpty(value.attemptId, "attemptId"),
    launchUuid: nonEmpty(value.launchUuid, "launchUuid"),
    project: nonEmpty(value.project, "project"),
    repository: nonEmpty(value.repository, "repository"),
    role: value.role,
    target: { kind: value.target.kind, number: value.target.number },
    inputRevision: {
      head: sha(value.inputRevision.head, "inputRevision.head"),
      ...(value.inputRevision.base === undefined ? {} : { base: sha(value.inputRevision.base, "inputRevision.base") }),
    },
    branch: nonEmpty(value.branch, "branch"),
    ...(value.baseBranch === undefined ? {} : { baseBranch: nonEmpty(value.baseBranch, "baseBranch") }),
    worktreePath: nonEmpty(value.worktreePath, "worktreePath"),
    agentName: nonEmpty(value.agentName, "agentName"),
    workspaceLabel: nonEmpty(value.workspaceLabel, "workspaceLabel"),
    promptFile: nonEmpty(value.promptFile, "promptFile"),
    promiseFile: nonEmpty(value.promiseFile, "promiseFile"),
    phase: value.phase,
    lastSuccessfulPhase: value.lastSuccessfulPhase,
    ...(value.launchError === undefined ? {} : { launchError: nonEmpty(value.launchError, "launchError") }),
    ...(value.workspaceId === undefined ? {} : { workspaceId: nonEmpty(value.workspaceId, "workspaceId") }),
    ...(value.tabId === undefined ? {} : { tabId: nonEmpty(value.tabId, "tabId") }),
    ...(value.rootPaneId === undefined ? {} : { rootPaneId: nonEmpty(value.rootPaneId, "rootPaneId") }),
    ...(value.outputRevision === undefined ? {} : { outputRevision: sha(value.outputRevision, "outputRevision") }),
    ...(value.autoMergePolicy === undefined ? {} : { autoMergePolicy: value.autoMergePolicy }),
    ...(value.reviewHistoryRequired === undefined ? {} : { reviewHistoryRequired: value.reviewHistoryRequired }),
    ...(requiredVerification(value.requiredVerification, false) ? { requiredVerification: requiredVerification(value.requiredVerification, true) } : {}),
    ...(value.reviewClaim === undefined ? {} : { reviewClaim: value.reviewClaim }),
    ...(abandonment ? { abandonment } : {}),
    ...(authorityRelease ? { authorityRelease } : {}),
  };
}
function readAttemptRecord(runDir) {
  const file = attemptRecordPath(runDir);
  if (!fs.existsSync(file)) throw new Error(`Attempt record is missing: ${file}`);
  try {
    const record = parseAttemptRecord(JSON.parse(fs.readFileSync(file, "utf8")));
    Object.defineProperty(record, ATTEMPT_RUN_DIR, { value: path.resolve(runDir), enumerable: false });
    return record;
  }
  catch (error) { if (String(error.message).startsWith("Invalid attempt record:")) throw error; throw new Error(`Invalid attempt record: malformed JSON at ${file}`, { cause: error }); }
}
function sameIdentity(left, right) {
  return left.attemptId === right.attemptId && left.launchUuid === right.launchUuid && left.project === right.project
    && left.repository === right.repository && left.role === right.role && left.target.kind === right.target.kind
    && left.target.number === right.target.number && left.inputRevision.head.toLowerCase() === right.inputRevision.head.toLowerCase()
    && String(left.inputRevision.base || "").toLowerCase() === String(right.inputRevision.base || "").toLowerCase();
}
function object(value, name) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value; }
function stringArray(value) { return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim()); }
function sameText(left, right) { return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase(); }
function sameOptionalText(left, right) { return left === undefined && right === undefined || sameText(left, right); }
function check(value) { return value && typeof value === "object" && !Array.isArray(value) && typeof value.command === "string" && value.command.trim() && value.result === "passed"; }
function finding(value, severityRequired) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.title !== "string" || !value.title.trim() || typeof value.body !== "string" || !value.body.trim()) return false;
  if (value.path !== undefined && (typeof value.path !== "string" || !value.path.trim())) return false;
  if (value.line !== undefined && (!Number.isInteger(value.line) || value.line < 1)) return false;
  const validSeverity = ["blocker", "major", "minor"].includes(value.severity);
  return (!severityRequired || validSeverity) && (value.severity === undefined || validSeverity);
}
function repair(value) { return value && typeof value === "object" && !Array.isArray(value) && typeof value.title === "string" && value.title.trim() && typeof value.summary === "string" && value.summary.trim() && stringArray(value.paths); }
function requiredString(value, name) { if (typeof value[name] !== "string" || !value[name].trim()) throw new Error(`${name} must be a non-empty string`); }
function requiredSha(value, name) { if (typeof value[name] !== "string" || !/^[0-9a-f]{40}$/i.test(value[name])) throw new Error(`${name} must be a full 40-hex commit SHA`); }
function validateBlocked(report) {
  const result = object(report.result, "Blocked completion result"); object(report.evidence, "Blocked completion evidence");
  requiredString(result, "reason"); requiredString(result, "explanation");
  if ((typeof result.recovery !== "string" || !result.recovery.trim()) && (typeof result.informationRequest !== "string" || !result.informationRequest.trim())) throw new Error("Blocked completion result requires recovery or informationRequest");
}
function validateFinalizer(report, evidence) {
  const finalizer = object(evidence.finalizer, `${report.role} finalizer evidence`); requiredString(finalizer, "reason"); requiredSha(finalizer, "originalHeadOid");
  if (!sameText(finalizer.originalHeadOid, report.inputRevision.head)) throw new Error(`${report.role} finalizer original head does not match input revision`);
  if (report.role === "branch-update") { requiredSha(finalizer, "baseHeadOid"); if (!report.inputRevision.base || !sameText(finalizer.baseHeadOid, report.inputRevision.base)) throw new Error("branch-update finalizer base head does not match input revision"); }
  return finalizer;
}
function validateComplete(report) {
  const result = object(report.result, "Completion result"); const evidence = object(report.evidence, "Completion evidence");
  if (report.role === "worker") { requiredSha(result, "outputRevision"); if (!stringArray(evidence.validations)) throw new Error("Worker completion requires validation evidence"); return; }
  if (report.role === "reviewer") {
    if (!["approved", "changes_requested", "human_required"].includes(result.outcome)) throw new Error("Reviewer completion outcome is invalid");
    requiredSha(result, "reviewedHead"); if (!sameText(result.reviewedHead, report.inputRevision.head)) throw new Error("Reviewer completion reviewedHead does not match input revision");
    if (result.findings !== undefined && (!Array.isArray(result.findings) || !result.findings.every((item) => finding(item, result.outcome === "changes_requested")))) throw new Error("Reviewer completion has an invalid finding");
    if (result.outcome === "changes_requested" && (!Array.isArray(result.findings) || !result.findings.length)) throw new Error("Reviewer changes_requested requires findings with severity");
    if (!stringArray(evidence.reviewed)) throw new Error("Reviewer completion requires review evidence"); return;
  }
  requiredSha(result, "outputRevision"); const finalizer = validateFinalizer(report, evidence);
  const expectedPushed = report.role === "review-repair" ? "repair_pushed" : "branch_update_pushed";
  if (![expectedPushed, "stale_head"].includes(result.outcome)) throw new Error(`${report.role} completion outcome is invalid`);
  if (report.role === "review-repair" && result.outcome === "repair_pushed" && (!Array.isArray(result.repairs) || !result.repairs.length || !result.repairs.every(repair))) throw new Error("review-repair repair_pushed requires structured repairs");
  if (sameText(result.outputRevision, report.inputRevision.head)) throw new Error(`${report.role} outputRevision must differ from the input head`);
  if (result.outcome === "stale_head") {
    if (finalizer.action !== "stale_head") throw new Error(`${report.role} stale outcome requires stale finalizer evidence`); requiredSha(finalizer, "currentRemoteHeadOid");
    if (!sameText(finalizer.currentRemoteHeadOid, result.outputRevision)) throw new Error(`${report.role} outputRevision does not match finalizer current remote head`); return;
  }
  if (finalizer.action !== "pushed" || !sameText(finalizer.reason, result.outcome)) throw new Error(`${report.role} pushed outcome requires matching pushed finalizer evidence`);
  requiredSha(finalizer, "headOid"); if (!sameText(finalizer.headOid, result.outputRevision)) throw new Error(`${report.role} outputRevision does not match finalizer head`);
  if (!Array.isArray(finalizer.checks) || !finalizer.checks.length || !finalizer.checks.every(check)) throw new Error(`${report.role} pushed finalizer requires passed checks`);
  if (!Array.isArray(evidence.validations) || !evidence.validations.length || !evidence.validations.every(check)) throw new Error(`${report.role} pushed completion requires validation evidence`);
}
function validateCompletionReportBinding(record, value) {
  parseAttemptRecord(record); const report = object(value, "Completion report");
  if (report.schemaVersion !== 1) throw new Error("Completion report schemaVersion is not V1");
  if (!ROLES.has(report.role)) throw new Error("Completion report role is invalid");
  if (!["complete", "blocked"].includes(report.status)) throw new Error("Completion report status is invalid");
  nonEmpty(report.attemptId, "completion report attemptId"); nonEmpty(report.summary, "completion report summary");
  const reportTarget = object(report.target, "Completion report target"); const revision = object(report.inputRevision, "Completion report inputRevision");
  if (!['issue', 'pull-request'].includes(reportTarget.kind) || !Number.isInteger(reportTarget.number) || reportTarget.number < 1) throw new Error("Completion report target is invalid");
  nonEmpty(reportTarget.repository, "completion report repository"); sha(revision.head, "completion report inputRevision.head"); if (revision.base !== undefined) sha(revision.base, "completion report inputRevision.base");
  if (report.attemptId !== record.attemptId || report.role !== record.role || reportTarget.repository !== record.repository || reportTarget.kind !== record.target.kind || reportTarget.number !== record.target.number || !sameText(revision.head, record.inputRevision.head) || !sameOptionalText(revision.base, record.inputRevision.base)) throw new Error("Completion report identity does not match attempt record");
  if (report.status === "blocked") validateBlocked(report); else validateComplete(report);
  return { strength: "strong", report };
}
function assertAdvance(current, next) {
  if (!sameIdentity(current, next)) throw new Error("Attempt record identity cannot change");
  for (const field of ["branch", "baseBranch", "worktreePath", "agentName", "workspaceLabel", "promptFile", "promiseFile", "autoMergePolicy", "reviewHistoryRequired"]) if (current[field] !== next[field]) throw new Error(`Attempt record ${field} cannot change`);
  if (JSON.stringify(current.requiredVerification) !== JSON.stringify(next.requiredVerification)) throw new Error("Attempt record requiredVerification cannot change");
  if (current.reviewClaim !== undefined && JSON.stringify(current.reviewClaim) !== JSON.stringify(next.reviewClaim)) throw new Error("Attempt record reviewClaim cannot change");
  for (const field of ["workspaceId", "tabId", "rootPaneId", "outputRevision"]) if (current[field] !== undefined && current[field] !== next[field]) throw new Error(`Attempt record ${field} cannot change`);
  if (current.abandonment !== undefined && JSON.stringify(current.abandonment) !== JSON.stringify(next.abandonment)) throw new Error("Attempt record abandonment evidence cannot change");
  if (current.authorityRelease !== undefined && JSON.stringify(current.authorityRelease) !== JSON.stringify(next.authorityRelease)) throw new Error("Attempt record authority-release evidence cannot change");
  if (next.phase === "authority_released") { if (!next.authorityRelease) throw new Error("authority_released requires authority-release evidence"); if (current.lastSuccessfulPhase !== next.lastSuccessfulPhase) throw new Error("Attempt record lastSuccessfulPhase cannot change"); return; }
  if (current.phase === "launch_failed" && next.phase === "abandoned") { if (!next.abandonment) throw new Error("abandoned requires abandonment evidence"); if (current.lastSuccessfulPhase !== next.lastSuccessfulPhase) throw new Error("Attempt record lastSuccessfulPhase cannot change"); if (current.launchError !== next.launchError) throw new Error("Attempt record launchError cannot change"); return; }
  if (current.phase === next.phase) { if (JSON.stringify(current) !== JSON.stringify(next)) throw new Error("Attempt record cannot be enriched without a phase transition"); return; }
  transitionAttempt(current, next.phase, next.launchError);
}
function writeAttemptRecordAtomically(file, record) {
  parseAttemptRecord(record);
  if (fs.existsSync(file)) assertAdvance(readAttemptRecord(path.dirname(file)), record);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}
function createPreparedAttempt(runDir, input) { const record = { ...input, phase: "prepared", lastSuccessfulPhase: "prepared" }; writeAttemptRecordAtomically(attemptRecordPath(runDir), record); return record; }
function transitionAttempt(record, phase, launchError) {
  parseAttemptRecord(record);
  if (record.phase === "launch_failed" || record.phase === "workspace_closed" || record.phase === "abandoned" || record.phase === "authority_released") throw new Error(`Attempt phase ${record.phase} is terminal`);
  if (phase === "launch_failed") { if (!launchError) throw new Error("launch_failed requires an error"); return { ...record, phase, launchError, lastSuccessfulPhase: record.lastSuccessfulPhase }; }
  if (phase === "abandoned") throw new Error("Use abandonPersistedAttempt for abandoned transitions");
  if (phase === "authority_released") throw new Error("Use releasePersistedAttemptAuthority for authority release");
  if (NEXT[record.phase] !== phase) throw new Error(`Attempt phase ${record.phase} cannot transition to ${phase}`);
  return { ...record, phase, lastSuccessfulPhase: phase };
}
function releasePersistedAttemptAuthority(runDir, releasedAt, cutoffEventId) {
  const current = readAttemptRecord(runDir);
  if (current.phase === "authority_released") return current;
  if (releasesAttemptOwnership(current.phase)) throw new Error(`Attempt phase ${current.phase} already released ownership`);
  if (!Number.isFinite(Date.parse(releasedAt))) throw new Error("releasedAt must be an ISO timestamp");
  const next = { ...current, phase: "authority_released", authorityRelease: { reason: "github_authority_lost", releasedAt, ...(cutoffEventId ? { cutoffEventId } : {}) } };
  writeAttemptRecordAtomically(attemptRecordPath(runDir), next);
  return next;
}
function abandonPersistedAttempt(runDir, abandonedAt) {
  const current = readAttemptRecord(runDir);
  if (current.phase === "abandoned") return current;
  if (current.phase !== "launch_failed") throw new Error(`Attempt phase ${current.phase} is not launch_failed`);
  if (!["worker", "reviewer"].includes(current.role) || current.lastSuccessfulPhase !== "workspace_opened") throw new Error("Only a Worker or reviewer launch failure after workspace_opened can be abandoned");
  if (!current.workspaceId || !current.tabId || !current.rootPaneId) throw new Error("Abandonment requires complete workspace ownership evidence");
  const next = { ...current, phase: "abandoned", abandonment: { reason: "launch_failed_no_agent", abandonedAt } };
  writeAttemptRecordAtomically(attemptRecordPath(runDir), next);
  return next;
}
function transitionPersistedAttempt(runDir, phase, launchError) {
  const current = readAttemptRecord(runDir);
  if ((phase === "github_persisted" || phase === "workspace_closed") && current.phase === phase) return current;
  const next = transitionAttempt(current, phase, launchError); writeAttemptRecordAtomically(attemptRecordPath(runDir), next); return next;
}
function recordPersistedCompletionReport(runDir, report) {
  const record = readAttemptRecord(runDir);
  validateCompletionReportBinding(record, report);
  if (record.phase !== "agent_started") throw new Error(`Attempt phase ${record.phase} cannot receive a report`);
  const outputRevision = report.status === "complete" && report.role !== "reviewer" ? report.result?.outputRevision : undefined;
  const next = { ...record, ...(outputRevision ? { outputRevision } : {}), phase: "report_received", lastSuccessfulPhase: "report_received" };
  writeAttemptRecordAtomically(attemptRecordPath(runDir), next); return next;
}
module.exports = { abandonPersistedAttempt, attemptRecordPath, createPreparedAttempt, parseAttemptRecord, readAttemptRecord, recordPersistedCompletionReport, releasePersistedAttemptAuthority, releasesAttemptOwnership, transitionAttempt, transitionPersistedAttempt, validateCompletionReportBinding, writeAttemptRecordAtomically };
