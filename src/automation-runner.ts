import {
  automationStateKey,
  type AutomationFileResolution,
  type NormalizedAutomation,
  type NormalizedProject,
} from "./core";
import type {
  ActiveWorkAccounting,
  AttemptMonitoringApplication,
  AttemptMonitoringDirective,
} from "./monitor-handoff-types";
import type { HostLogEventContext, HostLogEventInput } from "./host-log-types";
import path from "node:path";
const { passesIssueLabelGate } = require("./issue-eligibility.cjs");

export type AutomationExecResult = {
  code: number;
  stdout?: string;
  stderr?: string;
};

export type AutomationState = {
  automations: Record<string, Record<string, unknown>>;
};

export type AutomationExecutionSupply = {
  codeIdentity: string;
  lockHash: string;
  packageRoot: string;
  automationDir: string;
  dependencyRoot: string;
};

type RetainedHandoffSettlement = { settled: true; reason: string } | { settled: false };

export type AutomationRunnerDeps = {
  herdrPreflight?: () => void | Promise<void>;
  enabledAt?: () => number;
  isEnabled?: () => boolean;
  observeAttemptMonitoring?: (
    handoff: Record<string, unknown>,
    accounting: ActiveWorkAccounting,
    now: number,
  ) => AttemptMonitoringDirective;
  applyAttemptMonitoring?: (
    handoff: Record<string, unknown>,
    directive: Exclude<AttemptMonitoringDirective, { action: "working" | "ambiguity" | "settled" }>,
  ) => AttemptMonitoringApplication;
  retryModelWait?: (handoff: Record<string, unknown>) => boolean;
  /**
   * Observes one settlement proof beyond the live monitoring vocabulary for a retained handoff,
   * such as an attempt journal that already released its authority or a closed pull request. A
   * truthy `settled` result clears the retention before any further delivery work happens; the
   * observer itself must never throw, so a failed read keeps the retention for the next tick.
   */
  proveRetainedHandoffSettled?: (handoff: Record<string, unknown>) => RetainedHandoffSettlement;
  /**
   * Closes the settled attempt's still-open workspace after the retention clears (#395). The
   * implementation owns the ownership proof and records any failure itself; a throw here is a
   * caller bug, so the runner treats only the returned verdict as the outcome.
   */
  settleRetainedWorkspace?: (handoff: Record<string, unknown>) => { closed: boolean; detail?: string };
  notify?: (message: string, level: "info" | "warning" | "error") => void;
  now: () => number;
  prepareExecutionSupply: () => AutomationExecutionSupply | Promise<AutomationExecutionSupply>;
  revalidatePendingDriverHandoff?: (handoff: Record<string, unknown>) => boolean;
  resolveAutomationFileInDir: (
    kind: "driver",
    automation: NormalizedAutomation,
    requested: string | undefined,
    supply: AutomationExecutionSupply,
  ) => AutomationFileResolution;
  runDriver: (
    project: NormalizedProject,
    automation: NormalizedAutomation,
    driverFile: string,
    supply: AutomationExecutionSupply,
  ) => Promise<AutomationExecResult>;
  saveState: (state: AutomationState) => void;
  setStatus?: (text: string) => void;
  /**
   * Observational host activity-log sink (#370), wired by the host to STATE_DIR. Model-wait
   * transitions use it; failures (including a throwing sink) never change the runner's outcome.
   */
  emitHostLog?: (event: HostLogEventInput) => void;
  /**
   * Consumes the durable monitor-handoff sidecar of a just-registered monitor result (#386). The
   * host deletes the sidecar beside the attempt journal so an adopted handoff is never re-adopted
   * after it settles; a failure never changes the outcome that already adopted it.
   */
  consumeLaunchHandoffSidecar?: (payload: Record<string, unknown>) => void;
  /**
   * Returns orphaned durable launch handoffs for this automation (#386): sidecars whose attempt
   * launched but whose monitoring handoff was lost to an invalid driver outcome. The caller adopts
   * one payload into `pendingDriverHandoff`; the host consumes each returned sidecar after its
   * state write, so a failed save simply re-adopts the same payload next tick.
   */
  adoptOrphanedLaunchHandoffs?: (state: AutomationState, automation: NormalizedAutomation) => Record<string, unknown>[];
};

