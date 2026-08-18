const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { processStartIdentity } = require("./enablement-lock.cjs");
const { tryFlock: tryFlockWith } = require("./kernel-file-lock.cjs");

// Tokens retain the open file description on which the kernel flock lives.
// The operating system releases these descriptors on process exit, so a dead
// Automation host cannot leave execution ownership behind in a JSON file.
const heldLocks = new Map();

function readOwner(lockPath) {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return value && Number.isInteger(value.pid) && value.pid > 0 && value.released !== true ? value : null;
  } catch {
    return null;
  }
}

function tryFlock(fd) {
  return tryFlockWith(fd, spawnSync);
}

function preflightSchedulerLockCapability(options = {}) {
  const makeTemp = options.mkdtempSync || fs.mkdtempSync;
  const remove = options.rmSync || fs.rmSync;
  const run = options.spawnSync || spawnSync;
  const root = makeTemp(require("node:path").join(require("node:os").tmpdir(), "deadloop-flock-preflight-"));
  const lockPath = require("node:path").join(root, "capability.lock");
  const fd = fs.openSync(lockPath, "a+", 0o600);
  try {
    let acquired;
    try { acquired = tryFlockWith(fd, run); } catch (error) {
      throw new Error(`deadloop requires a compatible flock executable (usually util-linux): ${error.message}`);
    }
    if (!acquired) throw new Error("deadloop requires flock support for nonblocking file-descriptor locks");
    const contender = run("flock", ["--nonblock", lockPath, "true"], { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
    if (contender.error) throw new Error(`deadloop requires a compatible flock executable (usually util-linux): ${contender.error.message}`);
    if (contender.status !== 1) {
      throw new Error("deadloop requires flock support for nonblocking file-descriptor locks (normally provided by util-linux)");
    }
  } finally {
    fs.closeSync(fd);
    remove(root, { recursive: true, force: true });
  }
}

function writeMetadata(fd, metadata) {
  const text = JSON.stringify(metadata);
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, text, 0, "utf8");
  fs.fsyncSync(fd);
}

function ownerIsLive(owner) {
  if (!owner?.startIdentity) return false;
  try { process.kill(owner.pid, 0); } catch (error) { if (!error || error.code !== "EPERM") return false; }
  return processStartIdentity(owner.pid) === owner.startIdentity;
}

function acquireSchedulerLock(lockPath, metadata, hooks = {}) {
  const existingOwner = readOwner(lockPath);
  if (ownerIsLive(existingOwner)) {
    return { acquired: false, owner: existingOwner.pid, lockPath, token: null };
  }
  const fd = fs.openSync(lockPath, "a+", 0o600);
  try {
    if (!tryFlock(fd)) {
      fs.closeSync(fd);
      return { acquired: false, owner: readOwner(lockPath)?.pid || null, lockPath, token: null };
    }
    const token = crypto.randomUUID();
    hooks.beforePublish?.();
    writeMetadata(fd, { ...metadata, pid: process.pid, startIdentity: processStartIdentity(process.pid), token });
    heldLocks.set(token, { fd, lockPath });
    return { acquired: true, owner: process.pid, lockPath, token };
  } catch (error) {
    try { fs.closeSync(fd); } catch {}
    throw error;
  }
}

function releaseSchedulerLock(lockPath, token) {
  const held = heldLocks.get(token);
  if (!held || held.lockPath !== lockPath) return;
  // Remove the pathname while this host still owns the inode, then close the
  // descriptor. A contender can create the next inode only after release has
  // begun, and this owner performs no later unlink that could delete it.
  try {
    try { fs.unlinkSync(lockPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  } finally {
    heldLocks.delete(token);
    fs.closeSync(held.fd);
  }
}

module.exports = { acquireSchedulerLock, preflightSchedulerLockCapability, readOwner, releaseSchedulerLock };
