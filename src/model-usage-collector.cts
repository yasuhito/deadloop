// Collects one attempt's normalized model-usage records into its state-directory ledger.
//
// The collector is observational: a failure here is recorded but never undoes a completion,
// push, handoff, or merge decision made elsewhere (CONTEXT.md "モデル使用記録"). It runs after
// the agent turn ends and before workspace closure so temporary worktree artifacts are still
// readable; the workspace-closure seam owns that ordering.

const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");

const { readAttemptRecord } = require("./attempt-lifecycle-runtime.cjs");
const { collectModelUsage, readPersistedRecordIds, usageLedgerFile } = require("./model-usage.cts");

import type { CollectionError, CollectorInput, NormalizedUsageRecord, SessionRoots } from "./model-usage-types";

/** Session-tree roots for the supported agent CLIs; overridable so tests can inject synthetic trees. */
function sessionRoots(env: NodeJS.ProcessEnv = process.env): SessionRoots {
  const home = os.homedir();
  const agentDir = env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
  return {
    ...(env.DEADLOOP_PI_SESSIONS_ROOT ? { pi: env.DEADLOOP_PI_SESSIONS_ROOT } : { pi: path.join(agentDir, "sessions") }),
    ...(env.DEADLOOP_OMP_SESSIONS_ROOT ? { omp: env.DEADLOOP_OMP_SESSIONS_ROOT } : { omp: path.join(home, ".omp", "agent", "sessions") }),
    ...(env.DEADLOOP_CLAUDE_PROJECTS_ROOT ? { claude: env.DEADLOOP_CLAUDE_PROJECTS_ROOT } : { claude: path.join(home, ".claude", "projects") }),
  };
}


function collectionErrorsFile(runDir: string): string {
  return path.join(runDir, "model-usage-errors.jsonl");
}

function recordCollectionError(runDir: string, error: unknown, now: Date): void {
  const entry: CollectionError = {
    collectedAt: now.toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
  try {
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(collectionErrorsFile(runDir), `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {}
}


/**
 * Reads the attempt journal, gathers every traceable model response from the configured
 * session trees plus worktree artifacts, and appends new records to `model-usage.jsonl`.
 * Returns the records written in this pass.
 */
function collectAttemptModelUsage(input: CollectorInput): { written: NormalizedUsageRecord[] } {
  const now = input.now || (() => new Date());
  const record = readAttemptRecord(input.runDir);
  if (!record.agent) throw new Error(`attempt ${record.attemptId} does not record its agent kind`);
  try {
    const roots = input.roots || sessionRoots();
    const result = collectModelUsage({
      runDir: input.runDir,
      attemptId: record.attemptId,
      agentName: record.agentName,
      agentKind: record.agent,
      role: record.role,
      worktreePath: record.worktreePath,
      extraSessionFiles: input.extraSessionFiles,
      sessionsRoots: {
        ...(roots.pi ? { pi: { kind: "pi" as const, root: roots.pi } } : {}),
        ...(roots.omp ? { omp: { kind: "omp" as const, root: roots.omp } } : {}),
      },
      ...(roots.claude ? { claudeProjectsRoot: roots.claude } : {}),
    });
    if (result.records.length) {
      fs.mkdirSync(input.runDir, { recursive: true, mode: 0o700 });
      const ledger = usageLedgerFile(input.runDir);
      const persisted = readPersistedRecordIds(input.runDir);
      const fresh = result.records.filter((entry) => !persisted.has(entry.recordId));
      if (fresh.length) {
        fs.appendFileSync(ledger, `${fresh.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
      }
      return { written: fresh };
    }
    return { written: [] };
  } catch (error) {
    // A collection failure never blocks completion authority; it is only recorded here and by
    // the caller's own observation surface.
    recordCollectionError(input.runDir, error, now());
    return { written: [] };
  }
}

module.exports = { sessionRoots, collectionErrorsFile, collectAttemptModelUsage };
