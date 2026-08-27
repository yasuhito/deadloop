// Settlement proofs beyond the live deterministic monitoring vocabulary. A retained monitor handoff
// whose attempt journal already recorded settlement — or whose monitored pull request closed — has
// nothing left to observe, so the retention must clear even when live observation keeps failing and
// would otherwise report `driver_attempt_completion_pending` forever.

const path = require("node:path");

const { readAttemptRecord } = require("./attempt-lifecycle-runtime.cjs");

type TargetStateReader = (repository: string, kind: string, number: number) => string;

type RetainedHandoffSettlementDependencies = {
  /** Reads the current GitHub state of one target; may throw, in which case it proves nothing. */
  targetState?: TargetStateReader;
};

type SettlementProof = { settled: true; reason: string } | { settled: false };

/**
 * Mirrors the monitoring vocabulary (`decideAttemptMonitoring`): once an attempt reached one of
 * these phases its deterministic monitor reports `settled`, so a retained handoff for it is stale.
 */
const SETTLED_JOURNAL_PHASES = new Set(["github_persisted", "workspace_closed", "authority_released", "abandoned"]);

type JsonObject = Record<string, any>;

type AimedAtTarget = { repository: string; kind: string; number: number } | null;

function targetTargetedBy(record: JsonObject): AimedAtTarget {
  const repository = typeof record.repository === "string" ? record.repository : "";
  const target = record.target && typeof record.target === "object" && !Array.isArray(record.target) ? record.target as Record<string, unknown> : null;
  if (!repository || !target) return null;
  return {
    repository,
    kind: String(target.kind || ""),
    number: Number(target.number),
  };
}

/** Never throws: an unreadable journal or a failed state read simply proves nothing this tick. */
function proveRetainedHandoffSettlement(
  monitorHandoff: Record<string, unknown>,
  dependencies: RetainedHandoffSettlementDependencies = {},
): SettlementProof {
  try {
    const input = monitorHandoff.input;
    if (!input || typeof input !== "object" || Array.isArray(input)) return { settled: false };
    const values = input as Record<string, unknown>;
    const recordFile = typeof values.attemptRecordFile === "string" && values.attemptRecordFile.trim()
      ? values.attemptRecordFile
      : typeof values.promiseFile === "string" && values.promiseFile.trim()
        ? path.join(path.dirname(values.promiseFile), "attempt.json")
        : "";
    if (!recordFile) return { settled: false };

    const record = readAttemptRecord(path.dirname(recordFile)) as JsonObject;
    // The journal is written by the same guarded chain that settles the attempt, so its phase
    // transition alone proves the handoff's job is done — before any GitHub traffic.
    if (SETTLED_JOURNAL_PHASES.has(String(record.phase || ""))) {
      return { settled: true, reason: "the attempt journal already released the attempt" };
    }
    const aimedAt = targetTargetedBy(record);
    if (!dependencies.targetState || !aimedAt) return { settled: false };
    const closed = ["closed", "merged"].includes(dependencies.targetState(aimedAt.repository, aimedAt.kind, aimedAt.number).toLowerCase());
    return closed
      ? { settled: true, reason: "the monitored pull request already closed" }
      : { settled: false };
  } catch {
    return { settled: false };
  }
}

module.exports = { proveRetainedHandoffSettlement };
