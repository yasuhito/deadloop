#!/usr/bin/env node
// Decide whether issue-coordinator should keep watching a Worker. CommonJS-shaped
// so it can run directly with `node worker-watch-decision.ts`.

const fs = require("node:fs") as typeof import("node:fs");

type WorkerWatchObservation = Record<string, any>;

const RECENT_WORKER_ACTIVITY_SECONDS = 600;
const MIN_POST_NUDGE_GRACE_SECONDS = 300;
const ACTIVE_AGENT_STATUSES = new Set(["active", "busy", "running", "working"]);
const SETTLED_PROMISE_STATUSES = new Set(["complete", "blocked"]);

const TOP_LEVEL_ACTIVITY_KEYS = [
  "lastActivityAt",
  "lastToolActivityAt",
  "lastFileReadAt",
  "lastAgentSessionUpdatedAt",
  "agentUpdatedAt",
  "sessionUpdatedAt",
  "paneUpdatedAt",
  "recentOutputAt",
];
const NESTED_ACTIVITY_KEYS = ["lastActivityAt", "updatedAt", "lastUpdatedAt", "lastOutputAt"];
const NESTED_ACTIVITY_OBJECTS = ["agent", "session", "pane"];
const SESSION_ACTIVITY_KINDS = new Set(["agent_session", "session"]);
const PANE_OUTPUT_ACTIVITY_KINDS = new Set(["pane_output", "output"]);

function parseTimeForWorkerWatch(value: unknown): Date | null {
  if (!value) return null;
  if (typeof value === "number") {
    const parsed = new Date(value * 1000);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const text = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2}T/.test(text) && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(text) ? `${text}Z` : text;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function secondsBetweenForWorkerWatch(now: Date, past: Date | null): number | null {
  if (!past) return null;
  return Math.floor((now.getTime() - past.getTime()) / 1000);
}

function iterActivityTimesForWorkerWatch(observation: WorkerWatchObservation): Date[] {
  const times: Date[] = [];
  for (const key of TOP_LEVEL_ACTIVITY_KEYS) {
    const parsed = parseTimeForWorkerWatch(observation[key]);
    if (parsed) times.push(parsed);
  }

  for (const objectKey of NESTED_ACTIVITY_OBJECTS) {
    const nested = observation[objectKey];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    for (const key of NESTED_ACTIVITY_KEYS) {
      const parsed = parseTimeForWorkerWatch(nested[key]);
      if (parsed) times.push(parsed);
    }
  }

  for (const event of observation.activity || observation.events || []) {
    if (!event || typeof event !== "object") continue;
    const parsed = parseTimeForWorkerWatch(event.at || event.createdAt || event.updatedAt);
    if (parsed) times.push(parsed);
  }
  return times;
}

function latestActivityAtForWorkerWatch(observation: WorkerWatchObservation): Date | null {
  const times = iterActivityTimesForWorkerWatch(observation);
  if (!times.length) return null;
  return new Date(Math.max(...times.map((time) => time.getTime())));
}

function activeAgentStatusForWorkerWatch(observation: WorkerWatchObservation): string {
  const direct = observation.agentStatus || observation.agent_status || observation.status;
  if (direct) return String(direct).toLowerCase();
  const agent = observation.agent;
  if (agent && typeof agent === "object") return String(agent.agent_status || agent.status || "").toLowerCase();
  return "";
}

function activityKindsForWorkerWatch(observation: WorkerWatchObservation): Set<string> {
  const kinds = new Set<string>();
  for (const event of observation.activity || observation.events || []) {
    if (event && typeof event === "object" && event.kind) kinds.add(String(event.kind));
  }
  return kinds;
}

function hasAnyWorkerWatchKey(data: WorkerWatchObservation, keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(data, key));
}

function hasCheckedWorkerWatchNestedObject(observation: WorkerWatchObservation, objectKey: string): boolean {
  const nested = observation[objectKey];
  return Boolean(nested && typeof nested === "object" && hasAnyWorkerWatchKey(nested, NESTED_ACTIVITY_KEYS));
}

