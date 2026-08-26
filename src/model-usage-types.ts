// 型だけをこのモジュールに分離している：実行時モジュール model-usage を CJS のまま保つため。

export const USAGE_UNKNOWN = "unknown";
export const UNATTRIBUTED_ROLE = "unattributed";

export type UsageValue = number | string;
/** A token count or duration that the source record did not provide. */
export type KnownUsage = number | typeof USAGE_UNKNOWN;
export type UsageRole = AttemptRole | typeof UNATTRIBUTED_ROLE;

import type { AttemptRole } from "./attempt-lifecycle";

export type NormalizedUsageRecord = {
  schemaVersion: 1;
  /** Stable dedup identity: `<sessionId>:<responseId>` from the source session. */
  recordId: string;
  attemptId: string;
  /** Sub-agent and advisor responses stay attributed to the parent attempt. */
  parentAttemptId?: string;
  agentName: string;
  role: UsageRole;
  action: string;
  agentKind: AgentKind;
  provider: string;
  model: string;
  inputTokens: KnownUsage;
  cacheReadTokens: KnownUsage;
  cacheWriteTokens: KnownUsage;
  outputTokens: KnownUsage;
  reasoningTokens: KnownUsage;
  totalTokens: KnownUsage;
  durationMilliseconds: KnownUsage;
  stopReason: string;
  errorPresent: boolean;
  timestamp: string;
  /** deadloop's estimate only; never mistaken for a provider invoice. */
  estimatedCostUsd: KnownUsage;
};

import type { AgentKind } from "./agent-profiles.cjs";

export type UsageTotals = {
  responses: number;
  inputTokens: KnownUsage;
  cacheReadTokens: KnownUsage;
  cacheWriteTokens: KnownUsage;
  outputTokens: KnownUsage;
  reasoningTokens: KnownUsage;
  totalTokens: KnownUsage;
  estimatedCostUsd: KnownUsage;
  hasUnknown: boolean;
};

export type RoleGroup = { role: UsageRole; totals: UsageTotals };
export type ModelGroup = { provider: string; model: string; totals: UsageTotals };

/** One durable or temporary session source an adapter scans. */
export type SessionSource = {
  file: string;
  agentKind: AgentKind;
};

/** A session-tree root spec for a pi/omp-shaped CLI. */
export type SessionRootSpec = { kind: "pi" | "omp"; root: string };

export type CollectOptions = {
  runDir: string;
  attemptId: string;
  parentAttemptId?: string;
  agentName: string;
  agentKind: AgentKind;
  role: UsageRole;
  worktreePath: string;
  extraSessionFiles?: string[];
  sessionsRoots?: { pi?: SessionRootSpec; omp?: SessionRootSpec };
  claudeProjectsRoot?: string;
};

export type CollectionOutcome = {
  records: NormalizedUsageRecord[];
  duplicatesSkipped: number;
};

export type CollectionError = {
  collectedAt: string;
  error: string;
};

export type CollectorInput = {
  runDir: string;
  roots?: SessionRoots;
  extraSessionFiles?: string[];
  now?: () => Date;
};

export type SessionRoots = {
  pi?: string;
  omp?: string;
  claude?: string;
};

export type AttemptUsageSummary = {
  attemptId: string;
  role: string;
  repository: string;
  targetKind: string;
  targetNumber: number;
  phase: string;
  active: boolean;
  records: number;
  models: string[];
  totals: UsageTotals;
};
