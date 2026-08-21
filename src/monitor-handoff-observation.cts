const fs = require("node:fs") as typeof import("node:fs");

const { validateCompletionReportBinding } = require("./attempt-lifecycle-runtime.cjs");
const { observeAttemptTurn } = require("./attempt-runtime-observation.cts");
const { decideMonitorContainment } = require("./monitor-handoff-containment.cts");

import type { AttemptAgentRunner } from "./attempt-runtime-observation-types";
import type { MonitorHandoffDisposition } from "./monitor-handoff-types";

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

function reportObservation(record: JsonObject): { kind: "missing" | "valid" | "invalid"; value?: JsonObject } {
  try {
    const value = JSON.parse(fs.readFileSync(record.promiseFile, "utf8"));
    validateCompletionReportBinding(record, value);
    return { kind: "valid", value };
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "invalid" };
  }
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
  let runtime;
  try {
    runtime = observeAttemptTurn(dependencies.runner, record);
    if (runtime.kind === "terminal") {
      runtime = { ...runtime, terminalEvidence: dependencies.readTerminalEvidence(record) };
    }
  } catch {
    runtime = { kind: "unreachable" };
  }
  return decideMonitorContainment({ record, report, runtime });
}

module.exports = { observeMonitorHandoffDisposition, reportObservation, terminalEvidenceArgs };
