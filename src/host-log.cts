// Appends observational events to the Automation host activity log under the state directory.
//
// The log is observational (issue #370): it records facts about scheduling, attempt launches,
// model waits, and enablement writes for operators; a failed write never influences completion,
// push, merge, or the tick that produced the event. A failed append is copied beside the log
// (`host-log-errors.jsonl`) when even that write succeeds, and swallowed otherwise.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const HOST_LOG_FILE_NAME = "host-log.jsonl";
const HOST_LOG_ERRORS_FILE_NAME = "host-log-errors.jsonl";

function hostLogFile(stateDir: string): string {
  return path.join(stateDir, HOST_LOG_FILE_NAME);
}

function hostLogErrorsFile(stateDir: string): string {
  return path.join(stateDir, HOST_LOG_ERRORS_FILE_NAME);
}

function textOrEmpty(value: unknown): string {
  const text = String(value ?? "").trim();
  return text.length ? text : "";
}

function recordHostLogError(stateDir: string, error: unknown, now: Date): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      hostLogErrorsFile(stateDir),
      `${JSON.stringify({ at: now.toISOString(), error: error instanceof Error ? error.message : String(error) })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {}
}

function hostLogLine(event: Record<string, unknown>, now: Date): string {
  const line: Record<string, unknown> = {
    schemaVersion: 1,
    at: now.toISOString(),
    kind: textOrEmpty(event.kind),
    projectId: textOrEmpty(event.projectId),
    automationId: textOrEmpty(event.automationId),
    result: textOrEmpty(event.result),
    reason: textOrEmpty(event.reason),
  };
  for (const key of ["driverAction", "role", "attemptId", "dueAt"] as const) {
    const value = textOrEmpty(event[key]);
    if (value) line[key] = value;
  }
  if (typeof event.durationMs === "number" && Number.isFinite(event.durationMs)) line.durationMs = event.durationMs;
  return JSON.stringify(line);
}

/**
 * Appends one event observationally. Never throws: on failure it records why beside the log and
 * reports `false` so callers may note degradation without changing their own outcome.
 */
function appendHostLogEvent(stateDir: string, event: Record<string, unknown>, now: Date = new Date()): boolean {
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(hostLogFile(stateDir), `${hostLogLine(event, now)}\n`, { encoding: "utf8", mode: 0o600 });
    return true;
  } catch (error) {
    recordHostLogError(stateDir, error, now);
    return false;
  }
}

// Tail reads cap their window so an old, large log cannot make the /deadloop-hostlog command
// scan unbounded history for twenty lines.
const TAIL_WINDOW_BYTES = 16 * 1024 * 1024;

function readTailRegion(stateDir: string): Buffer {
  try {
    const content = fs.readFileSync(hostLogFile(stateDir));
    if (content.length <= TAIL_WINDOW_BYTES) return content;
    const newlineAt = content.indexOf(0x0a, content.length - TAIL_WINDOW_BYTES);
    return content.subarray(newlineAt === -1 ? content.length - TAIL_WINDOW_BYTES : newlineAt + 1);
  } catch {
    return Buffer.alloc(0);
  }
}

/** Returns up to `count` most recent events (oldest first); damaged or partial JSON lines are skipped. */
function readHostLogTail(stateDir: string, count: number | undefined = undefined): Record<string, unknown>[] {
  const wanted = Math.max(0, Math.floor(Number(count ?? 20)));
  const events: Record<string, unknown>[] = [];
  for (const line of readTailRegion(stateDir).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {}
  }
  return events.slice(-wanted);
}

module.exports = { HOST_LOG_FILE_NAME, hostLogFile, hostLogErrorsFile, appendHostLogEvent, readHostLogTail };
