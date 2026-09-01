// 型だけをこのモジュールに分離している：実行時モジュール host-log を CJS のまま保つため。

/**
 * The observational event kinds appended to the Automation host activity log.
 * They answer "why did nothing happen" and "when was what chosen" across ticks:
 * scheduler-level judgments, launched attempts, model waits, and enablement writes.
 */
export type HostLogEventKind =
  | "tick_started"
  | "tick_idle"
  | "tick_blocked"
  | "tick_stopped"
  | "automation_result"
  | "attempt_launched"
  | "reconcile_started"
  | "reconcile_finished"
  | "settled_workspace_closure"
  | "model_wait_transitioned"
  | "automation_starved"
  | "enablement_written"
  | "unreadable_attempt_record";

/**
 * One durable line of the host activity log (`host-log.jsonl`). Every line carries the same core
 * fields so jq-style consumers always see them; sources that cannot know a value leave it empty
 * instead of inventing placeholder identities.
 */
export type HostLogEvent = {
  schemaVersion: 1;
  at: string;
  kind: HostLogEventKind;
  projectId: string;
  automationId: string;
  result: string;
  reason: string;
  driverAction?: string;
  role?: string;
  attemptId?: string;
  /** Milliseconds the reconciled operation held the shared enablement lock (#393). */
  durationMs?: number;
  /** When a starved automation became due, as an ISO timestamp (#402). */
  dueAt?: string;
};

/**
 * What an emitter hands over; the writer fills `schemaVersion`, `at`, and empty-string defaults.
 */
export type HostLogEventInput = { kind: HostLogEventKind } & Partial<
  Omit<HostLogEvent, "schemaVersion" | "at" | "kind">
>;

/** Identifies the automation an emitted event belongs to when the caller already knows both ids. */
export type HostLogEventContext = { projectId?: string; automationId?: string };

type TickHostLogContext = { projectId: string; automationId?: string };

/** What `executeSchedulerTick` emits to the host activity-log sink; each variant carries its own judgment. */
export type TickHostLogEvent =
  | (({ kind: "tick_started" } | { kind: "tick_idle" }) & TickHostLogContext)
  | (({ kind: "tick_blocked"; reason: string } | { kind: "tick_stopped"; reason: string }) & TickHostLogContext)
  | ({
      kind: "automation_starved";
      reason?: string;
      dueAt?: string;
    } & TickHostLogContext)
  | ({
      kind: "automation_result";
      result?: string;
      reason?: string;
      driverAction?: string;
    } & TickHostLogContext);