function observeHostLog(deps: { emitHostLog?: (event: HostLogEventInput) => void }, event: HostLogEventInput): void {
  try {
    deps.emitHostLog?.(event);
  } catch {}
}

function logIdentity(entry: Record<string, unknown>, logContext?: HostLogEventContext): HostLogEventContext {
  const projectId = logContext?.projectId ?? entry.projectId;
  return {
    ...(typeof projectId === "string" && projectId.trim() ? { projectId: projectId.trim() } : {}),
    ...(logContext?.automationId ? { automationId: logContext.automationId } : {}),
  };
}

export function isPendingIssueHandoffEligible(
  handoff: Record<string, unknown>,
  issue: Record<string, unknown>,
): boolean {
  if (handoff.kind !== "issue" || !handoff.input || typeof handoff.input !== "object" || Array.isArray(handoff.input)) {
    return false;
  }
  const input = handoff.input as Record<string, unknown>;
  const labelKeys = ["readyLabel", "inProgressLabel", "blockedLabel", "humanLabel", "needsInfoLabel", "wontfixLabel"];
  if (!labelKeys.every((key) => typeof input[key] === "string" && input[key])) return false;
  return (
    Number.isInteger(input.issueNumber) &&
    issue.number === input.issueNumber &&
    typeof input.issueTitle === "string" &&
    issue.title === input.issueTitle &&
    typeof input.issueBody === "string" &&
    issue.body === input.issueBody &&
    issue.state === "OPEN" &&
    passesIssueLabelGate(issue, {
      required: [input.readyLabel as string, input.inProgressLabel as string],
      blocked: [input.blockedLabel as string, input.humanLabel as string, input.needsInfoLabel as string, input.wontfixLabel as string],
    })
  );
}

type DriverPayload = {
  action?: unknown;
  summary?: unknown;
  prompt?: unknown;
  error?: unknown;
  [key: string]: unknown;
};

type ModelAvailabilityWait = { startedAt: string; nextRetryAt: string | null };
type ModelAvailabilityPayload = DriverPayload & {
  modelWait?: ModelAvailabilityWait;
  modelRetryCount?: number;
  modelNoticePosted?: boolean;
};

/**
 * One tick against a retained attempt whose turn ended in a recognized billing/access rejection.
 *
 * The first transition posts the single idempotent GitHub explanation and records the wait.
 * Provider-stated timing gates the retry; without it, the normal next scheduler tick is the only
 * retry trigger. A disabled repository starts no retry mutation, and a session that cannot be
 * reused stops the attempt through the ordinary deterministic path instead of opening replacement
 * runtime resources. Waiting records no successor schedule itself, so a one-shot caller ends here.
 */
