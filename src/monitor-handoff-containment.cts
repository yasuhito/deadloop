import type { MonitorHandoffDisposition } from "./monitor-handoff-types";

const { isModelAvailabilityRejection } = require("./model-availability.cts");

type JsonObject = Record<string, any>;

type MonitorContainmentInput = {
  record: JsonObject;
  report: { kind: "missing" | "valid" | "invalid"; cause?: "storage_exhaustion" };
  runtime:
    | { kind: "working" }
    | { kind: "terminal"; status: string; terminalEvidence?: string }
    | { kind: "owner_absent" }
    | { kind: "ambiguous" | "unreachable" };
};

const RELEASED_PHASES = new Set(["github_persisted", "workspace_closed", "authority_released", "abandoned"]);
function decideMonitorContainment(input: MonitorContainmentInput): MonitorHandoffDisposition {
  if (RELEASED_PHASES.has(String(input.record?.phase || ""))) return { action: "settled" };
  if (input.report.kind === "valid") return { action: "continue_monitoring" };
  if (input.runtime.kind === "working") return { action: "continue_monitoring" };
  if (input.runtime.kind === "ambiguous" || input.runtime.kind === "unreachable") {
    return input.runtime.kind === "ambiguous"
      ? { action: "preserve", reason: "runtime_ambiguous" }
      : { action: "preserve", reason: "runtime_unreachable" };
  }
  if (
    input.runtime.kind === "terminal" &&
    isModelAvailabilityRejection(input.runtime.terminalEvidence)
  ) {
    return { action: "wait_for_model", reason: "model_availability" };
  }
  return {
    action: "stop",
    reason: input.report.kind === "invalid"
      ? input.report.cause === "storage_exhaustion" ? "storage_exhaustion" : "invalid_completion_report"
      : "missing_completion_report",
  };
}

module.exports = { decideMonitorContainment, isModelAvailabilityRejection };
