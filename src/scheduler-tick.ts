import { reconcileAndSelectDueAutomation } from "./automation-scheduler";
import {
  type AutomationRunnerDeps,
  type AutomationState,
  deliverPendingDriverHandoff,
  isAutomationFailureResult,
  runScheduledAutomation,
} from "./automation-runner";
import { automationStateKey, type NormalizedProject } from "./core";

/**
 * The one observable result of a scheduler tick. Both the continuous host and the one-shot command
 * receive the same outcome shape for the same state and time, so equivalence between callers stays
 * testable: only successor scheduling differs, and it happens in each caller.
 */
export type SchedulerTickOutcome =
  | { status: "idle" }
  | { status: "retained"; result: string; summary: string }
  | { status: "selected"; automationName: string; result: string; summary: string }
  | { status: "blocked"; reason: string }
  | { status: "stopped"; reason: "deployed deadloop code changed" };

export type SchedulerTickRunnerDeps = AutomationRunnerDeps;

export type SchedulerTickDeps = {
  /** True while this caller still holds its execution authority (scheduler lock plus scope). */
  guard: () => boolean;
  /**
   * Re-checks the deployed code identity before mutations. Returns false when the tick must stop;
   * the failure has already been reported by the caller's own status channel.
   */
  codeIdentityAllowsTick: () => boolean;
  reconcileWorkAuthority: () => Promise<string>;
  reconcileRetainedAttempts: () => Promise<boolean>;
  afterReconciliation?: () => void | Promise<void>;
  loadState: () => AutomationState;
  updateStatus: (state: AutomationState) => void;
  buildRunnerDeps: () => SchedulerTickRunnerDeps;
  /** Current time semantics, identical between the continuous host and the one-shot command. */
  now: () => number;
};

type TickEntry = Record<string, unknown>;

function entrySummary(entry: TickEntry): { result: string; summary: string } {
  return {
    result: typeof entry.lastResult === "string" ? entry.lastResult : "",
    summary: typeof entry.lastSummary === "string" ? entry.lastSummary : "",
  };
}

/**
 * One scheduler tick against a resolved project: work-authority reconciliation, retained-attempt
 * reconciliation, pending deterministic handoff delivery, due-automation selection, driver or
 * prompt execution, and state persistence. This is the shared seam — the continuous host and the
 * one-shot command both call it once per iteration, and neither may duplicate this logic.
 *
 * Every mutation stage rechecks `guard` (the caller's execution authority) and the deployed code
 * identity first, so an authority change during the tick blocks the next mutation.
 */
export async function executeSchedulerTick(
  project: NormalizedProject,
  deps: SchedulerTickDeps,
): Promise<SchedulerTickOutcome> {
  const authorityReason = await deps.reconcileWorkAuthority();
  if (authorityReason) return { status: "blocked", reason: authorityReason };
  const safeToSchedule = await deps.reconcileRetainedAttempts();
  await deps.afterReconciliation?.();
  if (!deps.codeIdentityAllowsTick()) return { status: "stopped", reason: "deployed deadloop code changed" };
  if (!safeToSchedule) return { status: "blocked", reason: "a prepared GitHub claim requires operator reconciliation" };

  const state = deps.loadState();
  deps.updateStatus(state);
  const runnerDeps = deps.buildRunnerDeps();

  // Retained deterministic monitor handoffs are delivered exactly as a continuous tick would:
  // at most one automation advances per tick, and delivery itself owns persistence.
  for (const automation of project.automations) {
    const key = automationStateKey(project, automation);
    const entry = state.automations[key] || {};
    state.automations[key] = entry;
    if (!deps.codeIdentityAllowsTick()) return { status: "stopped", reason: "deployed deadloop code changed" };
    if (deliverPendingDriverHandoff(entry, state, automation.name, runnerDeps)) {
      if (deps.guard()) runnerDeps.saveState(state);
      return { status: "retained", ...entrySummary(entry) };
    }
  }

  if (!deps.codeIdentityAllowsTick()) return { status: "stopped", reason: "deployed deadloop code changed" };
  const selected = reconcileAndSelectDueAutomation(project, state.automations, deps.now());
  let outcome: SchedulerTickOutcome = { status: "idle" };
  if (selected) {
    if (!deps.guard()) return { status: "blocked", reason: "execution authority was revoked before the selected automation ran" };
    await runScheduledAutomation(project, selected.automation, selected.dueSlot, state, runnerDeps);
    const key = automationStateKey(project, selected.automation);
    outcome = {
      status: "selected",
      automationName: selected.automation.name,
      ...entrySummary(state.automations[key] || {}),
    };
    if (deps.guard()) deps.updateStatus(state);
  }

  if (deps.guard()) runnerDeps.saveState(state);
  return outcome;
}

