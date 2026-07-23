const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// @ts-expect-error Node loads this CommonJS-style TypeScript module with built-in type stripping.
const { normalizeEnablementStateValue } = require("./enablement-state.ts");
const { acquireLockSync, releaseOwned } = require("./enablement-lock.cjs");

function githubRepoFromRemote(remote) {
  const match = /^(?:git@github\.com:|https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(String(remote || ""));
  return match ? match[1] : "";
}

function originIdentities(repoPath) {
  const urls = [];
  for (const mode of [[], ["--push"]]) {
    const result = childProcess.spawnSync("git", ["-C", repoPath, "remote", "get-url", ...mode, "--all", "origin"], { encoding: "utf8" });
    if (result.status !== 0) return [];
    urls.push(...String(result.stdout || "").split(/\r?\n/).filter(Boolean));
  }
  return urls.map(githubRepoFromRemote);
}

const MAX_GUARDED_OPERATION_MS = 25_000;

function canonicalStateDir() {
  const configDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  return path.resolve(configDir, "deadloop");
}

function assertCanonicalStateDir(stateDir) {
  if (path.resolve(stateDir) !== canonicalStateDir()) throw new Error("deadloop state directory is not canonical");
}

function assertEnabled(project) {
  assertCanonicalStateDir(project.stateDir);
  try {
    const identities = originIdentities(project.repoPath);
    if (identities.length === 0 || identities.some((identity) => identity !== project.githubRepo)) throw new Error("origin identity mismatch");
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
      return enabled;
    }
  } catch {}
  throw new Error("deadloop is disabled for this repository");
}

function withEnabledProjectLock(project, operation, options = {}) {
  assertCanonicalStateDir(project.stateDir);
  if (!Number.isFinite(project.enabledAt)) throw new Error("deadloop enablement generation is required");
  const lockPath = path.join(project.stateDir, "enabled-projects.json.lock");
  fs.mkdirSync(project.stateDir, { recursive: true });
  const lock = acquireLockSync(lockPath, { ...options, busyMessage: "enablement state is busy; operation stopped" });
  try {
    assertEnabled(project);
    options.afterAuthorization?.();
    return operation();
  } finally {
    releaseOwned(lockPath, lock.token);
  }
}

module.exports = { MAX_GUARDED_OPERATION_MS, assertEnabled, canonicalStateDir, withEnabledProjectLock };
