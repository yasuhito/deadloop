/**
 * Brings an opened checkout to the revision its attempt is bound to.
 *
 * A linked worktree outlives the attempt that last used it, so the next attempt opens a checkout
 * sitting wherever the previous one stopped. Every role binds to an exact head, so handing over a
 * checkout that lags means the agent refuses before doing any work — a stop that looks like a
 * failure but is only stale local state.
 *
 * Advancing is deliberately the weakest operation that can close that gap. A fast-forward moves a
 * checkout that has nothing of its own; anything else — uncommitted work, commits only this
 * checkout holds — is evidence, and this module stops rather than discard it. There is no reset and
 * no clean here, by design.
 *
 * The fetch is trusted only for the bytes it brings, never for where it brought them from. A commit
 * identifier is a hash of its own content, so requiring the fetched branch tip to equal the exact
 * expected revision makes a wrong or hostile remote unable to substitute anything.
 */

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { hasUncommittedWork, UNCOMMITTED_WORK_STATUS_ARGS } = require("./agent-scratch-area.cjs");

type CommandResult = { status: number; stdout: string; stderr: string };

type CheckoutAlignmentOps = {
  run(args: string[], timeoutMs?: number): CommandResult;
};

type CheckoutAlignmentInput = {
  worktreePath: string;
  expectedHead: string;
  preservedHead?: string;
  remote: string;
  branch: string;
};

const MAX_ALIGNMENT_MS = 25_000;

function defaultRun(args: string[], timeoutMs?: number): CommandResult {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" }),
  });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function checked(ops: CheckoutAlignmentOps, args: string[], timeoutMs?: number): string {
  const result = ops.run(args, timeoutMs);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `command failed: ${args.join(" ")}`).trim());
  return result.stdout.trim();
}

function commitSha(value: unknown): string {
  const text = String(value || "").toLowerCase();
  return /^[0-9a-f]{40}$/.test(text) ? text : "";
}

/** The expected commit, fetched from the branch only when this checkout does not already hold it. */
function ensureExpectedCommit(input: CheckoutAlignmentInput, ops: CheckoutAlignmentOps, expectedHead: string): void {
  const git = (args: string[]) => ops.run(["git", "-C", input.worktreePath, ...args], MAX_ALIGNMENT_MS);
  if (git(["cat-file", "-e", `${expectedHead}^{commit}`]).status === 0) return;
  const fetch = git(["fetch", "--quiet", input.remote, `refs/heads/${input.branch}`]);
  if (fetch.status !== 0) {
    throw new Error(`checkout alignment could not fetch ${input.branch}: ${(fetch.stderr || fetch.stdout).trim()}`);
  }
  const fetched = commitSha(checked(ops, ["git", "-C", input.worktreePath, "rev-parse", "FETCH_HEAD"], MAX_ALIGNMENT_MS));
  if (fetched !== expectedHead) {
    throw new Error(`checkout alignment stopped: ${input.branch} does not carry ${expectedHead}`);
  }
}

/** Leaves the checkout on `expectedHead`, or on an explicitly proven descendant, or throws. */
function alignOpenedCheckout(input: CheckoutAlignmentInput, ops: CheckoutAlignmentOps = { run: defaultRun }): void {
  const expectedHead = commitSha(input.expectedHead);
  if (!expectedHead) throw new Error("checkout alignment requires a commit identifier");
  const git = (args: string[]) => checked(ops, ["git", "-C", input.worktreePath, ...args], MAX_ALIGNMENT_MS);

  if (commitSha(git(["rev-parse", "HEAD"])) === expectedHead) return;
  if (hasUncommittedWork(git(UNCOMMITTED_WORK_STATUS_ARGS))) {
    throw new Error("checkout alignment stopped: the checkout has uncommitted work");
  }

  ensureExpectedCommit(input, ops, expectedHead);
  const current = commitSha(git(["rev-parse", "HEAD"]));
  if (input.preservedHead !== undefined) {
    const preservedHead = commitSha(input.preservedHead);
    if (!preservedHead || current !== preservedHead) {
      throw new Error(`checkout alignment stopped: preserved head does not match ${current}`);
    }
    if (ops.run(["git", "-C", input.worktreePath, "merge-base", "--is-ancestor", expectedHead, current], MAX_ALIGNMENT_MS).status !== 0) {
      throw new Error(`checkout alignment stopped: preserved head ${current} does not descend from ${expectedHead}`);
    }
    return;
  }
  if (ops.run(["git", "-C", input.worktreePath, "merge-base", "--is-ancestor", current, expectedHead], MAX_ALIGNMENT_MS).status !== 0) {
    throw new Error(`checkout alignment stopped: cannot fast-forward ${current} to ${expectedHead}`);
  }
  git(["merge", "--ff-only", "--quiet", expectedHead]);
  // The merge reports success on its own terms; only the resulting head proves the attempt may run.
  const aligned = commitSha(git(["rev-parse", "HEAD"]));
  if (aligned !== expectedHead) throw new Error(`checkout alignment stopped: head is ${aligned} after fast-forward`);
}

module.exports = { alignOpenedCheckout };
