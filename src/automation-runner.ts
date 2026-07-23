import {
  automationStateKey,
  type AutomationFileResolution,
  type NormalizedAutomation,
  type NormalizedProject,
} from "./core";

const { renderPendingMonitorHandoff } = require("./monitor-prompts.ts");

export type AutomationExecResult = {
  code: number;
  stdout?: string;
  stderr?: string;
};

export type AutomationState = {
  automations: Record<string, Record<string, unknown>>;
};

export type AutomationRunnerDeps = {
  currentEnabledAt?: () => number | undefined;
  isEnabled?: () => boolean;
  isIdle?: () => boolean;
  notify?: (message: string, level: "info" | "warning" | "error") => void;
  now: () => number;
  readPrompt: (project: NormalizedProject, automation: NormalizedAutomation, promptFile: string) => string;
  resolveAutomationFileInDir: (
    kind: "precheck" | "prompt" | "driver",
    automation: NormalizedAutomation,
    requested: string | undefined,
  ) => AutomationFileResolution;
  runDriver: (
    project: NormalizedProject,
    automation: NormalizedAutomation,
    driverFile: string,
  ) => Promise<AutomationExecResult>;
  runPrecheck: (
    project: NormalizedProject,
    automation: NormalizedAutomation,
    precheckFile: string,
  ) => Promise<AutomationExecResult>;
  saveState: (state: AutomationState) => void;
  sendUserMessage: (prompt: string) => void;
  sendUserMessageIfEnabled?: (prompt: string) => boolean;
  setStatus?: (text: string) => void;
};

type DriverPayload = {
  action?: unknown;
  summary?: unknown;
  prompt?: unknown;
  error?: unknown;
  [key: string]: unknown;
};

export function deliverPendingDriverHandoff(
  entry: Record<string, unknown>,
  state: AutomationState,
  automationName: string,
  deps: Pick<
    AutomationRunnerDeps,
    "isEnabled" | "notify" | "now" | "saveState" | "sendUserMessage" | "sendUserMessageIfEnabled"
  > & Pick<AutomationRunnerDeps, "currentEnabledAt">,
): boolean {
  const handoff = entry.pendingDriverHandoff;
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return false;
  const payload = handoff as DriverPayload;
  const pendingPrompt = payload.prompt;
  let prompt = typeof pendingPrompt === "string" ? pendingPrompt : "";
  if (payload.monitorHandoff && typeof payload.monitorHandoff === "object" && !Array.isArray(payload.monitorHandoff)) {
    const monitorHandoff = payload.monitorHandoff as { kind?: unknown; input?: unknown };
    const monitorInput = monitorHandoff.input;
    const handoffEnabledAt = monitorInput && typeof monitorInput === "object" && !Array.isArray(monitorInput)
      ? Number((monitorInput as { enabledAt?: unknown }).enabledAt)
      : Number.NaN;
    const currentEnabledAt = deps.currentEnabledAt?.();
    if (
      monitorHandoff.kind === "issue"
      && Number.isFinite(handoffEnabledAt)
      && Number.isFinite(currentEnabledAt)
      && currentEnabledAt !== handoffEnabledAt
    ) {
      delete entry.pendingDriverHandoff;
      recordAutomationResult(entry, "driver_handoff_stale_generation");
      entry.updatedAt = deps.now();
      deps.saveState(state);
      return true;
    }
    try {
      prompt = renderPendingMonitorHandoff(payload.monitorHandoff, currentEnabledAt);
    } catch (error) {
      delete entry.pendingDriverHandoff;
      recordAutomationResult(entry, "driver_invalid_result");
      entry.lastError = error instanceof Error ? error.message : String(error);
      entry.updatedAt = deps.now();
      deps.saveState(state);
      return true;
    }
  }
  if (!prompt) {
    delete entry.pendingDriverHandoff;
    recordAutomationResult(entry, "driver_invalid_result");
    entry.lastError = "pending needs_llm driver result did not include prompt";
    entry.updatedAt = deps.now();
    deps.saveState(state);
    return true;
  }
  if (deps.isEnabled && !deps.isEnabled()) {
    recordAutomationResult(entry, "disabled_before_driver_prompt");
    entry.updatedAt = deps.now();
    deps.saveState(state);
    return true;
  }
  try {
    const queued = deps.sendUserMessageIfEnabled
      ? deps.sendUserMessageIfEnabled(prompt)
      : (deps.sendUserMessage(prompt), true);
    if (!queued) {
      recordAutomationResult(entry, "disabled_before_driver_prompt");
      entry.updatedAt = deps.now();
      deps.saveState(state);
      return true;
    }
    delete entry.pendingDriverHandoff;
    recordAutomationResult(entry, "driver_needs_llm_queued");
    entry.lastQueuedAt = deps.now();
    entry.updatedAt = deps.now();
    deps.saveState(state);
    deps.notify?.(`deadloop queued driver prompt: ${automationName}`, "info");
  } catch (error) {
    recordAutomationResult(entry, "send_error");
    entry.lastError = error instanceof Error ? error.message : String(error);
    entry.updatedAt = deps.now();
    deps.saveState(state);
    deps.notify?.(`deadloop send failed: ${automationName}`, "error");
  }
  return true;
}

