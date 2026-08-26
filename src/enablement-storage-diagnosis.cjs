/**
 * Local diagnosis for enablement stops caused by observed storage exhaustion (ADR 0018).
 *
 * Enablement owns no Issue, PR, or Agent request, so an `ENOSPC`/`EDQUOT` observed by one of its
 * deterministic host operations stays a purely local failure: execution permission is never
 * recorded, no GitHub comment or label is touched, and retained verification worktrees are left
 * untouched. The stop records local evidence that `/deadloop-doctor` shows until the next
 * successful enablement clears it. Subprocess stderr and pane text never classify the cause.
 */

const fs = require("node:fs");
const path = require("node:path");

const { observedStorageExhaustionCode } = require("./storage-exhaustion.cjs");

function evidencePath(stateDir) {
  return path.join(stateDir, "enablement-storage-exhaustion.json");
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Best-effort local evidence record. Returns `{ ok, path }`; `ok` stays false when even this
 * diagnostic write fails, so the command output never points at evidence that does not exist.
 */
function recordEnablementStorageExhaustion(stateDir, evidence) {
  const file = evidencePath(stateDir);
  try {
    writeJsonFile(file, {
      code: String(evidence.code),
      detail: String(evidence.detail || ""),
      ...(evidence.repoPath ? { repoPath: path.resolve(evidence.repoPath) } : {}),
      ...(evidence.githubRepo ? { githubRepo: evidence.githubRepo } : {}),
      observedAt: Number(evidence.observedAt) || Date.now(),
    });
    return { ok: true, path: file };
  } catch {
    return { ok: false, path: file };
  }
}

function validEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const code = String(value.code || "");
  if (observedStorageExhaustionCode({ code }) === null) return null;
  if (!Number.isFinite(Number(value.observedAt))) return null;
  return {
    code,
    detail: typeof value.detail === "string" ? value.detail : "",
    ...(typeof value.repoPath === "string" && value.repoPath ? { repoPath: value.repoPath } : {}),
    ...(typeof value.githubRepo === "string" && value.githubRepo ? { githubRepo: value.githubRepo } : {}),
    observedAt: Number(value.observedAt),
  };
}

/** The validated retained evidence, or null when absent or malformed. */
function readEnablementStorageExhaustion(stateDir) {
  try {
    return validEvidence(JSON.parse(fs.readFileSync(evidencePath(stateDir), "utf8")));
  } catch {
    return null;
  }
}

function clearEnablementStorageExhaustion(stateDir) {
  fs.rmSync(evidencePath(stateDir), { force: true });
}

/**
 * The full command result for a failed enablement. A deterministic host operation whose error
 * object carries `ENOSPC`/`EDQUOT` records local evidence and names the storage-exhaustion stop;
 * every other failure keeps its exact message without classification.
 */
function formatEnablementFailureMessage(error, context = {}) {
  const detail = String(error?.message || error);
  if (!observedStorageExhaustionCode(error)) return `deadloop was not enabled: ${detail}`;
  const code = observedStorageExhaustionCode(error);
  const recorded = recordEnablementStorageExhaustion(context.stateDir, {
    code,
    detail,
    repoPath: context.repoPath,
    githubRepo: context.githubRepo,
    observedAt: Date.now(),
  });
  return [
    `deadloop was not enabled: enablement stopped because a deterministic host operation ran out of local storage (${code}).`,
    "Execution permission was not recorded, and no GitHub issue, pull request, or agent workflow label was changed.",
    "Retained verification worktrees were left untouched.",
    "Free storage capacity, then run /deadloop-enable again.",
    ...(recorded.ok ? [`Local evidence: ${recorded.path}`] : []),
  ].join(" ");
}

module.exports = {
  clearEnablementStorageExhaustion,
  enablementStorageExhaustionPath: evidencePath,
  formatEnablementFailureMessage,
  readEnablementStorageExhaustion,
  recordEnablementStorageExhaustion,
};
