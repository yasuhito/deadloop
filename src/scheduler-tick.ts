import { reconcileAndSelectDueAutomation } from "./automation-scheduler";
import {
  type AutomationRunnerDeps,
  type AutomationState,
  deliverPendingDriverHandoff,
  isAutomationFailureResult,
  runScheduledAutomation,
} from "./automation-runner";
import { automationStateKey, type NormalizedAutomation, type NormalizedProject } from "./core";
import type { TickHostLogEvent } from "./host-log-types";

/**
 * The one observable result of a scheduler tick. Both the continuous host and the one-shot command
 * receive the same outcome shape for the same state and time, so equivalence between callers stays
 * testable: only successor scheduling differs, and it happens in each caller.
 */
export type SchedulerTickOutcome =
  | { status: "idle" }
  | { status: "retained"; result: string; summary: string }
  | { status: "selected"; automationName: string; result: string; summary: string }
  | {
      status: "retained_and_selected";
      retained: { result: string; summary: string };
      automationName: string;
      result: string;
      summary: string;
    }
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
  /**
   * Observational host activity-log sink (#370), wired by the host to STATE_DIR. The tick treats
   * emitting as best-effort — including a throwing sink — because log writes never gate outcomes.
   */
  emitHostLog?: (event: TickHostLogEvent) => void;
};

type TickEntry = Record<string, unknown>;

function entrySummary(entry: TickEntry): { result: string; summary: string } {
  return {
    result: typeof entry.lastResult === "string" ? entry.lastResult : "",
    summary: typeof entry.lastSummary === "string" ? entry.lastSummary : "",
  };
}

function entryText(entry: Record<string, unknown>, key: string): string {
  return typeof entry[key] === "string" ? (entry[key] as string).trim() : "";
}

function observeTickEvent(deps: SchedulerTickDeps, event: TickHostLogEvent): void {
  try {
    deps.emitHostLog?.(event);
  } catch {}
}

// 自動化に触れない観測でも、行形状の統一は writer 側が空文字で保つ。
function contextFor(projectId: string, automationId?: string): { projectId: string; automationId?: string } {
  return { projectId, ...(automationId === undefined ? {} : { automationId }) };
}

/** Emits the one judgment line a tick recorded for an automation it touched. */
function observeAutomationResult(
  deps: SchedulerTickDeps,
  projectId: string,
  automationId: string,
  entry: Record<string, unknown>,
): void {
  const observed = entrySummary(entry);
  const driverAction = entryText(entry, "lastDriverAction");
  observeTickEvent(deps, {
    kind: "automation_result",
    projectId,
    automationId,
    result: observed.result,
    reason: observed.summary,
    ...(driverAction ? { driverAction } : {}),
  });
}

/**
 * Observes `executeSchedulerTick` for the host activity log: every tick starts with one
 * `tick_started` line and closes with exactly one judgment line — either the automation-level
 * result emitted inside `performSchedulerTick` when work was selected or retained, or a tick-level
 * idle/blocked/stopped record that answers "why did nothing happen this tick".
 */
export async function executeSchedulerTick(
  project: NormalizedProject,
  deps: SchedulerTickDeps,
): Promise<SchedulerTickOutcome> {
  observeTickEvent(deps, { kind: "tick_started", ...contextFor(project.id) });
  const outcome = await performSchedulerTick(project, deps);
  if (outcome.status === "blocked") observeTickEvent(deps, { kind: "tick_blocked", reason: outcome.reason, ...contextFor(project.id) });
  else if (outcome.status === "stopped") observeTickEvent(deps, { kind: "tick_stopped", reason: outcome.reason, ...contextFor(project.id) });
  else if (outcome.status === "idle") observeTickEvent(deps, { kind: "tick_idle", ...contextFor(project.id) });
  return outcome;
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
/**
 * Picks the automation whose retained handoff delivery is due first: the least-recently-advanced
 * entry wins, ties broken by configuration order, so two retained automations alternate delivery
 * across ticks (#402). Every entry is materialized in the state like the previous delivery loop.
 */
function nextRetainedDelivery(
  project: NormalizedProject,
  state: AutomationState,
): { automation: NormalizedAutomation; entry: Record<string, unknown> } | null {
  let candidate: { automation: NormalizedAutomation; entry: Record<string, unknown>; advancedAt: number } | null = null;
  for (const automation of project.automations) {
    const key = automationStateKey(project, automation);
    const entry = state.automations[key] || {};
    state.automations[key] = entry;
    const handoff = entry.pendingDriverHandoff;
    if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) continue;
    const advancedAt = Number.isFinite(entry.updatedAt) ? (entry.updatedAt as number) : 0;
    if (!candidate || advancedAt < candidate.advancedAt) candidate = { automation, entry, advancedAt };
  }
  return candidate && { automation: candidate.automation, entry: candidate.entry };
}

