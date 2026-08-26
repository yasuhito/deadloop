import type { MonitorHandoffDisposition } from "./monitor-handoff-types";

type JsonObject = Record<string, any>;

type MonitorContainmentInput = {
  record: JsonObject;
  report: { kind: "missing" | "valid" | "invalid" };
  runtime:
    | { kind: "working" }
    | { kind: "terminal"; status: string; terminalEvidence?: string }
    | { kind: "owner_absent" }
    | { kind: "ambiguous" | "unreachable" };
};

const RELEASED_PHASES = new Set(["github_persisted", "workspace_closed", "authority_released", "abandoned"]);
const MODEL_AVAILABILITY_REJECTIONS = [
  /credit balance is too low/i,
  /(?:usage|spending) limit (?:has been )?(?:reached|exceeded)/i,
  /(?:quota|rate limit) (?:has been )?exceeded/i,
  /(?:do not|don't) have access to (?:this |the )?model/i,
];

function isModelAvailabilityRejection(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return MODEL_AVAILABILITY_REJECTIONS.some((pattern) => pattern.test(value));
}

function decideMonitorContainment(input: MonitorContainmentInput): MonitorHandoffDisposition {
  if (RELEASED_PHASES.has(String(input.record?.phase || ""))) return { action: "settled" };
  if (input.report.kind === "valid") return { action: "continue_legacy_monitor" };
  if (input.runtime.kind === "working") return { action: "continue_legacy_monitor" };
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
    reason: input.report.kind === "invalid" ? "invalid_completion_report" : "missing_completion_report",
  };
}

module.exports = { decideMonitorContainment, isModelAvailabilityRejection };
