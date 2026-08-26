const fs = require("node:fs");
const path = require("node:path");
const { currentDisableGeneration } = require("./disable-generation.cjs");

// A one-shot scheduler tick needs the same guarded mutations as a continuous host, but it must
// never persist enablement. The scoped execution authorization is a state-file record that makes
// every existing enabled-operation gate accept exactly this one call: it is issued under the
// repository scheduler lock, rechecked before each guarded mutation through the ordinary
// disable-generation and expiry checks, and removed when the one-shot command finishes. A crash
// cannot leave standing authority behind because the record expires on its own.
const ONE_SHOT_EXECUTION_TTL_MS = 30 * 60_000;

function oneShotExecutionPath(stateDir) {
  return path.join(stateDir, "one-shot-execution.json");
}

function issueOneShotExecution(project, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? ONE_SHOT_EXECUTION_TTL_MS;
  if (!project.stateDir || !project.repoPath || !project.githubRepo) {
    throw new Error("a one-shot execution requires the repository identity and state directory");
  }
  if (!project.githubRepositoryId || !project.automationLogin) {
    throw new Error("a one-shot execution requires the GitHub repository id and Automation host login");
  }
  if (!Number.isFinite(project.enabledAt)) {
    throw new Error("a one-shot execution requires an execution generation");
  }
  const record = {
    repoPath: path.resolve(project.repoPath),
    githubRepo: project.githubRepo,
    githubRepositoryId: project.githubRepositoryId,
    automationLogin: project.automationLogin,
    enabledAt: project.enabledAt,
    disableGeneration: currentDisableGeneration(project.stateDir, project.repoPath),
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
  };
  fs.mkdirSync(project.stateDir, { recursive: true });
  const finalPath = oneShotExecutionPath(project.stateDir);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(record));
  fs.renameSync(tmpPath, finalPath);
  return record;
}

/**
 * Returns the scoped execution record when it still authorizes this repository right now, or null.
 * Every check mirrors `assertLocallyEnabled`: path and repository identity, expiry, and the
 * per-repository disable generation so a mid-tick `/deadloop-disable` revokes the next mutation.
 */
function readValidOneShotExecution(project, options = {}) {
  try {
    const record = JSON.parse(fs.readFileSync(oneShotExecutionPath(project.stateDir), "utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    if (record.repoPath !== path.resolve(project.repoPath)) return null;
    if (record.githubRepo !== project.githubRepo) return null;
    if (!Number.isSafeInteger(record.expiresAtMs)) return null;
    if ((options.nowMs ?? Date.now()) >= record.expiresAtMs) return null;
    if (currentDisableGeneration(project.stateDir, project.repoPath) !== record.disableGeneration) return null;
    if (
      project.enabledAt !== undefined
      && record.enabledAt !== project.enabledAt
    ) return null;
    return record;
  } catch {
    return null;
  }
}

function clearOneShotExecution(stateDir) {
  try {
    fs.rmSync(oneShotExecutionPath(stateDir), { force: true });
  } catch {}
}

module.exports = {
  ONE_SHOT_EXECUTION_PATH_NAME: path.basename(oneShotExecutionPath(".")),
  ONE_SHOT_EXECUTION_TTL_MS,
  clearOneShotExecution,
  issueOneShotExecution,
  readValidOneShotExecution,
};