function isAutomationFailureResult(result: string): boolean {
  return (
    result === "precheck_error" ||
    result === "send_error" ||
    result === "precheck_file_missing" ||
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
): Promise<boolean> {
  if (!automation.driverFile) return false;

  const driver = deps.resolveAutomationFileInDir("driver", automation, automation.driverFile);
  if (!driver.found) {
    recordDriverFailure(entry, "driver_file_missing", `driver file not found: ${automation.driverFile}`, deps, state);
    deps.notify?.(`deadloop driver file missing: ${automation.name}`, "warning");
    return true;
  }

  let result: AutomationExecResult;
  try {
    result = await deps.runDriver(project, automation, driver.resolved);
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

  if (action === "needs_llm") {
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    if (!prompt) {
      recordDriverFailure(
        entry,
        "driver_invalid_result",
        "needs_llm driver result did not include prompt",
        deps,
        state,
      );
      deps.notify?.(`deadloop driver returned invalid result: ${automation.name}`, "warning");
      return true;
    }
    entry.pendingDriverHandoff = payload;
    recordAutomationResult(entry, "driver_handoff_pending");
    entry.updatedAt = deps.now();
    deps.saveState(state);
    deliverPendingDriverHandoff(entry, state, automation.name, deps);
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

  const precheck = deps.resolveAutomationFileInDir("precheck", automation, automation.precheckFile);
  if (!precheck.found) {
    recordAutomationResult(entry, "precheck_file_missing");
    entry.lastError = `precheck file not found: ${automation.precheckFile}`;
    entry.updatedAt = deps.now();
    deps.saveState(state);
    deps.notify?.(`deadloop precheck file missing: ${automation.name}`, "warning");
    return;
  }

  deps.setStatus?.(`precheck: ${automation.name}`);

  let result: AutomationExecResult;
  try {
    result = await deps.runPrecheck(project, automation, precheck.resolved);
  } catch (error) {
    recordAutomationResult(entry, "precheck_error");
    entry.lastError = error instanceof Error ? error.message : String(error);
    entry.updatedAt = deps.now();
    deps.saveState(state);
    deps.notify?.(`deadloop precheck failed: ${automation.name}`, "warning");
    return;
  }

  if (result.code !== 0) {
    recordAutomationResult(entry, `precheck_skipped:${result.code}`);
    entry.lastSkippedAt = deps.now();
    entry.updatedAt = deps.now();
    deps.saveState(state);
    return;
  }

  if (deps.isIdle && !deps.isIdle()) {
    recordAutomationResult(entry, "deferred_busy_after_precheck");
    entry.updatedAt = deps.now();
    deps.saveState(state);
    return;
  }

  if (deps.isEnabled && !deps.isEnabled()) {
    recordAutomationResult(entry, "disabled_after_precheck");
    entry.updatedAt = deps.now();
    deps.saveState(state);
    return;
  }

  if (deps.isEnabled && !deps.isEnabled()) {
    recordAutomationResult(entry, "disabled_before_driver");
    entry.updatedAt = deps.now();
    deps.saveState(state);
    return;
  }

  if (await runConfiguredDriver(project, automation, entry, state, deps)) return;

  const promptResolution = deps.resolveAutomationFileInDir("prompt", automation, automation.promptFile);
  if (!promptResolution.found) {
    recordAutomationResult(entry, "prompt_file_missing");
    entry.lastError = `prompt file not found: ${automation.promptFile}`;
    entry.updatedAt = deps.now();
    deps.saveState(state);
    deps.notify?.(`deadloop prompt file missing: ${automation.name}`, "warning");
    return;
  }

  if (deps.isEnabled && !deps.isEnabled()) {
    recordAutomationResult(entry, "disabled_before_prompt");
    entry.updatedAt = deps.now();
    deps.saveState(state);
    return;
  }

  try {
    const prompt = deps.readPrompt(project, automation, promptResolution.resolved);
    const queued = deps.sendUserMessageIfEnabled
      ? deps.sendUserMessageIfEnabled(prompt)
      : (deps.sendUserMessage(prompt), true);
    if (!queued) {
      recordAutomationResult(entry, "disabled_before_prompt");
      entry.updatedAt = deps.now();
      deps.saveState(state);
      return;
    }
    recordAutomationResult(entry, "queued");
    entry.lastQueuedAt = deps.now();
    entry.updatedAt = deps.now();
    deps.saveState(state);
    deps.notify?.(`deadloop queued: ${automation.name}`, "info");
  } catch (error) {
    recordAutomationResult(entry, "send_error");
    entry.lastError = error instanceof Error ? error.message : String(error);
    entry.updatedAt = deps.now();
    deps.saveState(state);
    deps.notify?.(`deadloop send failed: ${automation.name}`, "error");
  }
}