function handleModelAvailabilityWait(
  entry: Record<string, unknown>,
  payload: ModelAvailabilityPayload,
  monitorHandoff: Record<string, unknown>,
  directive: Extract<AttemptMonitoringDirective, { action: "missing_report" }>,
  automationName: string,
  state: AutomationState,
  deps: Pick<
    AutomationRunnerDeps,
    "applyAttemptMonitoring" | "isEnabled" | "notify" | "now" | "retryModelWait" | "saveState" | "emitHostLog"
  >,
  logContext?: HostLogEventContext,
): boolean {
  const now = deps.now();
  const wait = payload.modelWait;
  if (!wait) {
    const application = deps.applyAttemptMonitoring?.(monitorHandoff, directive) ?? { applied: false };
    payload.modelWait = {
      startedAt: new Date(now).toISOString(),
      nextRetryAt: typeof directive.providerRetryAt === "string" ? directive.providerRetryAt : null,
    };
    payload.modelNoticePosted = application.applied === true;
    recordAutomationResult(entry, application.applied ? "driver_monitor_waiting_for_model" : "driver_attempt_completion_pending");
    entry.lastSummary = "waiting for model availability";
    entry.updatedAt = now;
    deps.saveState(state);
    observeHostLog(deps, {
      kind: "model_wait_transitioned",
      ...logIdentity(entry, logContext),
      result: application.applied ? "driver_monitor_waiting_for_model" : "driver_attempt_completion_pending",
      reason: "waiting for model availability",
    });
    deps.notify?.(`deadloop waits for model availability: ${automationName}`, "warning");
    return true;
  }
  const dueAt = wait.nextRetryAt === null ? null : Date.parse(wait.nextRetryAt);
  const retryDue = dueAt !== null && Number.isFinite(dueAt) ? now >= dueAt : now > Date.parse(wait.startedAt);
  if (!retryDue) {
    if (payload.modelNoticePosted !== true) {
      const application = deps.applyAttemptMonitoring?.(monitorHandoff, directive) ?? { applied: false };
      payload.modelNoticePosted = application.applied === true;
      if (application.applied) {
        recordAutomationResult(entry, "driver_monitor_waiting_for_model");
        entry.updatedAt = now;
      }
    }
    deps.saveState(state);
    return true;
  }
  if (deps.isEnabled && !deps.isEnabled()) {
    recordAutomationResult(entry, "disabled_before_model_retry");
    entry.updatedAt = now;
    deps.saveState(state);
    observeHostLog(deps, {
      kind: "model_wait_transitioned",
      ...logIdentity(entry, logContext),
      result: "disabled_before_model_retry",
      reason: "repository became disabled before the model wait retry",
    });
    return true;
  }
  if (deps.retryModelWait?.(monitorHandoff) === true) {
    payload.modelRetryCount = Number(payload.modelRetryCount || 0) + 1;
    delete payload.modelWait;
    delete payload.modelNoticePosted;
    recordAutomationResult(entry, "driver_monitor_model_retry");
    entry.lastSummary = "model availability retry sent";
    entry.updatedAt = now;
    deps.saveState(state);
    observeHostLog(deps, {
      kind: "model_wait_transitioned",
      ...logIdentity(entry, logContext),
      result: "driver_monitor_model_retry",
      reason: "model availability retry sent",
    });
    return true;
  }
  const stopped = deps.applyAttemptMonitoring?.(
    monitorHandoff,
    { ...directive, providerRetryAt: undefined, reason: "terminal_without_report" },
  ) ?? { applied: false };
  if (stopped.nextHandoff) {
    entry.pendingDriverHandoff = stopped.nextHandoff;
  } else if (stopped.applied && !stopped.retain) {
    delete entry.pendingDriverHandoff;
  }
  recordAutomationResult(entry, stopped.applied ? "driver_attempt_missing_report" : "driver_attempt_completion_pending");
  entry.lastSummary = "agent session cannot be reused";
  entry.updatedAt = now;
  deps.saveState(state);
  observeHostLog(deps, {
    kind: "model_wait_transitioned",
    ...logIdentity(entry, logContext),
    result: stopped.applied ? "driver_attempt_missing_report" : "driver_attempt_completion_pending",
    reason: "agent session cannot be reused; the model wait ended",
  });
  return true;
}

/**
 * Delivers one pending deterministic monitor handoff against its automation entry. The optional
 * `logContext` only feeds the observational host activity log (`model_wait_transitioned` lines);
 * both call sites already know their project and automation ids.
 */
