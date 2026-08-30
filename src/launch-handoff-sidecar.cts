// Durable monitor-handoff sidecar beside the attempt journal (#386).
//
// The coordinator driver writes the exact monitor handoff it is about to return right after a
// launch succeeds, so a driver outcome that arrives invalid (crash, truncated output, missing
// monitorHandoff) still leaves the handoff on disk. The runner adopts an unconsumed sidecar in the
// same tick, keeping launch and monitoring handoff from being separated by a lost driver result.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const { readAttemptRecord } = require("./attempt-lifecycle-runtime.cjs");

const SIDE_CAR_FILE = "monitor-handoff.json";

/** One atomic write so a concurrent reader never observes a half-written handoff. */
function writeLaunchHandoffSidecar(attemptRecordFile: string, payload: Record<string, unknown>): void {
  const target = path.join(path.dirname(attemptRecordFile), SIDE_CAR_FILE);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
}

function handoffInputOf(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (payload.action !== "monitor") return undefined;
  const handoff = payload.monitorHandoff;
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return undefined;
  const input = (handoff as Record<string, unknown>).input;
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function handoffAttemptRecordFileOf(payload: Record<string, unknown>): string | undefined {
  const attemptRecordFile = handoffInputOf(payload)?.attemptRecordFile;
  return typeof attemptRecordFile === "string" && attemptRecordFile.trim()
    ? path.resolve(attemptRecordFile)
    : undefined;
}

/** Removes a consumed sidecar; a failure never changes the outcome that already adopted it. */
function consumeLaunchHandoffSidecar(payload: Record<string, unknown>): void {
  try {
    const recordFile = handoffAttemptRecordFileOf(payload);
    if (!recordFile) return;
    fs.rmSync(path.join(path.dirname(recordFile), SIDE_CAR_FILE), { force: true });
  } catch {}
}

/**
 * One orphaned launch: a sidecar whose attempt journal still sits at phase `agent_started` and that
 * no pendingDriverHandoff in the shared state references. The runner consumes valid deliveries and
 * adopted handoffs, so a surviving sidecar means its monitoring handoff was lost.
 */
function collectOrphanedLaunchHandoffs(input: {
  runsRoot: string;
  projectId: string;
  monitoredAttemptRecordFiles: ReadonlySet<string>;
  now: number;
}): { attemptId: string; sidecarPath: string; payload: Record<string, unknown> }[] {
  let entries: string[];
  try { entries = fs.readdirSync(input.runsRoot); } catch { return []; }
  const collected: { attemptId: string; sidecarPath: string; payload: Record<string, unknown> }[] = [];
  for (const entry of entries) {
    const runDir = path.join(input.runsRoot, entry);
    const sidecarPath = path.join(runDir, SIDE_CAR_FILE);
    if (!fs.existsSync(sidecarPath)) continue;
    const payload = readPayload(sidecarPath);
    if (!payload) continue;
    const recordFile = handoffAttemptRecordFileOf(payload);
    if (!recordFile || path.dirname(recordFile) !== runDir) continue;
    const projectId = handoffInputOf(payload)?.projectId;
    if (typeof projectId !== "string" || projectId !== input.projectId) continue;
    if (input.monitoredAttemptRecordFiles.has(recordFile)) continue;
    let record;
    try { record = readAttemptRecord(runDir); }
    catch { continue; }
    if (record.phase !== "agent_started") continue;
    collected.push({
      attemptId: String(record.attemptId || path.basename(runDir)),
      sidecarPath,
      payload: withInitialMonitorAccounting(payload, input.now),
    });
  }
  return collected;
}

function readPayload(pathname: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(pathname, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Adds the zero accounting a freshly launched attempt starts from when the sidecar lacks one. */
function withInitialMonitorAccounting(payload: Record<string, unknown>, now: number): Record<string, unknown> {
  const stored = payload.monitorAccounting;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) return payload;
  return {
    ...payload,
    monitorAccounting: { activeMilliseconds: 0, observedAt: new Date(now).toISOString(), runtimeWasWorking: false },
  };
}

module.exports = { collectOrphanedLaunchHandoffs, consumeLaunchHandoffSidecar, withInitialMonitorAccounting, writeLaunchHandoffSidecar };
