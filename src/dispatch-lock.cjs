const fs = require("node:fs");
const path = require("node:path");
const { tryFlock } = require("./kernel-file-lock.cjs");

// GitHub node IDs are opaque but always url-safe, so the directory stays readable to an operator
// inspecting the state directory. Anything else is refused rather than sanitized, because a lock
// path built from an unvalidated identifier is a lock somebody else can be made to take.
const REPOSITORY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TARGET_KINDS = new Set(["issue", "pull-request"]);

/** Where one target's dispatch lock lives. */
function dispatchLockPath(input) {
  const repositoryId = String(input.repositoryId || "");
  if (!REPOSITORY_ID.test(repositoryId)) throw new Error("dispatch lock requires a GitHub repository ID");
  const kind = String(input.target?.kind || "");
  const number = Number(input.target?.number);
  if (!TARGET_KINDS.has(kind) || !Number.isInteger(number) || number < 1) {
    throw new Error("dispatch lock requires an issue or pull-request number");
  }
  return path.join(input.stateDir, "locks", repositoryId, `${kind}-${number}.lock`);
}

/**
 * Runs one dispatch decision while this process holds the only lock for its target.
 *
 * Returns `null` when another holder has the target. A refused lock is not a stop: the target
 * belongs to somebody else for this tick and the next tick can select it again, so callers skip it
 * rather than block or report a failure. Only the locking mechanism being unusable throws.
 *
 * The lock covers the decision, never the attempt it starts. An agent runs inside an execution
 * runtime outside this process tree, so the kernel would release this descriptor while that agent
 * kept working. Whether an attempt is still running is the execution runtime's answer alone, and
 * binding the two together would rebuild the two-authority problem this lock exists to avoid.
 */
function withDispatchLock(input, decide, ops = {}) {
  const lockPath = dispatchLockPath(input);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(lockPath, "a+", 0o600);
  try {
    if (!tryFlock(fd, ops.run)) return null;
    return decide();
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { dispatchLockPath, withDispatchLock };