export function deliverPendingDriverHandoff(
  entry: Record<string, unknown>,
  state: AutomationState,
  automationName: string,
  deps: Pick<
    AutomationRunnerDeps,
    | "enabledAt"
    | "isEnabled"
    | "notify"
    | "now"
    | "observeAttemptMonitoring"
    | "applyAttemptMonitoring"
    | "proveRetainedHandoffSettled"
    | "settleRetainedWorkspace"
    | "retryModelWait"
    | "revalidatePendingDriverHandoff"
    | "saveState"
    | "emitHostLog"
  >,
  logContext?: HostLogEventContext,
): boolean {
  const handoff = entry.pendingDriverHandoff;
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return false;
  const payload = handoff as DriverPayload;
  // Every retained handoff is a deterministic monitor handoff. A retained payload without one
  // predates deterministic monitoring: report it as unsupported and never redeliver its prompt.
  if (!payload.monitorHandoff || typeof payload.monitorHandoff !== "object" || Array.isArray(payload.monitorHandoff)) {
    delete entry.pendingDriverHandoff;
    recordAutomationResult(entry, "driver_invalid_result");
    entry.lastError = "retained prompt handoff is unsupported; attempt monitoring is deterministic only";
    entry.updatedAt = deps.now();
    deps.saveState(state);
    return true;
  }
  const monitorHandoff = payload.monitorHandoff as Record<string, unknown>;
  try {
    const input = monitorHandoff.input;
    const persistedEnabledAt = input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).enabledAt
      : undefined;
    const currentEnabledAt = deps.enabledAt?.();
    const generationsAreValid =
      typeof persistedEnabledAt === "number" &&
      Number.isFinite(persistedEnabledAt) &&
      typeof currentEnabledAt === "number" &&
      Number.isFinite(currentEnabledAt);
    const generationChanged = generationsAreValid && persistedEnabledAt !== currentEnabledAt;
    const canRebind =
      generationsAreValid &&
      (!generationChanged ||
        (monitorHandoff.kind === "issue" && deps.revalidatePendingDriverHandoff?.(monitorHandoff) === true));
    if (!canRebind) {
      delete entry.pendingDriverHandoff;
      recordAutomationResult(entry, "driver_handoff_revalidation_required");
      entry.lastSummary = `pre-disable ${String(monitorHandoff.kind || "monitor")} handoff was discarded for current-state re-evaluation`;
      entry.updatedAt = deps.now();
      deps.saveState(state);
      deps.notify?.(`deadloop discarded stale monitor handoff: ${automationName}`, "warning");
      return true;
    }
    {
      const settlementProof = deps.proveRetainedHandoffSettled?.(monitorHandoff);
      if (settlementProof?.settled === true) {
        const closure = deps.settleRetainedWorkspace?.(monitorHandoff);
        const closureDetail = closure && closure.closed === false
          ? String(closure.detail || "workspace closure failed")
          : "";
        delete entry.pendingDriverHandoff;
        recordAutomationResult(entry, "driver_monitor_settled");
        entry.lastSummary = closureDetail
          ? `${settlementProof.reason}; settled workspace closure is pending: ${closureDetail}`
          : settlementProof.reason;
        entry.updatedAt = deps.now();
        deps.saveState(state);
        if (closureDetail) {
          // Set after recordAutomationResult, like every non-failure result that still carries a
          // reason: the settlement itself succeeded, only the follow-up workspace closure failed.
          const pendingReason = `${settlementProof.reason}; settled workspace closure is pending: ${closureDetail}`;
          entry.lastError = pendingReason;
          observeHostLog(deps, {
            kind: "automation_result",
            ...logIdentity(entry, logContext),
            result: "driver_monitor_settled",
            reason: pendingReason,
            driverAction: "cleanup_pending",
          });
        }
        return true;
      }
      const storedAccounting = payload.monitorAccounting;
      const accounting: ActiveWorkAccounting = storedAccounting && typeof storedAccounting === "object" && !Array.isArray(storedAccounting)
        ? storedAccounting as unknown as ActiveWorkAccounting
        : { activeMilliseconds: 0, observedAt: new Date(deps.now()).toISOString(), runtimeWasWorking: false };
      const directive = deps.observeAttemptMonitoring?.(monitorHandoff, accounting, deps.now());
      if (!directive) {
        recordAutomationResult(entry, "driver_monitor_observation_ambiguous");
        entry.lastSummary = "deterministic attempt monitoring is unavailable";
        entry.updatedAt = deps.now();
        deps.saveState(state);
        return true;
      }
      payload.monitorAccounting = directive.accounting;
      if (directive.action === "settled") {
        delete entry.pendingDriverHandoff;
        recordAutomationResult(entry, "driver_monitor_settled");
      } else if (directive.action === "working") {
        recordAutomationResult(entry, "driver_attempt_working");
        entry.lastSummary = `deterministic attempt monitoring: active work ${directive.accounting.activeMilliseconds}ms`;
      } else if (directive.action === "ambiguity") {
        recordAutomationResult(entry, "driver_monitor_observation_ambiguous");
        entry.lastSummary = directive.reason;
      } else if (directive.action === "missing_report" && directive.reason === "model_availability") {
        return handleModelAvailabilityWait(
          entry,
          payload as ModelAvailabilityPayload,
          monitorHandoff,
          directive,
          automationName,
          state,
          deps,
          logContext,
        );
      } else {
        const application = deps.applyAttemptMonitoring?.(monitorHandoff, directive) ?? { applied: false };
        if (application.nextHandoff) {
          entry.pendingDriverHandoff = application.nextHandoff;
        } else if (application.applied && !application.retain) {
          delete entry.pendingDriverHandoff;
        }
        const failureReason = application.applied ? "" : completionApplicationFailureReason(application);
        recordAutomationResult(entry, application.applied ? `driver_attempt_${directive.action}` : "driver_attempt_completion_pending");
        // Set after recordAutomationResult: that call resets the entry surfaces, and a failed
        // completion must stay readable from lastError and from the host-log reason (lastSummary).
        if (failureReason) {
          entry.lastError = failureReason;
          entry.lastSummary = failureReason;
        } else {
          entry.lastSummary = "reason" in directive ? directive.reason : `deterministic ${directive.action}`;
        }
      }
      entry.updatedAt = deps.now();
      deps.saveState(state);
      return true;
    }
  } catch (error) {
    delete entry.pendingDriverHandoff;
    recordAutomationResult(entry, "driver_invalid_result");
    // Set both surfaces after recordAutomationResult: lastError is the state.json reason and
    // lastSummary becomes the host-log automation_result reason, so a thrown completion failure
    // stays diagnosable from both (#389).
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    entry.lastError = message;
    entry.lastSummary = message;
    entry.updatedAt = deps.now();
    deps.saveState(state);
    return true;
  }
}

