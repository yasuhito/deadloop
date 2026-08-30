const fs = require("node:fs") as typeof import("node:fs");

const { validateCompletionReportBinding } = require("./attempt-lifecycle-runtime.cjs");
const { observeAttemptTurn } = require("./attempt-runtime-observation.cts");
const { decideMonitorContainment } = require("./monitor-handoff-containment.cts");
const { decideAttemptMonitoring } = require("./attempt-monitoring.cts");
const { isStorageExhaustionError } = require("./storage-exhaustion.cjs");

import type { AttemptAgentRunner } from "./attempt-runtime-observation-types";
import type { ActiveWorkAccounting, AttemptMonitoringDirective, MonitorHandoffDisposition } from "./monitor-handoff-types";

type JsonObject = Record<string, any>;

type MonitorObservationDependencies = {
  runner: AttemptAgentRunner;
  readTerminalEvidence(record: JsonObject): string;
};

function terminalEvidenceArgs(record: JsonObject): string[] {
  return [
    "agent", "read", record.agentName,
    "--source", "recent-unwrapped", "--lines", "80", "--format", "text",
  ];
}

/** The report file itself is evidence; only its own read failure can name a formal cause. */
function reportObservation(record: JsonObject): { kind: "missing" | "valid" | "invalid"; value?: JsonObject; cause?: "storage_exhaustion"; detail?: string } {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(record.promiseFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { kind: "missing" };
    if (isStorageExhaustionError(error)) return { kind: "invalid", cause: "storage_exhaustion" };
    return { kind: "invalid" };
  }
  try {
    validateCompletionReportBinding(record, value);
    return { kind: "valid", value };
  } catch (error) {
    // Validation messages name the rejected report field; they never contain local paths.
    return { kind: "invalid", detail: String((error as Error | undefined)?.message || "") };
  }
}

function runtimeObservation(
  record: JsonObject,
  dependencies: MonitorObservationDependencies,
): JsonObject {
  try {
    const runtime = observeAttemptTurn(dependencies.runner, record);
    return runtime.kind === "terminal"
      ? { ...runtime, terminalEvidence: dependencies.readTerminalEvidence(record) }
      : runtime;
  } catch {
    return { kind: "unreachable" };
  }
}

function observeAttemptMonitoringDirective(
  record: JsonObject,
  accounting: ActiveWorkAccounting,
  now: number,
  maxActiveMilliseconds: number,
  dependencies: MonitorObservationDependencies,
): AttemptMonitoringDirective {
  return decideAttemptMonitoring({
    attempt: record,
    report: reportObservation(record),
    runtime: runtimeObservation(record, dependencies),
    accounting,
    maxActiveMilliseconds,
    now: new Date(now).toISOString(),
  });
}

function observeMonitorHandoffDisposition(
  record: JsonObject,
  handoffKind: unknown,
  dependencies: MonitorObservationDependencies,
): MonitorHandoffDisposition {
  const report = reportObservation(record);
  if (handoffKind === "branch-update" && report.kind === "valid" && report.value?.status === "blocked") {
    return { action: "settled" };
  }
  return decideMonitorContainment({ record, report, runtime: runtimeObservation(record, dependencies) });
}

module.exports = { observeAttemptMonitoringDirective, observeMonitorHandoffDisposition, reportObservation, runtimeObservation, terminalEvidenceArgs };
