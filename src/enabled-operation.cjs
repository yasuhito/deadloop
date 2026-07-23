const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOwner(lockPath) {
  try {
    return Number(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid);
  } catch {
    return 0;
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

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

function assertEnabled(project) {
  try {
    const identities = originIdentities(project.repoPath);
    if (identities.length === 0 || identities.some((identity) => identity !== project.githubRepo)) throw new Error("origin identity mismatch");
    const state = JSON.parse(fs.readFileSync(path.join(project.stateDir, "enabled-projects.json"), "utf8"));
    const enabled = state.projects.find((candidate) =>
      candidate && path.resolve(candidate.repoPath) === path.resolve(project.repoPath) && candidate.githubRepo === project.githubRepo && candidate.enabled !== false,
    );
    if (enabled) return;
  } catch {}
  throw new Error("deadloop is disabled for this repository");
}

function withEnabledProjectLock(project, operation) {
  const lockPath = path.join(project.stateDir, "enabled-projects.json.lock");
  fs.mkdirSync(project.stateDir, { recursive: true });
  for (let attempt = 0; attempt < 1200; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      } finally {
        fs.closeSync(fd);
      }
      try {
        assertEnabled(project);
        return operation();
      } finally {
        try { fs.unlinkSync(lockPath); } catch {}
      }
    } catch (error) {
      if (error && error.code !== "EEXIST") throw error;
      const owner = readOwner(lockPath);
      if (!isPidAlive(owner)) {
        try { fs.unlinkSync(lockPath); } catch {}
        continue;
      }
      sleep(25);
    }
  }
  throw new Error("enablement state is busy; operation stopped");
}

module.exports = { assertEnabled, withEnabledProjectLock };