const BARE_ACTION_TAGS = new Set(["exception", "error"]);

/**
 * A failed deterministic completion application reports its reason where the child completion
 * script put it: either the thrown error text, or a failed sub-step driver output carried in
 * `result` (usually its `summary`, e.g. a vanished canonical worktree path). Distills one
 * operator-readable reason; empty when the application carries nothing readable.
 */
function completionApplicationFailureReason(application: AttemptMonitoringApplication): string {
  const errorText = typeof application.error === "string" ? trimText(application.error) : "";
  const result = application.result;
  const child = result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : undefined;
  // Bare action tags ("exception", "error") say nothing: never accept them as the whole reason (#389).
  return firstNonEmpty(
    errorText,
    typeof result === "string" ? result : undefined,
    child?.summary,
    child?.error,
    child?.reason,
    BARE_ACTION_TAGS.has(String(child?.driverAction)) ? undefined : child?.driverAction,
    BARE_ACTION_TAGS.has(String(child?.action)) ? undefined : child?.action,
  );
}

export function isAutomationFailureResult(result: string): boolean {
  return (
    result === "driver_file_missing" ||
    result === "driver_error" ||
    result === "driver_invalid_json" ||
    result === "driver_invalid_result"
  );
}

export function recordAutomationResult(entry: Record<string, unknown>, result: string): void {
  if (isAutomationFailureResult(result)) {
    entry.failureStreak = (entry.lastResult === result ? Number(entry.failureStreak || 0) : 0) + 1;
  } else {
    entry.failureStreak = 0;
    delete entry.lastError;
  }
  entry.lastResult = result;
}

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = trimText(value);
    if (text) return text;
  }
  return "";
}

