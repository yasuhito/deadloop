import { describe, expect, it } from "vitest";

const { decideMonitorContainment } = require("../src/monitor-handoff-containment.cts");

const activeRecord = { phase: "agent_started" };
const missingReport = { kind: "missing" };

describe("retained monitor containment", () => {
  it("keeps the legacy monitor path for a working agent", () => {
    expect(decideMonitorContainment({ record: activeRecord, report: missingReport, runtime: { kind: "working" } })).toEqual({ action: "continue_monitoring" });
  });

  it("processes a completion report before runtime terminal state", () => {
    expect(decideMonitorContainment({ record: activeRecord, report: { kind: "valid" }, runtime: { kind: "terminal", status: "done" } })).toEqual({ action: "continue_monitoring" });
  });

  it("waits after a recognized terminal model availability rejection", () => {
    expect(decideMonitorContainment({ record: activeRecord, report: missingReport, runtime: { kind: "terminal", status: "done", terminalEvidence: "Your credit balance is too low to access this model" } })).toEqual({ action: "wait_for_model", reason: "model_availability" });
  });

  it("stops every other terminal turn without a report", () => {
    expect(decideMonitorContainment({ record: activeRecord, report: missingReport, runtime: { kind: "terminal", status: "idle", terminalEvidence: "command failed" } })).toEqual({ action: "stop", reason: "missing_completion_report" });
  });

  it("stops an absent owner without a report", () => {
    expect(decideMonitorContainment({ record: activeRecord, report: missingReport, runtime: { kind: "owner_absent" } })).toEqual({ action: "stop", reason: "missing_completion_report" });
  });

  it("does not infer model availability from an intermediate session error", () => {
    expect(decideMonitorContainment({
      record: activeRecord,
      report: missingReport,
      runtime: { kind: "terminal", status: "done", terminalEvidence: "credit balance is too low\nwork recovered\nfinished without report" },
    })).toEqual({ action: "stop", reason: "missing_completion_report" });
  });

  it("does not infer model availability from generic terminal text", () => {
    expect(decideMonitorContainment({ record: activeRecord, report: missingReport, runtime: { kind: "terminal", status: "done", terminalEvidence: "The implementation discusses a model unavailable state." } })).toEqual({ action: "stop", reason: "missing_completion_report" });
  });

  it("never calls a stop storage exhaustion on terminal output alone, even when it names ENOSPC", () => {
    expect(decideMonitorContainment({ record: activeRecord, report: missingReport, runtime: { kind: "terminal", status: "done", terminalEvidence: "write failed: ENOSPC: no space left on device" } })).toEqual({ action: "stop", reason: "missing_completion_report" });
  });

  it("preserves an unobservable attempt without invoking the monitor", () => {
    expect(decideMonitorContainment({ record: activeRecord, report: missingReport, runtime: { kind: "ambiguous" } })).toEqual({ action: "preserve", reason: "runtime_ambiguous" });
  });

  it("settles a monitor whose attempt already released ownership", () => {
    expect(decideMonitorContainment({ record: { phase: "authority_released" }, report: missingReport, runtime: { kind: "terminal", status: "done" } })).toEqual({ action: "settled" });
  });
});
