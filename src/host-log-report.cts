// Read-only operator reporting over the host activity log. Mirrors model-usage-report.cts: pure
// presentation over the persisted JSONL; nothing here writes state or gates scheduling.

const { HOST_LOG_FILE_NAME, hostLogFile, readHostLogTail } = require("./host-log.cts") as {
  HOST_LOG_FILE_NAME: string;
  hostLogFile: (stateDir: string) => string;
  readHostLogTail: (stateDir: string, count?: number) => Record<string, unknown>[];
};

import type { HostLogEvent } from "./host-log-types";

function field(name: keyof HostLogEvent, event: HostLogEvent): string {
  const value = String(event[name] ?? "").trim();
  return value ? ` ${name === "attemptId" ? "attempt" : name}=${value}` : "";
}

function formatHostLogEntry(event: HostLogEvent): string {
  const kind = String(event.kind || "?").padEnd(22);
  return `${event.at || "unknown-time"}  ${kind}${field("projectId", event)}${field("automationId", event)}${field("result", event)}${field("role", event)}${field("attemptId", event)}`.trimEnd();
}

function formatHostLogTail(stateDir: string, count = 20): string {
  let entries: HostLogEvent[] = [];
  try {
    entries = readHostLogTail(stateDir, count) as HostLogEvent[];
  } catch {}
  if (!entries.length) {
    return [
      `the deadloop host activity log has no entries yet; it appears as ticks judge work (${HOST_LOG_FILE_NAME}).`,
      "",
      `source: ${hostLogFile(stateDir)}`,
    ].join("\n");
  }
  return [
    ...entries.map(formatHostLogEntry),
    "",
    `source: ${hostLogFile(stateDir)} (one JSON object per line; tail N with /deadloop-hostlog N, or read it with jq)`,
  ].join("\n");
}

/**
 * Operator-facing view of the most recent `count` events. The file itself stays machine-readable
 * JSONL; this rendering exists so /deadloop-hostlog answers at a glance and always names its source.
 */
module.exports = { formatHostLogTail };