function setIntersectsForWorkerWatch(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function missingRequiredObservationsForWorkerWatch(observation: WorkerWatchObservation): string[] {
  const missing: string[] = [];
  const kinds = activityKindsForWorkerWatch(observation);
  if (!activeAgentStatusForWorkerWatch(observation)) missing.push("agent_status");
  if (
    !(
      hasAnyWorkerWatchKey(observation, ["lastAgentSessionUpdatedAt", "agentUpdatedAt", "sessionUpdatedAt"]) ||
      hasCheckedWorkerWatchNestedObject(observation, "agent") ||
      hasCheckedWorkerWatchNestedObject(observation, "session") ||
      setIntersectsForWorkerWatch(kinds, SESSION_ACTIVITY_KINDS)
    )
  ) {
    missing.push("agent_session_updated_at");
  }
  if (
    !(
      hasAnyWorkerWatchKey(observation, ["paneUpdatedAt", "recentOutputAt"]) ||
      hasCheckedWorkerWatchNestedObject(observation, "pane") ||
      setIntersectsForWorkerWatch(kinds, PANE_OUTPUT_ACTIVITY_KINDS)
    )
  ) {
    missing.push("pane_recent_output");
  }
  return missing;
}

function parseBoolForWorkerWatch(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  return Boolean(value);
}

function isoForWorkerWatch(value: Date | null): string | null {
  return value ? value.toISOString().replace(".000Z", "Z") : null;
}

function buildWorkerWatchObservations(
  observation: WorkerWatchObservation,
  now: Date,
  lastActivity: Date | null,
  nudgeSentAt: Date | null,
): WorkerWatchObservation {
  return {
    promiseStatus: String(observation.promiseStatus || observation.promise_status || "none"),
    worktreeHasChanges: parseBoolForWorkerWatch(observation.worktreeHasChanges ?? false),
    agentStatus: activeAgentStatusForWorkerWatch(observation),
    lastActivityAt: isoForWorkerWatch(lastActivity),
    secondsSinceLastActivity: secondsBetweenForWorkerWatch(now, lastActivity),
    nudgeSentAt: isoForWorkerWatch(nudgeSentAt),
    secondsSinceNudge: secondsBetweenForWorkerWatch(now, nudgeSentAt),
    recentWorkerActivitySeconds: RECENT_WORKER_ACTIVITY_SECONDS,
    minPostNudgeGraceSeconds: MIN_POST_NUDGE_GRACE_SECONDS,
  };
}

function closeLogForWorkerWatch(observations: WorkerWatchObservation): string {
  return [
    `promise=${observations.promiseStatus}`,
    `agentStatus=${observations.agentStatus || "unknown"}`,
    `lastActivityAt=${observations.lastActivityAt || "unknown"}`,
    `secondsSinceLastActivity=${observations.secondsSinceLastActivity}`,
    `nudgeSentAt=${observations.nudgeSentAt || "unknown"}`,
    `secondsSinceNudge=${observations.secondsSinceNudge}`,
    `minPostNudgeGraceSeconds=${observations.minPostNudgeGraceSeconds}`,
    `worktreeHasChanges=${String(observations.worktreeHasChanges).toLowerCase()}`,
  ].join("; ");
}

function decideWorkerWatch(observation: WorkerWatchObservation): WorkerWatchObservation {
  const now = parseTimeForWorkerWatch(observation.now) || new Date();
  const promiseStatus = String(observation.promiseStatus || observation.promise_status || "none");
  const lastActivity = latestActivityAtForWorkerWatch(observation);
  const nudgeSentAt = parseTimeForWorkerWatch(observation.nudgeSentAt || observation.lastNudgeAt);
  const observations = buildWorkerWatchObservations(observation, now, lastActivity, nudgeSentAt);

  if (SETTLED_PROMISE_STATUSES.has(promiseStatus)) {
    return { action: "promise_settled", reason: promiseStatus, observations };
  }

  const agentStatus = observations.agentStatus;
  if (ACTIVE_AGENT_STATUSES.has(agentStatus)) {
    return { action: "continue_waiting", reason: "agent_status_active", observations };
  }

  const activityAge = observations.secondsSinceLastActivity;
  if (activityAge !== null && activityAge <= RECENT_WORKER_ACTIVITY_SECONDS) {
    return { action: "continue_waiting", reason: "recent_activity", observations };
  }

  if (!nudgeSentAt) {
    return { action: "nudge_worker", reason: "missing_promise", observations };
  }

  const nudgeAge = observations.secondsSinceNudge;
  if (nudgeAge === null || nudgeAge < MIN_POST_NUDGE_GRACE_SECONDS) {
    return { action: "continue_waiting", reason: "nudge_grace_period", observations };
  }

  const missingObservations = missingRequiredObservationsForWorkerWatch(observation);
  if (missingObservations.length) {
    return {
      action: "collect_observations",
      reason: "missing_required_observations",
      missingObservations,
      observations,
    };
  }

  return {
    action: "may_close_pane",
    reason: "inactive_after_grace",
    observations,
    closeLog: closeLogForWorkerWatch(observations),
  };
}

function loadWorkerWatchInput(file: string | undefined): WorkerWatchObservation {
  const data = JSON.parse(file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("watch observation JSON must be an object");
  return data;
}

function requiredWorkerWatchValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseWorkerWatchArgs(argv: string[]): WorkerWatchObservation {
  const parsed: WorkerWatchObservation = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input") {
      parsed.input = requiredWorkerWatchValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === "--now") {
      parsed.now = requiredWorkerWatchValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown flag: ${token}`);
  }
  return parsed;
}

function workerWatchHelp(): string {
  return "Usage: worker-watch-decision.ts [--input FILE] [--now ISO_TIMESTAMP]";
}

function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseWorkerWatchArgs(argv);
  if (args.help) {
    process.stdout.write(`${workerWatchHelp()}\n`);
    return 0;
  }
  const observation = loadWorkerWatchInput(args.input);
  if (args.now) observation.now = args.now;
  process.stdout.write(`${JSON.stringify(decideWorkerWatch(observation))}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`worker-watch-decision.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

module.exports = { decideWorkerWatch };
