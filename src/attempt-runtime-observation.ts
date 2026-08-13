/**
 * The execution-runtime boundary for one attempt's checkout.
 *
 * Every caller that asks whether an attempt is still running has to read the same runtime records
 * the same way. Resolving a checkout by string equality would call a live agent working inside the
 * checkout stopped, and a symlinked worktree stopped as well, so the comparison is canonical here
 * and nowhere else.
 */

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

type JsonObject = Record<string, any>;

export type AttemptRuntimeRunner = {
  listWorkspaces(): JsonObject[];
  listAgents(): JsonObject[];
  listWorktrees(projectRepo: string): JsonObject[];
};

function canonicalPath(value: unknown): string {
  const resolved = path.resolve(String(value || ""));
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function canonicalPathContains(root: unknown, candidate: unknown): boolean {
  const canonicalRoot = canonicalPath(root);
  const canonicalCandidate = canonicalPath(candidate);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Nothing of the attempt, and nothing else, occupies its checkout. */
function checkoutIsIdle(runner: AttemptRuntimeRunner, record: JsonObject): boolean {
  const onCheckout = (value: unknown) => canonicalPath(value) === canonicalPath(record.worktreePath);
  const relatedAgent = (agent: JsonObject) => String(agent.name || "") === String(record.agentName || "")
    || String(agent.paneId || "") === String(record.rootPaneId || "")
    || canonicalPathContains(record.worktreePath, agent.cwd);
  return runner.listWorkspaces().every((workspace) => !onCheckout(workspace.worktreePath))
    && runner.listAgents().every((agent) => !relatedAgent(agent));
}

/** The attempt's checkout is still on disk as a worktree of the project, so its evidence survives. */
function worktreeIsRetained(runner: AttemptRuntimeRunner, record: JsonObject, projectRepo: string): boolean {
  if (!projectRepo) return false;
  return runner.listWorktrees(projectRepo)
    .some((worktree) => canonicalPath(worktree.path) === canonicalPath(record.worktreePath));
}

module.exports = { canonicalPath, canonicalPathContains, checkoutIsIdle, worktreeIsRetained };
