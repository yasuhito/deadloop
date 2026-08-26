export type MonitorHandoffDisposition =
  | { action: "continue_legacy_monitor" }
  | { action: "settled" }
  | { action: "wait_for_model"; reason: "model_availability" }
  | { action: "stop"; reason: "missing_completion_report" | "invalid_completion_report" }
  | { action: "preserve"; reason: "runtime_ambiguous" | "runtime_unreachable" };
