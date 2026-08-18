const { spawnSync } = require("node:child_process");

/**
 * Takes the kernel's advisory lock on an already open file description, without waiting.
 *
 * The lock lives on the descriptor rather than on the pathname, which is the property deadloop
 * relies on everywhere it excludes: the operating system releases it when the holding process
 * exits, so a dead host cannot leave exclusion behind in a file somebody has to clean up.
 *
 * `flock(1)` takes the descriptor as fd 3 and exits immediately; the lock survives that child
 * because the description it locked is the caller's own. A refusal is reported as `false`, and
 * anything that means the mechanism itself is unusable throws, because deadloop cannot exclude
 * anything without it.
 */
function tryFlock(fd, run = spawnSync) {
  const result = run("flock", ["--nonblock", "3"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe", fd],
  });
  if (result.error) throw new Error(`OS file locking is unavailable: ${result.error.message}`);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(String(result.stderr || "flock failed").trim());
}

module.exports = { tryFlock };
