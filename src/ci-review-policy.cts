// Pure review-policy seam for CI checks and CI fallback verification (ADR 0030).
//
// Inputs are check observations, exact revisions, verification records, policy, and repair
// history; outputs are typed directives. Nothing here reads GitHub, git, or the filesystem, so
// every directive is testable without an execution runtime.

const PENDING_CHECK_STATES = new Set(["QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED", "WAITING", "REQUESTED"]);
const SUCCESS_CHECK_RESULTS = new Set(["SUCCESS", "SUCCESSFUL", "NEUTRAL", "SKIPPED"]);
const FAILURE_CHECK_RESULTS = new Set([
  "FAILURE",
  "FAILED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ERROR",
]);

function normalizedCheckValue(value: unknown): string {
  return String(value || "").toUpperCase();
}

/** One check's terminal verdict, or null while it carries no recognizable terminal value. */
function checkVerdict(check: { status?: unknown; state?: unknown; conclusion?: unknown }): "pending" | "success" | "failure" | null {
  const status = normalizedCheckValue(check.status);
  const state = normalizedCheckValue(check.state);
  const conclusion = normalizedCheckValue(check.conclusion);
  if (PENDING_CHECK_STATES.has(status) || PENDING_CHECK_STATES.has(state)) return "pending";
  if (!status && !state && !conclusion) return null;
  if (SUCCESS_CHECK_RESULTS.has(conclusion) || SUCCESS_CHECK_RESULTS.has(state)) return "success";
  if (FAILURE_CHECK_RESULTS.has(conclusion) || FAILURE_CHECK_RESULTS.has(state)) return "failure";
  return null;
}

/**
 * Classify the whole check rollup: absent is non-failure; any pending check waits; an
 * unrecognizable state stops; a terminal failure may be replaced by CI fallback verification.
 */
function classifyCheckObservations(checks: unknown): string {
  if (!Array.isArray(checks)) return "unknown";
  const observations = checks.filter((check) => Boolean(check) && typeof check === "object");
  if (!observations.length) return "absent";
  let sawFailure = false;
  for (const check of observations) {
    const verdict = checkVerdict(check);
    if (verdict === "pending") return "pending";
    if (verdict === null) return "unknown";
    if (verdict === "failure") sawFailure = true;
  }
  return sawFailure ? "terminal_failure" : "all_success";
}

/** What a persisted fallback record must prove to replace a failed check set. */
type FallbackRecordBindingInput = {
  repository: string;
  prNumber: number;
  headOid: string;
  baseOid: string;
  treeOid: string;
  contract: { command: string; derivation: string; policySource: { kind: string; location: string } };
  policyBaseRevision: string;
};

type CiFallbackMergeGateInput = FallbackRecordBindingInput & {
  checks: unknown;
  /** The latest persisted merge-candidate fallback record for this PR, or null. */
  fallbackRecord: Record<string, unknown> | null;
};

function sameOid(left: unknown, right: string): boolean {
  return Boolean(right) && String(left || "").toLowerCase() === right.toLowerCase();
}

/** Whether the record's identity bindings match this exact candidate, regardless of outcome. */
function fallbackRecordBoundToCandidate(
  record: Record<string, unknown> | null | undefined,
  input: FallbackRecordBindingInput,
): boolean {
  if (!record || typeof record !== "object" || Array.isArray(record)) return false;
  if (record.version !== 1) return false;
  if (String(record.role || "") !== "merge_candidate") return false;
  if (String(record.repository || "") !== String(input.repository)) return false;
  if (Number(record.prNumber) !== Number(input.prNumber)) return false;
  if (!sameOid(record.headOid, input.headOid)) return false;
  if (!sameOid(record.baseOid, input.baseOid)) return false;
  if (!sameOid(record.treeOid, input.treeOid)) return false;
  if (!sameOid(record.policyBaseRevision, input.policyBaseRevision)) return false;
  if (String(record.command || "") !== String(input.contract.command)) return false;
  if (String(record.derivation || "") !== String(input.contract.derivation)) return false;
  const source = record.policySource as Record<string, unknown> | undefined;
  return Boolean(source && typeof source === "object"
    && String(source.kind || "") === String(input.contract.policySource.kind)
    && String(source.location || "") === String(input.contract.policySource.location));
}

