// Normalized model usage — the one interface every agent kind's session records are
// normalized into (see CONTEXT.md "モデル使用記録" and ADR 0028). Adapters for pi,
// claude, and omp parse their durable external session JSONL trees; a collector persists
// the normalized records in the attempt's state directory before workspace closure.
//
// Rules encoded here:
// - One record per model response, deduplicated by stable response/session identity.
// - Missing fields are "unknown"; usage that cannot be proven to belong to an attempt is
//   attributed as "unattributed". Missing data is never reported as zero.
// - Prompt and response bodies are never copied into a record.
// - Estimated cost is an estimate, never provider billing.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

import type { AgentKind } from "./agent-profiles.cjs";
import type {
  CollectOptions,
  CollectionOutcome,
  KnownUsage,
  NormalizedUsageRecord,
  SessionSource,
  UsageRole,
  UsageTotals,
} from "./model-usage-types";

const USAGE_UNKNOWN = "unknown" as const;
const UNATTRIBUTED_ROLE = "unattributed" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A missing or non-numeric measurement stays "unknown"; it never becomes 0. */
function knownNumber(value: unknown): KnownUsage {
  return typeof value === "number" && Number.isFinite(value) ? value : USAGE_UNKNOWN;
}

function textOrUnknown(value: unknown): string {
  if (typeof value !== "string") return USAGE_UNKNOWN;
  return value.trim() || USAGE_UNKNOWN;
}

/**
 * Proves `child` sits inside `parent` without following links outside it, so a worktree
 * path cannot be substituted by a symlinked lookalike. A missing checkout still compares
 * by resolved path: attribution must not depend on the workspace still existing.
 */
function canonical(value: string): string {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function isInsidePath(parent: string, child: string): boolean {
  const relative = path.relative(canonical(parent), canonical(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

// --- adapters ---------------------------------------------------------------


type ParsedResponse = {
  sessionId: string;
  responseId: string;
  cwd?: string;
  provider: string;
  model: string;
  input: unknown;
  cacheRead: unknown;
  cacheWrite: unknown;
  output: unknown;
  reasoning: unknown;
  total: unknown;
  costTotal: unknown;
  durationMilliseconds: unknown;
  stopReason: string;
  timestamp: unknown;
};

/**
 * Reads one pi/omp-shaped JSONL session file. The two kinds share the same session-tree
 * format (a `{type:"session"}` header with cwd, then per-message lines), so they share this
 * parser; only the sessions root differs.
 */
function parsePiShapedResponses(file: string): ParsedResponse[] {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const responses: ParsedResponse[] = [];
  let sessionId = "";
  let cwd: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!isRecord(entry)) continue;
    if (entry.type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      if (typeof entry.cwd === "string") cwd = entry.cwd;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== "assistant") continue;
    const usage = isRecord(message.usage) ? message.usage : {};
    const cost = isRecord(usage.cost) ? usage.cost : {};
    responses.push({
      sessionId,
      responseId: textOrUnknown(entry.id),
      ...(cwd === undefined ? {} : { cwd }),
      provider: textOrUnknown(message.provider),
      model: textOrUnknown(message.model),
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      output: usage.output,
      // pi names it `reasoning`, omp `reasoningTokens`; both mean the same category.
      reasoning: "reasoningTokens" in usage ? usage.reasoningTokens : usage.reasoning,
      total: usage.totalTokens,
      costTotal: cost.total,
      durationMilliseconds: message.duration,
      stopReason: textOrUnknown(message.stopReason),
      timestamp: entry.timestamp ?? message.timestamp,
    });
  }
  return responses;
}

/** Reads one Claude Code session JSONL file (`~/.claude/projects/<slug>/<sessionId>.jsonl`). */
function parseClaudeResponses(file: string): ParsedResponse[] {
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const responses: ParsedResponse[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!isRecord(entry) || entry.type !== "assistant") continue;
    const message = isRecord(entry.message) ? entry.message : {};
    const usage = isRecord(message.usage) ? message.usage : {};
    const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
    responses.push({
      sessionId: textOrUnknown(entry.sessionId),
      responseId: textOrUnknown(entry.uuid),
      provider: "anthropic",
      model: textOrUnknown(message.model),
      input: usage.input_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      output: usage.output_tokens,
      reasoning: details.thinking_tokens,
      total: undefined,
      costTotal: undefined,
      durationMilliseconds: undefined,
      stopReason: textOrUnknown(message.stop_reason),
      timestamp: entry.timestamp,
    });
  }
  return responses;
}

type UsageAttribution = {
  attemptId: string;
  parentAttemptId?: string;
  agentName: string;
  role: UsageRole;
};

function normalizeResponse(
  source: SessionSource,
  response: ParsedResponse,
  attribution: UsageAttribution,
): NormalizedUsageRecord {
  const inputKnown = knownNumber(response.input);
  const outputKnown = knownNumber(response.output);
  const totalKnown = inputKnown !== USAGE_UNKNOWN && outputKnown !== USAGE_UNKNOWN
    ? Math.max(0, inputKnown) + Math.max(0, outputKnown)
    : USAGE_UNKNOWN;
  return {
    schemaVersion: 1,
    recordId: `${response.sessionId}:${response.responseId}`,
    ...attribution,
    action: "turn",
    agentKind: source.agentKind,
    provider: response.provider,
    model: response.model,
    inputTokens: inputKnown,
    cacheReadTokens: knownNumber(response.cacheRead),
    cacheWriteTokens: knownNumber(response.cacheWrite),
    outputTokens: outputKnown,
    reasoningTokens: knownNumber(response.reasoning),
    totalTokens: totalKnown,
    durationMilliseconds: knownNumber(response.durationMilliseconds),
    stopReason: response.stopReason,
    errorPresent: false,
    timestamp: textOrUnknown(response.timestamp),
    estimatedCostUsd: knownNumber(response.costTotal),
  };
}


function usageLedgerFile(runDir: string): string {
  return path.join(runDir, "model-usage.jsonl");
}


/** Reads back the persisted ledger so a repeated collection cannot double-count. */
function readPersistedRecordIds(runDir: string): Set<string> {
  const ids = new Set<string>();
  const ledger = usageLedgerFile(runDir);
  let text: string;
  try { text = fs.readFileSync(ledger, "utf8"); } catch { return ids; }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as NormalizedUsageRecord;
      if (record?.recordId) ids.add(record.recordId);
    } catch {}
  }
  return ids;
}