/**
 * Deterministic start gate for the one-shot command. One-shot mode requires persisted continuous
 * enablement to be false and an unheld repository lock; two scheduling authorities must never
 * coexist.
 */
export function planOneShotTick(input: {
  persistedEnabledProject: unknown;
  lockAcquisition: { acquired: boolean; owner?: number | null };
}): { ok: true } | { ok: false; reason: string } {
  if (input.persistedEnabledProject != null) {
    return {
      ok: false,
      reason: "continuous scheduling is enabled for this repository; run /deadloop-disable before running one tick",
    };
  }
  if (!input.lockAcquisition.acquired) {
    return {
      ok: false,
      reason: `the repository lock is held by Automation host pid ${input.lockAcquisition.owner ?? "unknown"}`,
    };
  }
  return { ok: true };
}

const MODEL_WAIT_RESULTS = new Set(["driver_monitor_waiting_for_model", "driver_attempt_completion_pending"]);
const RUNNING_RESULTS = new Set(["driver_attempt_working"]);

function resultDetail(outcome: { result?: string; summary?: string }): string {
  return [outcome.result, outcome.summary].filter(Boolean).join(": ");
}

/** Operator-facing report for one completed one-shot tick. */
export function formatOneShotTickReport(outcome: SchedulerTickOutcome): string {
  switch (outcome.status) {
    case "idle":
      return "one-shot tick finished without work: no automation was due and no retained attempt needed attention.";
    case "blocked":
      return `one-shot tick stopped before any further step: ${outcome.reason}`;
    case "stopped":
      return `one-shot tick stopped without running: ${outcome.reason}. Reload the deployed deadloop checkout before running another tick.`;
    case "retained": {
      if (RUNNING_RESULTS.has(outcome.result)) {
        return `one-shot tick left a retained attempt running (${resultDetail(outcome)}). Run /deadloop-run-once again later, or enable continuous scheduling, to observe its completion.`;
      }
      if (MODEL_WAIT_RESULTS.has(outcome.result)) {
        return `one-shot tick recorded that deadloop waits for model availability (${resultDetail(outcome)}). No retry was scheduled.`;
      }
      if (isAutomationFailureResult(outcome.result)) {
        return `one-shot tick handled a retained attempt but it ended in an error (${resultDetail(outcome)}).`;
      }
      return `one-shot tick handled a retained attempt (${resultDetail(outcome)}).`;
    }
    case "selected": {
      if (outcome.result === "queued") {
        return `one-shot tick launched "${outcome.automationName}" (${resultDetail(outcome)}). The agent runs outside this command; later ticks handle its completion.`;
      }
      if (MODEL_WAIT_RESULTS.has(outcome.result)) {
        return `one-shot tick ran "${outcome.automationName}" and recorded that deadloop waits for model availability (${resultDetail(outcome)}). No retry was scheduled.`;
      }
      if (RUNNING_RESULTS.has(outcome.result)) {
        return `one-shot tick ran "${outcome.automationName}" and left a retained attempt running (${resultDetail(outcome)}). Run /deadloop-run-once again later to observe its completion.`;
      }
      if (isAutomationFailureResult(outcome.result)) {
        return `one-shot tick ran "${outcome.automationName}" but it ended in an error (${resultDetail(outcome)}).`;
      }
      return `one-shot tick ran "${outcome.automationName}" (${resultDetail(outcome)}).`;
    }
  }
}