function recordDriverFailure(
  entry: Record<string, unknown>,
  result: "driver_file_missing" | "driver_error" | "driver_invalid_json" | "driver_invalid_result",
  message: string,
  deps: Pick<AutomationRunnerDeps, "now" | "saveState">,
  state: AutomationState,
): void {
  entry.lastDriverAction = result === "driver_error" || result === "driver_file_missing" ? "error" : "invalid";
  entry.lastError = message;
  recordAutomationResult(entry, result);
  // Set after recordAutomationResult: the host-log reason reads lastSummary, so a failure must
  // stay readable there too — the driver's own success summary would otherwise mask what was
  // actually invalid (#386).
  entry.lastSummary = message;
  entry.updatedAt = deps.now();
  deps.saveState(state);
}

function parseDriverPayload(stdout: string): DriverPayload | null {
  try {
    const parsed = JSON.parse(stdout || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as DriverPayload) : null;
  } catch {
    return null;
  }
}

async function runConfiguredDriver(
  project: NormalizedProject,
  automation: NormalizedAutomation,
  entry: Record<string, unknown>,
  state: AutomationState,
  deps: AutomationRunnerDeps,
  supply: AutomationExecutionSupply,
): Promise<boolean> {
  if (!automation.driverFile) return false;

  const driver = deps.resolveAutomationFileInDir("driver", automation, automation.driverFile, supply);
  if (!driver.found) {
    recordDriverFailure(entry, "driver_file_missing", `driver file not found: ${automation.driverFile}`, deps, state);
    deps.notify?.(`deadloop driver file missing: ${automation.name}`, "warning");
    return true;
  }

  if (deps.isEnabled && !deps.isEnabled()) {
    recordAutomationResult(entry, "disabled_before_driver");
    entry.updatedAt = deps.now();
    deps.saveState(state);
    return true;
  }

  let result: AutomationExecResult;
  try {
    result = await deps.runDriver(project, automation, driver.resolved, supply);
  } catch (error) {
    recordDriverFailure(entry, "driver_error", error instanceof Error ? error.message : String(error), deps, state);
    deps.notify?.(`deadloop driver failed: ${automation.name}`, "warning");
    return true;
  }

  if (result.code !== 0) {
    recordDriverFailure(
      entry,
      "driver_error",
      firstNonEmpty(result.stderr, result.stdout, `driver exited ${result.code}`),
      deps,
      state,
    );
    deps.notify?.(`deadloop driver failed: ${automation.name}`, "warning");
    return true;
  }

  const payload = parseDriverPayload(result.stdout || "");
  if (!payload) {
    recordDriverFailure(entry, "driver_invalid_json", "driver did not return a JSON object", deps, state);
    deps.notify?.(`deadloop driver returned invalid JSON: ${automation.name}`, "warning");
    return true;
  }

  const action = typeof payload.action === "string" ? payload.action : "";
  const summary = trimText(payload.summary);
  entry.lastDriverAction = action || "invalid";
  if (summary) entry.lastSummary = summary;

  if (action === "skip") {
    recordAutomationResult(entry, "driver_skip");
    entry.lastSkippedAt = deps.now();
    entry.updatedAt = deps.now();
    deps.saveState(state);
    return true;
  }

  if (action === "done") {
    recordAutomationResult(entry, "driver_done");
    entry.updatedAt = deps.now();
    deps.saveState(state);
    return true;
  }

  if (action === "monitor") {
    if (!payload.monitorHandoff || typeof payload.monitorHandoff !== "object" || Array.isArray(payload.monitorHandoff)) {
      recordDriverFailure(entry, "driver_invalid_result", "monitor driver result did not include a monitor handoff", deps, state);
      deps.notify?.(`deadloop driver returned invalid result: ${automation.name}`, "warning");
      return true;
    }
    // Only observed working turns accumulate active work: the quiet launch window is covered by
    // the monitoring launch grace, not by accounting credit.
    payload.monitorAccounting = {
      activeMilliseconds: 0,
      observedAt: new Date(deps.now()).toISOString(),
      runtimeWasWorking: false,
    };
    entry.pendingDriverHandoff = payload;
    recordAutomationResult(entry, "driver_attempt_monitoring");
    entry.updatedAt = deps.now();
    deps.saveState(state);
    // The handoff is registered in state, so its durable sidecar copy is consumed.
    deps.consumeLaunchHandoffSidecar?.(payload);
    deliverPendingDriverHandoff(entry, state, automation.name, deps, { projectId: project.id, automationId: automation.id });
    return true;
  }

  if (action === "error") {
    recordDriverFailure(
      entry,
      "driver_error",
      firstNonEmpty(payload.error, payload.summary, "driver returned error"),
      deps,
      state,
    );
    deps.notify?.(`deadloop driver reported error: ${automation.name}`, "warning");
    return true;
  }

  recordDriverFailure(
    entry,
    "driver_invalid_result",
    `unsupported driver action: ${action || "<missing>"}`,
    deps,
    state,
  );
  deps.notify?.(`deadloop driver returned invalid result: ${automation.name}`, "warning");
  return true;
}

