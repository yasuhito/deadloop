const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// @ts-expect-error Node loads this CommonJS-style TypeScript module with built-in type stripping.
const { normalizeEnablementStateValue } = require("./enablement-state.ts");
const { acquireLockSync, releaseOwned } = require("./enablement-lock.cjs");
const { currentDisableGeneration } = require("./disable-generation.cjs");

function githubRepoFromRemote(remote) {
  const match = /^(?:git@github\.com:|https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(String(remote || ""));
  return match ? match[1] : "";
}

const MAX_GUARDED_OPERATION_MS = 25_000;
const MAX_ORIGIN_IDENTITIES = 8;

function originIdentities(repoPath) {
  const urls = [];
  for (const mode of [[], ["--push"]]) {
    const result = childProcess.spawnSync("git", ["-C", repoPath, "remote", "get-url", ...mode, "--all", "origin"], {
      encoding: "utf8",
      timeout: MAX_GUARDED_OPERATION_MS,
    });
    if (result.status !== 0) return [];
    urls.push(...String(result.stdout || "").split(/\r?\n/).filter(Boolean));
  }
  const identities = [...new Set(urls.map(githubRepoFromRemote))];
  return identities.length <= MAX_ORIGIN_IDENTITIES ? identities : [];
}

function githubRepositoryId(identity) {
  if (!identity) return "";
  const result = childProcess.spawnSync("gh", ["repo", "view", identity, "--json", "id"], {
    encoding: "utf8",
    timeout: MAX_GUARDED_OPERATION_MS,
  });
  if (result.status !== 0) return "";
  try {
    return String(JSON.parse(result.stdout || "{}").id || "");
  } catch {
    return "";
  }
}

function canonicalStateDir() {
  const configDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.resolve(configDir, "deadloop");
}

function assertCanonicalStateDir(stateDir) {
  if (path.resolve(stateDir) !== canonicalStateDir()) throw new Error("deadloop state directory is not canonical");
}

function assertLocallyEnabled(project) {
  assertCanonicalStateDir(project.stateDir);
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(project.stateDir, "enabled-projects.json"), "utf8"));
    const state = normalizeEnablementStateValue(raw);
    if (!state) throw new Error("invalid enablement schema");
    const enabled = state.projects.find((candidate) =>
      candidate.repoPath === path.resolve(project.repoPath) && candidate.githubRepo === project.githubRepo && candidate.enabled !== false,
    );
    if (enabled) {
      if (project.enabledAt !== undefined && enabled.enabledAt !== project.enabledAt) {
        throw new Error("deadloop enablement generation changed; operation stopped");
      }
      if (currentDisableGeneration(project.stateDir, project.repoPath) !== enabled.disableGeneration) {
        throw new Error("deadloop disable was requested for this repository");
      }
      return enabled;
    }
  } catch {}
  throw new Error("deadloop is disabled for this repository");
}

function assertEnabled(project) {
  const enabled = assertLocallyEnabled(project);
  const identities = originIdentities(project.repoPath);
  const mutationIdentities = [...new Set([enabled.githubRepo, ...identities])];
  if (
    identities.length === 0
    || mutationIdentities.some((identity) => githubRepositoryId(identity) !== enabled.githubRepositoryId)
  ) throw new Error("deadloop is disabled for this repository");
  return enabled;
}

function withEnabledProjectLock(project, operation, options = {}) {
  assertCanonicalStateDir(project.stateDir);
  if (!Number.isFinite(project.enabledAt)) throw new Error("deadloop enablement generation is required");
  const lockPath = path.join(project.stateDir, "enabled-projects.json.lock");
  fs.mkdirSync(project.stateDir, { recursive: true });
  const lock = acquireLockSync(lockPath, { ...options, busyMessage: "enablement state is busy; operation stopped" });
  try {
    const enabled = assertEnabled(project);
    const recheck = () => assertLocallyEnabled(project);
    options.afterAuthorization?.();
    return operation(enabled, recheck);
  } finally {
    releaseOwned(lockPath, lock.token);
  }
}

module.exports = {
  MAX_GUARDED_OPERATION_MS,
  MAX_ORIGIN_IDENTITIES,
  assertEnabled,
  assertLocallyEnabled,
  canonicalStateDir,
  withEnabledProjectLock,
};