/**
 * Collects and normalizes every traceable model response belonging to one attempt:
 * the durable external session tree plus any temporary worktree artifacts. Attribution is
 * proven by the session's recorded cwd sitting inside the attempt's canonical checkout;
 * anything else stays `unattributed` instead of silently inflating another attempt.
 */
function collectModelUsage(options: CollectOptions): CollectionOutcome {
  const sources: SessionSource[] = [];
  const scanSessionRoots = () => {
    for (const spec of [options.sessionsRoots?.pi, options.sessionsRoots?.omp]) {
      if (!spec) continue;
      let dirs: string[] = [];
      try { dirs = fs.readdirSync(spec.root); } catch { continue; }
      for (const dir of dirs) {
        const dirPath = path.join(spec.root, dir);
        try {
          if (!fs.statSync(dirPath).isDirectory()) continue;
          for (const file of fs.readdirSync(dirPath)) {
            if (file.endsWith(".jsonl")) sources.push({ file: path.join(dirPath, file), agentKind: spec.kind });
          }
        } catch {}
      }
    }
  };
  const scanClaudeRoot = () => {
    if (!options.claudeProjectsRoot) return;
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(options.claudeProjectsRoot); } catch { return; }
    for (const dir of dirs) {
      const dirPath = path.join(options.claudeProjectsRoot, dir);
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
        for (const file of fs.readdirSync(dirPath)) {
          if (file.endsWith(".jsonl")) sources.push({ file: path.join(dirPath, file), agentKind: "claude" });
        }
      } catch {}
    }
  };

  scanSessionRoots();
  scanClaudeRoot();
  for (const file of options.extraSessionFiles || []) {
    sources.push({ file, agentKind: options.agentKind });
  }

  const seen = readPersistedRecordIds(options.runDir);
  const records: NormalizedUsageRecord[] = [];
  let duplicatesSkipped = 0;
  const attributionBase = {
    attemptId: options.attemptId,
    ...(options.parentAttemptId === undefined ? {} : { parentAttemptId: options.parentAttemptId }),
    agentName: options.agentName,
  };

  for (const source of sources) {
    const parsed = source.agentKind === "claude"
      ? parseClaudeResponses(source.file)
      : parsePiShapedResponses(source.file);
    for (const response of parsed) {
      // Attribution proof: the session ran inside this attempt's canonical checkout. Claude
      // headers carry no cwd, so its project directory name must equal the exact slugified
      // checkout; a prefix match would be guesswork and stays unattributed instead.
      const attributed = source.agentKind === "claude"
        ? path.basename(path.dirname(source.file)) === options.worktreePath.replace(/\//g, "-")
        : Boolean(response.cwd) && isInsidePath(options.worktreePath, String(response.cwd));
      const role: UsageRole = attributed ? options.role : UNATTRIBUTED_ROLE;
      const record = normalizeResponse(source, response, { ...attributionBase, role });
      if (seen.has(record.recordId)) { duplicatesSkipped += 1; continue; }
      seen.add(record.recordId);
      records.push(record);
    }
  }
  records.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return { records, duplicatesSkipped };
}