/**
 * Whether the persisted record is the fresh successful verification of exactly this merge candidate.
 * A changed binding invalidates the record.
 */
function fallbackRecordMatchesCandidate(
  record: Record<string, unknown> | null | undefined,
  input: FallbackRecordBindingInput,
): boolean {
  return fallbackRecordBoundToCandidate(record, input)
    && record!.outcome === "passed"
    && Number(record!.exitCode) === 0
    && typeof record!.logPath === "string"
    && Boolean(String(record!.logPath).trim());
}

/**
 * The merge-gate directive for one prospective merge: GitHub checks are one health signal, never
 * the sole authority. Failed terminal checks may be replaced by fresh CI fallback evidence; they
 * are never reported as CI success.
 */
function decideCiFallbackMergeGate(input: CiFallbackMergeGateInput): Record<string, any> {
  const classification = classifyCheckObservations(input.checks);
  switch (classification) {
    case "absent":
      return { action: "proceed", basis: "no_checks", checks: classification };
    case "all_success":
      return { action: "proceed", basis: "ci_success", checks: classification };
    case "pending":
      return { action: "wait", reason: "checks_pending", checks: classification };
    case "unknown":
      return { action: "stop", reason: "unknown_check_state", checks: classification };
    case "terminal_failure":
      break;
  }
  if (fallbackRecordMatchesCandidate(input.fallbackRecord, input)) {
    return { action: "proceed", basis: "ci_fallback", checks: classification };
  }
  // Fresh evidence of a failed CI-equivalent run on this exact tree: do not verify again; stop so
  // the base diagnosis / bounded repair episode can decide what happens next.
  if (fallbackRecordBoundToCandidate(input.fallbackRecord, input)) {
    return { action: "stop", reason: "ci_fallback_failed", checks: classification };
  }
  if (input.fallbackRecord) {
    return {
      action: "stop",
      reason: "ci_fallback_stale",
      detail: "persisted CI fallback record no longer matches the current head, base, tree, command, or policy",
      checks: classification,
    };
  }
  return { action: "stop", reason: "ci_fallback_required", checks: classification };
}

/** One repair episode: at most one automatic CI fallback repair until a human Agent request resets it. */
type RepairEpisode = {
  version?: number;
  repository?: string;
  prNumber?: number;
  episodeKey?: string;
  startedAt?: string;
  repairsUsed?: number;
  updatedAt?: string;
};

type CiRepairDecisionInput = {
  episode: RepairEpisode | null;
  /** A human added an Agent request after this episode started. */
  humanRequestAfterEpisode: boolean;
  expectedEpisodeKey: string;
};

/**
 * Permit one automatic repair per fallback episode. A changed head stays inside the same episode;
 * a second fallback failure blocks; only a later human Agent request starts a new episode.
 */
function decideCiFallbackRepair(input: CiRepairDecisionInput): Record<string, any> {
  const episode = input.episode;
  if (input.humanRequestAfterEpisode) return { action: "repair_allowed", episodeReset: true };
  if (!episode || String(episode.episodeKey || "") !== input.expectedEpisodeKey) {
    return { action: "repair_allowed", episodeReset: true };
  }
  if (Number(episode.repairsUsed || 0) >= 1) {
    return { action: "repair_blocked", reason: "second_failure_in_episode" };
  }
  return { action: "repair_allowed", episodeReset: false };
}

module.exports = {
  classifyCheckObservations,
  decideCiFallbackMergeGate,
  decideCiFallbackRepair,
  fallbackRecordBoundToCandidate,
  fallbackRecordMatchesCandidate,
};
