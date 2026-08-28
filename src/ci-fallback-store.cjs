/**
 * Persistence for CI fallback verification records, base blocking, and repair episodes (ADR 0030).
 *
 * Records live outside every worktree, under the deadloop state directory keyed by project and
 * pull request, so a disposable attempt workspace can never carry or erase merge evidence. A
 * record binds repository, PR, head, base, tree, command, derivation, policy source, policy base
 * revision, outcome, termination evidence, and log identity.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const RECORD_VERSION = 1;
const BASE_BLOCKING_FILE = "base-blocking.json";

function ciFallbackDirectory(stateDir, projectId) {
  return path.join(stateDir, "ci-fallback", sanitizeId(projectId));
}

function sanitizeId(value) {
  return String(value || "project").toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function durableWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
  fsyncDirectory(path.dirname(file));
}

function readJson(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { return undefined; }
  if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
}

function sameOid(left, right) {
  return Boolean(right) && String(left || "").toLowerCase() === String(right).toLowerCase();
}

/** One CI-equivalent verification execution against one exact tree. */
function buildVerificationRecord(input) {
  return {
    version: RECORD_VERSION,
    role: input.role,
    repository: String(input.repository),
    prNumber: Number(input.prNumber),
    headOid: String(input.headOid),
    baseOid: String(input.baseOid),
    treeOid: String(input.treeOid),
    command: String(input.command),
    derivation: String(input.derivation),
    policySource: { kind: String(input.policySource.kind), location: String(input.policySource.location) },
    policyBaseRevision: String(input.policyBaseRevision),
    outcome: input.outcome === "passed" ? "passed" : "failed",
    exitCode: Number(input.exitCode),
    startedAt: String(input.startedAt),
    durationMs: Number(input.durationMs),
    logPath: String(input.logPath),
    ...(input.terminationEvidence ? { terminationEvidence: input.terminationEvidence } : {}),
  };
}

function mergeCandidateRecordPath(stateDir, projectId, prNumber) {
  return path.join(ciFallbackDirectory(stateDir, projectId), `pr-${Number(prNumber)}.json`);
}

function diagnosisRecordPath(stateDir, projectId, prNumber) {
  return path.join(ciFallbackDirectory(stateDir, projectId), `pr-${Number(prNumber)}-base-diagnosis.json`);
}

function readMergeCandidateRecord(stateDir, projectId, prNumber) {
  return readJson(mergeCandidateRecordPath(stateDir, projectId, prNumber));
}

function readDiagnosisRecord(stateDir, projectId, prNumber) {
  return readJson(diagnosisRecordPath(stateDir, projectId, prNumber));
}

function writeMergeCandidateRecord(stateDir, projectId, record) {
  durableWriteJson(mergeCandidateRecordPath(stateDir, projectId, record.prNumber), record);
  return mergeCandidateRecordPath(stateDir, projectId, record.prNumber);
}

function writeDiagnosisRecord(stateDir, projectId, record) {
  durableWriteJson(diagnosisRecordPath(stateDir, projectId, record.prNumber), record);
  return diagnosisRecordPath(stateDir, projectId, record.prNumber);
}

function newLogIdentity(stateDir, projectId, prNumber, headOid) {
  return path.join(ciFallbackDirectory(stateDir, projectId), "logs", `pr-${Number(prNumber)}-${String(headOid).slice(0, 12)}-${Date.now()}.log`);
}

/**
 * The failed trusted-base/contract pair that suppresses new launches. While the same pair remains,
 * no Agent request is consumed; a changed base or contract clears it automatically.
 */
function baseBlockingRecordPath(stateDir, projectId) {
  return path.join(ciFallbackDirectory(stateDir, projectId), BASE_BLOCKING_FILE);
}

function writeBaseBlocking(stateDir, projectId, input) {
  const record = {
    version: RECORD_VERSION,
    baseRevision: String(input.baseRevision),
    command: String(input.command),
    reason: String(input.reason || "base_verification_failed"),
    failedAt: new Date().toISOString(),
    prNumber: Number(input.prNumber),
  };
  durableWriteJson(baseBlockingRecordPath(stateDir, projectId), record);
  return record;
}

function clearBaseBlocking(stateDir, projectId) {
  try { fs.rmSync(baseBlockingRecordPath(stateDir, projectId)); } catch {}
}

/** The stored base-blocking record, or null when none stands. Never changes the store. */
function readBaseBlocking(stateDir, projectId) {
  const record = readJson(baseBlockingRecordPath(stateDir, projectId));
  if (!record || typeof record !== "object" || record.version !== RECORD_VERSION) return null;
  return record;
}

/**
 * Whether base blocking still applies. The stored pair is compared with the caller-observed base
 * revision and current contract command; any difference reports the record as stale. Reads only.
 */
function observeBaseBlocking(stateDir, projectId, observed) {
  const record = readBaseBlocking(stateDir, projectId);
  if (!record) return { active: false };
  // An unobservable command proves nothing about a contract change, so it never clears the block.
  const commandUnchanged = observed.command === undefined
    || String(record.command) === String(observed.command);
  const active = sameOid(record.baseRevision, String(observed.baseRevision || ""))
    && commandUnchanged;
  return active ? { active: true, record } : { active: false, stale: true };
}

/** Observes base blocking and clears a stale record. The only reader that also writes. */
function evaluateBaseBlocking(stateDir, projectId, observed) {
  const observation = observeBaseBlocking(stateDir, projectId, observed);
  if (observation.stale) {
    clearBaseBlocking(stateDir, projectId);
    return { active: false, clearedStale: true };
  }
  return observation;
}

/** Repair-episode bookkeeping: at most one automatic repair until a human Agent request resets it. */
function episodeRecordPath(stateDir, projectId, prNumber) {
  return path.join(ciFallbackDirectory(stateDir, projectId), `episode-pr-${Number(prNumber)}.json`);
}

function readRepairEpisode(stateDir, projectId, prNumber) {
  return readJson(episodeRecordPath(stateDir, projectId, prNumber)) || null;
}

function writeRepairEpisode(stateDir, projectId, episode) {
  const next = { ...episode, version: RECORD_VERSION, updatedAt: new Date().toISOString() };
  durableWriteJson(episodeRecordPath(stateDir, projectId, episode.prNumber), next);
  return next;
}

function episodeKeyFor(repository, prNumber, policyBaseRevision, contractCommand) {
  // Episode identity is independent of the changed head: within one base/command pair the episode
  // persists across repaired heads until a human Agent request resets it.
  const identity = [repository, prNumber, policyBaseRevision, contractCommand].join("|");
  return `cifb-${crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16)}`;
}

module.exports = {
  buildVerificationRecord,
  ciFallbackDirectory,
  clearBaseBlocking,
  diagnosisRecordPath,
  episodeKeyFor,
  evaluateBaseBlocking,
  observeBaseBlocking,
  readBaseBlocking,
  mergeCandidateRecordPath,
  newLogIdentity,
  readDiagnosisRecord,
  readMergeCandidateRecord,
  readRepairEpisode,
  writeBaseBlocking,
  writeDiagnosisRecord,
  writeMergeCandidateRecord,
  writeRepairEpisode,
};