function sumCategory(values: KnownUsage[]): KnownUsage {
  let sum = 0;
  for (const value of values) {
    if (value === USAGE_UNKNOWN) return USAGE_UNKNOWN;
    sum += value;
  }
  return values.length ? sum : USAGE_UNKNOWN;
}

function totalsOf(records: NormalizedUsageRecord[]): UsageTotals {
  return {
    responses: records.length,
    inputTokens: sumCategory(records.map((record) => record.inputTokens)),
    cacheReadTokens: sumCategory(records.map((record) => record.cacheReadTokens)),
    cacheWriteTokens: sumCategory(records.map((record) => record.cacheWriteTokens)),
    outputTokens: sumCategory(records.map((record) => record.outputTokens)),
    reasoningTokens: sumCategory(records.map((record) => record.reasoningTokens)),
    totalTokens: sumCategory(records.map((record) => record.totalTokens)),
    estimatedCostUsd: sumCategory(records.map((record) => record.estimatedCostUsd)),
    hasUnknown: records.some((record) =>
      record.model === USAGE_UNKNOWN || record.inputTokens === USAGE_UNKNOWN
      || record.outputTokens === USAGE_UNKNOWN || record.estimatedCostUsd === USAGE_UNKNOWN
      || record.totalTokens === USAGE_UNKNOWN),
  };
}

function groupByRole(records: NormalizedUsageRecord[]): { role: UsageRole; totals: UsageTotals }[] {
  const groups = new Map<UsageRole, NormalizedUsageRecord[]>();
  for (const record of records) {
    const list = groups.get(record.role) || [];
    list.push(record);
    groups.set(record.role, list);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, groupRecords]) => ({ role, totals: totalsOf(groupRecords) }));
}

function groupByProviderModel(records: NormalizedUsageRecord[]): { provider: string; model: string; totals: UsageTotals }[] {
  const groups = new Map<string, NormalizedUsageRecord[]>();
  for (const record of records) {
    const key = `${record.provider}:${record.model}`;
    const list = groups.get(key) || [];
    list.push(record);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, groupRecords]) => {
      const [provider] = key.split(":");
      return { provider, model: key.slice(provider.length + 1), totals: totalsOf(groupRecords) };
    });
}

function withinDays(records: NormalizedUsageRecord[], days: number, nowMs: number): NormalizedUsageRecord[] {
  const cutoff = nowMs - days * 86_400_000;
  return records.filter((record) => {
    const at = Date.parse(record.timestamp);
    return Number.isFinite(at) && at >= cutoff;
  });
}

module.exports = {
  USAGE_UNKNOWN,
  UNATTRIBUTED_ROLE,
  usageLedgerFile,
  readPersistedRecordIds,
  collectModelUsage,
  totalsOf,
  groupByRole,
  groupByProviderModel,
  withinDays,
};
