const crypto = require("node:crypto");
const fs = require("node:fs");

const { processStartIdentity, reclaimStale, releaseOwned } = require("./enablement-lock.cjs");

function readOwner(lockPath) {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    return value && Number.isInteger(value.pid) && value.pid > 0 ? value : null;
  } catch {
    return null;
  }
}

function acquireSchedulerLock(lockPath, metadata, hooks = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = crypto.randomUUID();
    const pendingPath = `${lockPath}.${process.pid}.${token}.pending`;
    try {
      const fd = fs.openSync(pendingPath, "wx");
      try {
        const startIdentity = processStartIdentity(process.pid);
        if (!startIdentity) throw new Error("process start identity is unavailable");
        fs.writeFileSync(fd, JSON.stringify({ ...metadata, pid: process.pid, startIdentity, token }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      hooks.beforePublish?.();
      fs.linkSync(pendingPath, lockPath);
      return { acquired: true, owner: process.pid, lockPath, token };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = readOwner(lockPath);
      if (!reclaimStale(lockPath, hooks)) {
        return { acquired: false, owner: owner?.pid || null, lockPath, token: null };
      }
    } finally {
      try { fs.unlinkSync(pendingPath); } catch {}
    }
  }
  return { acquired: false, owner: readOwner(lockPath)?.pid || null, lockPath, token: null };
}

function releaseSchedulerLock(lockPath, token) {
  releaseOwned(lockPath, token);
}

module.exports = { acquireSchedulerLock, readOwner, releaseSchedulerLock };
