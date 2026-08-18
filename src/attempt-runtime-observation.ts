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

import type { AttemptAgentRunner, AttemptRuntimeRunner } from "./attempt-runtime-observation-types";

type JsonObject = Record<string, any>;

type AttemptRuntimeObservation =
  | { kind: "live_matching_owner" }
  | { kind: "stopped_owned" }
  | { kind: "ambiguous" };

type AttemptLivenessObservation =
  | { kind: "live" }
  | { kind: "stopped" }
  | { kind: "ambiguous" };

/** The statuses that say an agent has finished its turn and is no longer acting. */
const TERMINAL_AGENT_STATUSES = ["done", "idle", "failed", "stopped"];

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

/** The attempt's checkout is still on disk as a worktree of the project, so its evidence survives. */
function worktreeIsRetained(runner: AttemptRuntimeRunner, record: JsonObject, projectRepo: string): boolean {
  if (!projectRepo) return false;
  return runner.listWorktrees(projectRepo)
    .some((worktree) => canonicalPath(worktree.path) === canonicalPath(record.worktreePath));
}

function closeReceiptPath(record: JsonObject): string {
  return path.join(record.runDir, "authority-release-started.json");
}

/** The host wrote this receipt before closing the workspace it owned, so a closed workspace is expected. */
function validCloseReceipt(record: JsonObject): boolean {
  try {
    const receipt = JSON.parse(fs.readFileSync(closeReceiptPath(record), "utf8"));
    return receipt?.schemaVersion === 1 && receipt?.attemptId === record.attemptId
      && receipt?.workspaceId === record.workspaceId && receipt?.worktreePath === record.worktreePath;
  } catch { return false; }
}

/** Every agent the runtime lists that could be this attempt: its name, its pane, or its checkout. */
function relatedAgents(agents: JsonObject[], record: JsonObject): JsonObject[] {
  return agents.filter((agent) => String(agent.name || "") === String(record.agentName || "")
    || String(agent.paneId || "") === String(record.rootPaneId || "")
    || canonicalPathContains(record.worktreePath, agent.cwd));
}

function livenessFromAgents(agents: JsonObject[], record: JsonObject): AttemptLivenessObservation {
  const related = relatedAgents(agents, record);
  if (related.length === 0) return { kind: "stopped" };
  const owned = related.filter((agent) => String(agent.name || "") === String(record.agentName || "")
    && String(agent.paneId || "") === String(record.rootPaneId || "")
    && canonicalPathContains(record.worktreePath, agent.cwd));
  // Anything in the checkout that is not this attempt's own agent could be the attempt under another
  // name, so the runtime is not describing one attempt and the answer is not readable.
  if (owned.length !== related.length || owned.length > 1) return { kind: "ambiguous" };
  const status = String(owned[0].status || "").toLowerCase();
  if (status === "working") return { kind: "live" };
  return TERMINAL_AGENT_STATUSES.includes(status) ? { kind: "stopped" } : { kind: "ambiguous" };
}

/**
 * Whether the agent this journal names is still working, asked of the execution runtime and nothing
 * else. ADR 0020 leaves this the only authority on the question: the journal's phase, its claim
 * marker, and the receipts on disk are evidence, and evidence never grants permission to act. A
 * runtime that cannot be reached throws, and every caller reads that as unobservable, never as
 * stopped.
 */
function observeAttemptLiveness(runner: AttemptAgentRunner, record: JsonObject): AttemptLivenessObservation {
  return livenessFromAgents(runner.listAgents(), record);
}

/**
 * Liveness plus the workspace identity a caller needs before it closes what it observed: the
 * attempt's own workspace is the only one on its checkout and holds one tab and one pane, or the
 * workspace is already closed and left the receipt that says so. Callers that only ask whether the
 * attempt is running want `observeAttemptLiveness` instead — this observation refuses a checkout it
 * cannot resolve to exactly one workspace, which is a precondition for closing it, not for running.
 */
function observeAttemptRuntime(runner: AttemptRuntimeRunner, record: JsonObject, projectRepo = ""): AttemptRuntimeObservation {
  const workspaces = runner.listWorkspaces();
  const agents = runner.listAgents();
  const checkoutWorkspaces = workspaces.filter((workspace) => canonicalPath(workspace.worktreePath) === canonicalPath(record.worktreePath));
  const matchingWorkspaces = checkoutWorkspaces.filter((workspace) => String(workspace.workspaceId || "") === String(record.workspaceId || ""));
  if (matchingWorkspaces.length === 0 && validCloseReceipt(record) && projectRepo) {
    const retained = worktreeIsRetained(runner, record, projectRepo);
    return retained && checkoutWorkspaces.length === 0 && relatedAgents(agents, record).length === 0
      ? { kind: "stopped_owned" } : { kind: "ambiguous" };
  }
  if (matchingWorkspaces.length !== 1 || checkoutWorkspaces.length !== 1
    || Number(matchingWorkspaces[0].tabCount) !== 1 || Number(matchingWorkspaces[0].paneCount) !== 1) return { kind: "ambiguous" };
  const liveness = livenessFromAgents(agents, record);
  if (liveness.kind === "ambiguous") return { kind: "ambiguous" };
  return liveness.kind === "live" ? { kind: "live_matching_owner" } : { kind: "stopped_owned" };
}

module.exports = { canonicalPath, canonicalPathContains, closeReceiptPath, observeAttemptLiveness, observeAttemptRuntime };
