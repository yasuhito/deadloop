// Base verification blocking currency (ADR 0030).
//
// A failed base/contract pair suppresses new agent launches without consuming Agent requests. The
// block clears itself automatically when the base revision or the resolved CI-equivalent contract
// changes; this is where the store's persisted pair meets the live trusted-base contract.

const store = require("./ci-fallback-store.cjs");
const { observeTrustedBaseContract } = require("./ci-equivalent-contract.cts") as {
  observeTrustedBaseContract: (input: { projectRepo: string; baseRevision: string }) => Record<string, any>;
};

function observedBaseRevision(repoPath: string, baseBranch: string, runText: (args: string[]) => string): string | undefined {
  try {
    return runText(["git", "-C", repoPath, "rev-parse", "--verify", `${baseBranch}^{commit}`]).trim();
  } catch {
    return undefined;
  }
}

/**
 * Evaluate and settle base blocking for one project. Returns the active record with its reason when
 * the same failed base/contract pair still stands, or `{ active: false }` after clearing a stale
 * pair or finding none.
 */
function evaluateProjectBaseBlocking(input: {
  stateDir: string;
  projectId: string;
  repoPath: string;
  baseBranch?: string;
}): { active: boolean; reason?: string; record?: Record<string, unknown> } {
  const baseRevision = observedBaseRevision(
    input.repoPath,
    input.baseBranch || "origin/main",
    (args) => {
      const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
      return execFileSync("git", args.slice(1), { encoding: "utf8" });
    },
  );
  if (!baseRevision) return { active: false };
  const contract = observeTrustedBaseContract({ projectRepo: input.repoPath, baseRevision });
  // An unresolvable contract proves nothing about a contract change: while the same failed base
  // stands, the block stays (fail-closed) and only a changed base or resolvable contract clears it.
  const evaluation = store.evaluateBaseBlocking(input.stateDir, input.projectId, {
    baseRevision,
    ...(contract.status === "resolved" ? { command: String((contract as Record<string, unknown>).command) } : {}),
  });
  return evaluation.active
    ? { active: true, reason: String(evaluation.record?.reason || "base_verification_failed"), record: evaluation.record }
    : { active: false, ...(evaluation.clearedStale ? { clearedStale: true } : {}) };
}

module.exports = { evaluateProjectBaseBlocking };