async function performSchedulerTick(
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

  // Retained deterministic monitor handoffs are observed one automation per tick, round-robin
  // from the least-recently-advanced entry (#402). Delivery is monitoring only — it never
  // consumes the launch quota — so the tick continues to due-automation selection instead of
  // ending here. Delivery itself owns persistence.
  let delivered: { result: string; summary: string } | null = null;
  const delivery = nextRetainedDelivery(project, state);
  if (delivery) {
    if (!deps.codeIdentityAllowsTick()) return { status: "stopped", reason: "deployed deadloop code changed" };
    deliverPendingDriverHandoff(delivery.entry, state, delivery.automation.name, runnerDeps, contextFor(project.id, delivery.automation.id));
    observeAutomationResult(deps, project.id, delivery.automation.id, delivery.entry);
    delivered = entrySummary(delivery.entry);
  }

  if (!deps.codeIdentityAllowsTick()) return { status: "stopped", reason: "deployed deadloop code changed" };
  const { selected, starved } = reconcileAndSelectDueAutomation(project, state.automations, deps.now());
  for (const starvedAutomation of starved) {
    observeTickEvent(deps, {
      kind: "automation_starved",
      projectId: project.id,
      automationId: starvedAutomation.automationId,
      dueAt: new Date(starvedAutomation.dueSince).toISOString(),
      reason: selected ? `selection went to ${selected.automation.name}` : "",
    });
  }
  let outcome: SchedulerTickOutcome = delivered ? { status: "retained", ...delivered } : { status: "idle" };
  if (selected) {
    if (!deps.guard()) return { status: "blocked", reason: "execution authority was revoked before the selected automation ran" };
    await runScheduledAutomation(project, selected.automation, selected.dueSlot, state, runnerDeps);
    const key = automationStateKey(project, selected.automation);
    const selectedSummary = entrySummary(state.automations[key] || {});
    outcome = delivered
      ? { status: "retained_and_selected", retained: delivered, automationName: selected.automation.name, ...selectedSummary }
      : { status: "selected", automationName: selected.automation.name, ...selectedSummary };
    observeAutomationResult(deps, project.id, selected.automation.id, state.automations[key] || {});
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

function retainedReportPhrase(retained: { result: string; summary: string }): string {
  const detail = resultDetail(retained);
  if (RUNNING_RESULTS.has(retained.result)) {
    return `one-shot tick left a retained attempt running (${detail}). Run /deadloop-run-once again later, or enable continuous scheduling, to observe its completion.`;
  }
  if (MODEL_WAIT_RESULTS.has(retained.result)) {
    return `one-shot tick recorded that deadloop waits for model availability (${detail}). No retry was scheduled.`;
  }
  if (isAutomationFailureResult(retained.result)) {
    return `one-shot tick handled a retained attempt but it ended in an error (${detail}).`;
  }
  return `one-shot tick handled a retained attempt (${detail}).`;
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
    case "retained":
      return retainedReportPhrase(outcome);
    case "retained_and_selected":
      return `${retainedReportPhrase(outcome.retained)} The same tick also ran "${outcome.automationName}" (${resultDetail(outcome)}).`;
    case "selected": {
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
