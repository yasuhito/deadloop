const childProcess = require("node:child_process") as typeof import("node:child_process");
const path = require("node:path") as typeof import("node:path");

const { readAttemptRecord } = require("./attempt-lifecycle-runtime.cjs");
const { createHerdrRunner } = require("./herdr-runner.cts");
const { observeAttemptMonitoringDirective, terminalEvidenceArgs } = require("./monitor-handoff-observation.cts");

import type { ActiveWorkAccounting, AttemptMonitoringApplication, AttemptMonitoringDirective } from "./monitor-handoff-types";

type JsonObject = Record<string, any>;

function monitorRuntimeRunner() {
  return createHerdrRunner({
    runText: (command: string, args: string[]) => {
      const result = childProcess.spawnSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(String(result.stderr || result.stdout || `${command} failed`).trim());
      }
      return String(result.stdout || "");
    },
  });
}

function attemptRecordForMonitorHandoff(handoff: JsonObject): JsonObject {
  const input = handoff?.input;
  if (!input || typeof input !== "object") throw new Error("attempt monitor handoff has no input");
  const recordFile = typeof input.attemptRecordFile === "string"
    ? input.attemptRecordFile
    : typeof input.promiseFile === "string" ? path.join(path.dirname(input.promiseFile), "attempt.json") : "";
  if (!recordFile) throw new Error("attempt monitor handoff has no attempt record");
  return readAttemptRecord(path.dirname(recordFile));
}

function terminalEvidence(attempt: JsonObject): string {
  const output = childProcess.spawnSync(
    "herdr",
    terminalEvidenceArgs(attempt),
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL" },
  );
  return output.status === 0 ? String(output.stdout || "") : "";
}

function observeDeterministicAttemptMonitoring(
  handoff: JsonObject,
  accounting: ActiveWorkAccounting,
  now: number,
): AttemptMonitoringDirective {
  const input = handoff.input || {};
  return observeAttemptMonitoringDirective(
    attemptRecordForMonitorHandoff(handoff),
    accounting,
    now,
    Number(input.maxActiveMilliseconds || 86_400_000),
    { runner: monitorRuntimeRunner(), readTerminalEvidence: terminalEvidence },
  );
}

function runDeterministicCompletion(handoff: JsonObject): AttemptMonitoringApplication {
  const script = path.join(String(handoff.input?.automationDir || ""), "complete-deterministic-pr-attempt.cts");
  const completed = childProcess.spawnSync("node", [script], {
    input: JSON.stringify(handoff),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15 * 60_000,
    killSignal: "SIGKILL",
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    throw new Error(String(completed.stderr || completed.stdout || "deterministic PR completion failed").trim());
  }
  return JSON.parse(String(completed.stdout || "{}"));
}

function applyDeterministicAttemptMonitoring(
  handoff: JsonObject,
  directive: Exclude<AttemptMonitoringDirective, { action: "working" | "ambiguity" | "settled" }>,
  applyTerminalDisposition: (handoff: JsonObject, disposition: JsonObject) => boolean,
): AttemptMonitoringApplication {
  if (directive.action === "completion") return runDeterministicCompletion(handoff);
  const disposition = directive.action === "missing_report"
    ? directive.reason === "model_availability"
      ? { action: "wait_for_model", reason: "model_availability" }
      : { action: "stop", reason: directive.reason === "invalid_completion_report" ? "invalid_completion_report" : "missing_completion_report" }
    : {
        action: "stop",
        reason: "active_work_timeout",
        accounting: directive.accounting,
        maxActiveMilliseconds: Number(handoff.input?.maxActiveMilliseconds || 86_400_000),
      };
  return {
    applied: applyTerminalDisposition(handoff, disposition),
    retain: disposition.action === "wait_for_model",
  };
}

module.exports = {
  applyDeterministicAttemptMonitoring,
  attemptRecordForMonitorHandoff,
  monitorRuntimeRunner,
  observeDeterministicAttemptMonitoring,
  runDeterministicCompletion,
};
