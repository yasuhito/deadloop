export type ActiveWorkAccounting = {
  activeMilliseconds: number;
  observedAt: string;
  runtimeWasWorking: boolean;
};

export type AttemptMonitoringDirective =
  | { action: "settled"; accounting: ActiveWorkAccounting }
  | { action: "working"; accounting: ActiveWorkAccounting }
  | { action: "completion"; accounting: ActiveWorkAccounting; report: Record<string, unknown> }
  | { action: "missing_report"; accounting: ActiveWorkAccounting; reason: "terminal_without_report" | "invalid_completion_report" | "storage_exhaustion" | "model_availability"; providerRetryAt?: string | null }
  | { action: "timeout"; accounting: ActiveWorkAccounting; reason: "active_work_limit" }
  | { action: "ambiguity"; accounting: ActiveWorkAccounting; reason: "runtime_ambiguous" | "runtime_unreachable" };

export type AttemptMonitoringApplication = {
  applied: boolean;
  retain?: boolean;
  nextHandoff?: Record<string, unknown>;
  error?: unknown;
};

export type MonitorHandoffDisposition =
  | { action: "continue_monitoring" }
  | { action: "settled" }
  | { action: "wait_for_model"; reason: "model_availability" }
  | { action: "stop"; reason: "missing_completion_report" | "invalid_completion_report" | "storage_exhaustion" | "active_work_timeout" }
  | { action: "preserve"; reason: "runtime_ambiguous" | "runtime_unreachable" };
