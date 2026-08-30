const { isModelAvailabilityRejection, parseProviderRetryAt } = require("./model-availability.cts");

type JsonObject = Record<string, any>;

type ActiveWorkAccounting = {
  activeMilliseconds: number;
  observedAt: string;
  runtimeWasWorking: boolean;
};

type CompletionReportObservation =
  | { kind: "missing" }
  | { kind: "invalid"; cause?: "storage_exhaustion"; detail?: string }
  | { kind: "valid"; value: JsonObject };

type ExecutionRuntimeObservation =
  | { kind: "working" }
  | { kind: "terminal"; status: string; terminalEvidence?: string }
  | { kind: "owner_absent" }
  | { kind: "ambiguous" | "unreachable" };

type AttemptMonitoringInput = {
  attempt: JsonObject;
  report: CompletionReportObservation;
  runtime: ExecutionRuntimeObservation;
  accounting: ActiveWorkAccounting;
  maxActiveMilliseconds: number;
  now: string;
};

type AttemptMonitoringDirective =
  | { action: "settled"; accounting: ActiveWorkAccounting }
  | { action: "working"; accounting: ActiveWorkAccounting }
  | { action: "completion"; accounting: ActiveWorkAccounting; report: JsonObject }
  | { action: "missing_report"; accounting: ActiveWorkAccounting; reason: "terminal_without_report" | "invalid_completion_report" | "storage_exhaustion" | "model_availability"; providerRetryAt?: string | null; detail?: string }
  | { action: "timeout"; accounting: ActiveWorkAccounting; reason: "active_work_limit" }
  | { action: "ambiguity"; accounting: ActiveWorkAccounting; reason: "runtime_ambiguous" | "runtime_unreachable" };

const RELEASED_PHASES = new Set(["github_persisted", "workspace_closed", "authority_released", "abandoned"]);
function accountActiveWork(
  accounting: ActiveWorkAccounting,
  now: string,
  runtimeWasWorking: boolean,
): ActiveWorkAccounting {
  const observedAt = Date.parse(accounting.observedAt);
  const current = Date.parse(now);
  const elapsed = Number.isFinite(observedAt) && Number.isFinite(current)
    ? Math.max(0, current - observedAt)
    : 0;
  return {
    activeMilliseconds: Math.max(0, accounting.activeMilliseconds) + (accounting.runtimeWasWorking ? elapsed : 0),
    observedAt: now,
    runtimeWasWorking,
  };
}

function decideAttemptMonitoring(input: AttemptMonitoringInput): AttemptMonitoringDirective {
  const runtimeWorking = input.runtime.kind === "working";
  const accounting = accountActiveWork(input.accounting, input.now, runtimeWorking);
  if (RELEASED_PHASES.has(String(input.attempt?.phase || ""))) return { action: "settled", accounting };
  // The bound report is completion authority. An agent writes it immediately before ending its turn,
  // so runtime observation may still lag as `working`; waiting for a second status would strand the
  // report in that race. Runtime working outranks output silence and errors, never a valid report.
  if (input.report.kind === "valid") return { action: "completion", accounting, report: input.report.value };
  if (runtimeWorking && accounting.activeMilliseconds >= input.maxActiveMilliseconds) {
    return { action: "timeout", accounting, reason: "active_work_limit" };
  }
  if (runtimeWorking) return { action: "working", accounting };
  if (input.runtime.kind === "ambiguous" || input.runtime.kind === "unreachable") {
    return {
      action: "ambiguity",
      accounting,
      reason: input.runtime.kind === "ambiguous" ? "runtime_ambiguous" : "runtime_unreachable",
    };
  }
  if (input.report.kind === "invalid") {
    return {
      action: "missing_report",
      accounting,
      reason: input.report.cause === "storage_exhaustion" ? "storage_exhaustion" : "invalid_completion_report",
      ...(input.report.detail ? { detail: input.report.detail } : {}),
    };
  }
  if (input.runtime.kind === "terminal" && isModelAvailabilityRejection(input.runtime.terminalEvidence)) {
    return {
      action: "missing_report",
      accounting,
      reason: "model_availability",
      providerRetryAt: parseProviderRetryAt(input.runtime.terminalEvidence, Date.parse(input.now)),
    };
  }
  return { action: "missing_report", accounting, reason: "terminal_without_report" };
}

module.exports = { accountActiveWork, decideAttemptMonitoring };
