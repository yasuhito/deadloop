import { describe, expect, it } from "vitest";

const { decideAttemptMonitoring } = require("../src/attempt-monitoring.cts");

const started = "2026-08-21T00:00:00.000Z";
const later = "2026-08-21T00:01:00.000Z";
const accounting = { activeMilliseconds: 0, observedAt: started, runtimeWasWorking: true };
const input = {
  attempt: { phase: "agent_started" },
  report: { kind: "missing" },
  runtime: { kind: "working" },
  accounting,
  maxActiveMilliseconds: 86_400_000,
  now: later,
};

describe("attempt monitoring", () => {
  it("keeps a runtime-reported working attempt active despite quiet output", () => {
    expect(decideAttemptMonitoring({ ...input, output: { kind: "quiet" } })).toEqual({
      action: "working",
      accounting: { activeMilliseconds: 60_000, observedAt: later, runtimeWasWorking: true },
    });
  });

  it("directs a valid completion report to its bound handler", () => {
    expect(decideAttemptMonitoring({ ...input, report: { kind: "valid", value: { status: "complete" } } })).toEqual({
      action: "completion",
      accounting: { activeMilliseconds: 60_000, observedAt: later, runtimeWasWorking: true },
      report: { status: "complete" },
    });
  });

  it("reports a terminal attempt with no completion report", () => {
    expect(decideAttemptMonitoring({ ...input, runtime: { kind: "terminal", status: "done" } })).toEqual({
      action: "missing_report",
      accounting: { activeMilliseconds: 60_000, observedAt: later, runtimeWasWorking: false },
      reason: "terminal_without_report",
    });
  });

  it("times out work at the configured active-work limit", () => {
    expect(decideAttemptMonitoring({ ...input, accounting: { ...accounting, activeMilliseconds: 86_340_000 } })).toEqual({
      action: "timeout",
      accounting: { activeMilliseconds: 86_400_000, observedAt: later, runtimeWasWorking: true },
      reason: "active_work_limit",
    });
  });

  it("preserves an ambiguous runtime observation", () => {
    expect(decideAttemptMonitoring({ ...input, runtime: { kind: "ambiguous" } })).toEqual({
      action: "ambiguity",
      accounting: { activeMilliseconds: 60_000, observedAt: later, runtimeWasWorking: false },
      reason: "runtime_ambiguous",
    });
  });

  it("does not count model-availability waiting as active work", () => {
    expect(decideAttemptMonitoring({
      ...input,
      accounting: { activeMilliseconds: 12_000, observedAt: started, runtimeWasWorking: false },
      runtime: { kind: "terminal", status: "done", terminalEvidence: "credit balance is too low" },
    })).toMatchObject({ accounting: { activeMilliseconds: 12_000 } });
  });
});