export async function runScheduledAutomation(
  project: NormalizedProject,
  automation: NormalizedAutomation,
  dueSlot: number,
  state: AutomationState,
  deps: AutomationRunnerDeps,
): Promise<void> {
  // This is deliberately before state setup, candidate selection, or any mutation-capable driver.
  await deps.herdrPreflight?.();
  // Execution supply is fixed before any state setup, candidate selection,
  // or mutation-capable driver. A provisioning failure therefore starts nothing.
  const supply = await deps.prepareExecutionSupply();
  const key = automationStateKey(project, automation);
  const entry = state.automations[key] || {};
  state.automations[key] = entry;

  entry.lastScheduledAt = dueSlot;
  entry.lastAttemptAt = deps.now();
  entry.updatedAt = deps.now();
  entry.name = automation.name;
  entry.projectId = project.id;
  entry.schedule = automation.schedule;
  deps.saveState(state);

  if (await runConfiguredDriver(project, automation, entry, state, deps, supply)) {
    // A driver that launched an attempt and then failed must not leave it unmonitored: any
    // surviving durable sidecar from this launch is adopted here (#386).
    adoptOrphanedLaunchHandoffs(entry, state, automation, deps);
    return;
  }
}

/**
 * Restores the monitoring handoff of a launched attempt whose driver outcome failed to carry it.
 * The sidecar is written beside the attempt journal immediately after the launch, so the adoption
 * re-binds exactly the handoff the driver meant to deliver; delivery happens on the next tick.
 */
function adoptOrphanedLaunchHandoffs(
  entry: Record<string, unknown>,
  state: AutomationState,
  automation: NormalizedAutomation,
  deps: Pick<AutomationRunnerDeps, "adoptOrphanedLaunchHandoffs" | "consumeLaunchHandoffSidecar" | "saveState" | "now">,
): void {
  let adopted: Record<string, unknown>[];
  try {
    adopted = deps.adoptOrphanedLaunchHandoffs?.(state, automation) ?? [];
  } catch {
    return;
  }
  const payload = adopted.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate));
  if (!payload || entry.pendingDriverHandoff) return;
  entry.pendingDriverHandoff = payload;
  entry.lastSummary = `${typeof entry.lastSummary === "string" && entry.lastSummary ? `${entry.lastSummary}; ` : ""}`
    + `re-adopted the durable monitor handoff of launched attempt ${attemptIdOf(payload) || "<unknown>"}`;
  entry.updatedAt = deps.now();
  deps.saveState(state);
  deps.consumeLaunchHandoffSidecar?.(payload);
}

function attemptIdOf(payload: Record<string, unknown>): string {
  const handoff = payload.monitorHandoff;
  const input = handoff && typeof handoff === "object" && !Array.isArray(handoff)
    ? (handoff as Record<string, unknown>).input
    : undefined;
  const attemptRecordFile = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>).attemptRecordFile
    : undefined;
  return typeof attemptRecordFile === "string" ? path.basename(path.dirname(attemptRecordFile)) : "";
}
