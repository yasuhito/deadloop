const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

function processStartIdentity(pid, hooks = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    const stat = (hooks.readFileSync || fs.readFileSync)(`/proc/${pid}/stat`, "utf8");
    const fieldsAfterCommand = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (fieldsAfterCommand[19]) return fieldsAfterCommand[19];
  } catch {}

  const platform = hooks.platform || process.platform;
  const command = platform === "win32" ? "powershell.exe" : "ps";
  const args = platform === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`]
    : ["-o", "lstart=", "-p", String(pid)];
  try {
    const result = (hooks.spawnSync || spawnSync)(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const identity = result.status === 0 ? String(result.stdout || "").trim() : "";
    return identity ? `${platform}:${identity}` : "";
  } catch {
    return "";
  }
}

function isLockOwnerAlive(owner) {
  if (!owner?.startIdentity) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (!error || error.code !== "EPERM") return false;
  }
  return processStartIdentity(owner.pid) === owner.startIdentity;
}

function readMetadata(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && Number.isInteger(value.pid) && value.pid > 0 && typeof value.token === "string" && value.token ? value : null;
  } catch {
    return null;
  }
}

function sameFile(left, right) {
  try {
    const a = fs.statSync(left, { bigint: true });
    const b = fs.statSync(right, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function releaseOwned(lockPath, token) {
  if (readMetadata(lockPath)?.token !== token) return;
  try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

const MALFORMED_LOCK_GRACE_MS = 1_000;

function isOldMalformedLock(file) {
  if (readMetadata(file)) return false;
  try {
    return Date.now() - fs.statSync(file).mtimeMs >= MALFORMED_LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

function clearReclaimRemnant(lockPath) {
  const claimPath = `${lockPath}.reclaim`;
  if (!fs.existsSync(claimPath)) return;
  // A claim for a different inode can only describe an owner that has already
  // been replaced. Retiring it is safe: that reclaimer's inode checks prevent
  // it from unlinking the replacement lock.
  try { fs.unlinkSync(claimPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

function reclaimStale(lockPath, hooks = {}) {
  const claimPath = `${lockPath}.reclaim`;
  clearReclaimRemnant(lockPath);
  try {
    fs.linkSync(lockPath, claimPath);
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ENOENT") return false;
    throw error;
  }
  try {
    const owner = readMetadata(claimPath);
    if ((!owner && !isOldMalformedLock(claimPath)) || (owner && isLockOwnerAlive(owner)) || !sameFile(lockPath, claimPath)) return false;
    hooks.beforeStaleUnlink?.();
    if (!sameFile(lockPath, claimPath)) return false;
    if (owner ? readMetadata(lockPath)?.token !== owner.token : !isOldMalformedLock(lockPath)) return false;
    fs.unlinkSync(lockPath);
    return true;
  } finally {
    try { fs.unlinkSync(claimPath); } catch {}
  }
}

function tryAcquire(lockPath, hooks = {}) {
  clearReclaimRemnant(lockPath);
  const token = crypto.randomUUID();
  const pendingPath = `${lockPath}.${process.pid}.${token}.pending`;
  try {
    const fd = fs.openSync(pendingPath, "wx");
    try {
      const startIdentity = processStartIdentity(process.pid);
      if (!startIdentity) throw new Error("process start identity is unavailable");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startIdentity, token }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    hooks.beforePublish?.();
    fs.linkSync(pendingPath, lockPath);
    return { lockPath, token };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    reclaimStale(lockPath, hooks);
    return null;
  } finally {
    try { fs.unlinkSync(pendingPath); } catch {}
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function acquireLockSync(lockPath, options = {}) {
  for (let attempt = 0; attempt < (options.attempts || 1200); attempt++) {
    const lock = tryAcquire(lockPath, options.hooks);
    if (lock) return lock;
    sleep(options.delayMs || 25);
  }
  throw new Error(options.busyMessage || "enablement state is busy");
}

async function acquireLock(lockPath, options = {}) {
  for (let attempt = 0; attempt < (options.attempts || 1200); attempt++) {
    const lock = tryAcquire(lockPath, options.hooks);
    if (lock) return lock;
    await new Promise((resolve) => setTimeout(resolve, options.delayMs || 25));
  }
  throw new Error(options.busyMessage || "enablement state is busy");
}

module.exports = { acquireLock, acquireLockSync, processStartIdentity, reclaimStale, releaseOwned };
