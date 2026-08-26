// Read-only reporting over the persisted normalized usage ledgers. The default view covers
// the most recent seven days grouped by role and by provider/model; an attempt argument shows
// response-level detail for that single attempt. Everything here derives from the stored
// response records — there is no competing aggregate store.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");

const { releasesAttemptOwnership, parseAttemptRecord } = require("./attempt-lifecycle-runtime.cjs");
const {
  groupByProviderModel,
  groupByRole,
  totalsOf,
  usageLedgerFile,
  withinDays,
  USAGE_UNKNOWN,
} = require("./model-usage.cts");

import type { AttemptUsageSummary, KnownUsage, NormalizedUsageRecord, UsageTotals } from "./model-usage-types";



function readLedger(runDir: string): NormalizedUsageRecord[] {
  const ledger = usageLedgerFile(runDir);
  let text: string;
  try { text = fs.readFileSync(ledger, "utf8"); } catch { return []; }
  const records: NormalizedUsageRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as NormalizedUsageRecord); } catch {}
  }
  return records;
}

function readAllUsageRecords(stateDir: string): { runDir: string; record: NormalizedUsageRecord }[] {
  const entries: { runDir: string; record: NormalizedUsageRecord }[] = [];
  let runs: string[] = [];
  try { runs = fs.readdirSync(path.join(stateDir, "runs")); } catch { return entries; }
  for (const entry of runs) {
    const runDir = path.join(stateDir, "runs", entry);
    if (!fs.existsSync(usageLedgerFile(runDir))) continue;
    for (const record of readLedger(runDir)) entries.push({ runDir, record });
  }
  return entries;
}

/** One summary line per attempt journal that carries a usage ledger, active attempts first. */
function summarizeAttemptUsage(stateDir: string): AttemptUsageSummary[] {
  const summaries: AttemptUsageSummary[] = [];
  let runs: string[] = [];
  try { runs = fs.readdirSync(path.join(stateDir, "runs")); } catch { return summaries; }
  for (const entry of runs) {
    const runDir = path.join(stateDir, "runs", entry);
    const records = readLedger(runDir);
    if (!records.length) continue;
    try {
      const parsed = parseAttemptRecord(JSON.parse(fs.readFileSync(path.join(runDir, "attempt.json"), "utf8")));
      summaries.push({
        attemptId: parsed.attemptId,
        role: parsed.role,
        repository: parsed.repository,
        targetKind: parsed.target.kind,
        targetNumber: parsed.target.number,
        phase: parsed.phase,
        active: !releasesAttemptOwnership(parsed.phase),
        records: records.length,
        models: [...new Set(records.map((record) => record.model))].filter((model) => model !== USAGE_UNKNOWN),
        totals: totalsOf(records),
      });
    } catch {}
  }
  return summaries.sort((left, right) => Number(right.active) - Number(left.active) || left.attemptId.localeCompare(right.attemptId));
}

function formatTokens(value: KnownUsage): string {
  return value === USAGE_UNKNOWN ? "unknown" : String(value);
}

function formatTotals(totals: ReturnType<typeof totalsOf>): string {
  return [
    `responses=${totals.responses}`,
    `input=${formatTokens(totals.inputTokens)}`,
    `cache-read=${formatTokens(totals.cacheReadTokens)}`,
    `cache-write=${formatTokens(totals.cacheWriteTokens)}`,
    `output=${formatTokens(totals.outputTokens)}`,
    `reasoning=${formatTokens(totals.reasoningTokens)}`,
    `total=${formatTokens(totals.totalTokens)}`,
    `est-cost=${totals.estimatedCostUsd === USAGE_UNKNOWN ? "unknown" : Number(totals.estimatedCostUsd).toFixed(4)} USD`,
  ].join(", ");
}

function formatCurrentAttemptUsage(summaries: AttemptUsageSummary[]): string[] {
  const active = summaries.filter((summary) => summary.active);
  if (!active.length) return [];
  return ["", "Current attempt usage:"].concat(
    active.map((summary) => {
      const model = summary.models.length ? summary.models.join("|") : "unknown";
      return `- ${summary.attemptId} (${summary.role}, ${summary.targetKind} #${summary.targetNumber}):`
        + ` model=${model}; ${formatTotals(summary.totals)}`;
    }),
  );
}

/** The `/deadloop-usage` default view: the latest seven days grouped by role and provider/model. */
function formatUsageWindowReport(stateDir: string, nowMs: number): string {
  const all = readAllUsageRecords(stateDir).map((entry) => entry.record);
  const recent = withinDays(all, 7, nowMs);
  if (!recent.length) {
    return `No model usage recorded in the last 7 days (${all.length} record(s) on disk overall).`;
  }
  const lines = [
    `Model usage for the last 7 days (${recent.length} of ${all.length} response record(s)):`,
    "",
    "By role:",
  ];
  for (const group of groupByRole(recent)) lines.push(`- ${group.role}: ${formatTotals(group.totals)}`);
  lines.push("", "By provider/model:");
  for (const group of groupByProviderModel(recent)) lines.push(`- ${group.provider}/${group.model}: ${formatTotals(group.totals)}`);
  lines.push("", "Estimated cost is deadloop's estimate from session metadata, never a provider invoice.");
  return lines.join("\n");
}

/** The `/deadloop-usage <attempt-id>` detail view: every normalized response of one attempt. */
function formatAttemptUsageDetail(stateDir: string, attemptId: string): string {
  let runs: string[] = [];
  try { runs = fs.readdirSync(path.join(stateDir, "runs")); } catch {}
  for (const entry of runs) {
    const runDir = path.join(stateDir, "runs", entry);
    const records = readLedger(runDir);
    if (!records.some((record) => record.attemptId === attemptId)) continue;
    const mine = records.filter((record) => record.attemptId === attemptId);
    const unattributed = mine.filter((record) => record.role === "unattributed").length;
    return [
      `Usage detail for attempt ${attemptId}:`,
      `- total: ${formatTotals(totalsOf(mine))}`,
      ...(unattributed ? [`- note: ${unattributed} response(s) could not be proven to belong to this attempt and are counted as unattributed`] : []),
      ...mine.map((record) => {
        const unknown = (value: KnownUsage) => (value === USAGE_UNKNOWN ? "unknown" : String(value));
        return `- [${record.timestamp}] ${record.provider}/${record.model} role=${record.role}`
          + ` tokens(in=${unknown(record.inputTokens)}, cache-read=${unknown(record.cacheReadTokens)},`
          + ` out=${unknown(record.outputTokens)}, reasoning=${unknown(record.reasoningTokens)}, total=${unknown(record.totalTokens)})`
          + ` stop=${record.stopReason} est-cost=${record.estimatedCostUsd === USAGE_UNKNOWN ? "unknown" : Number(record.estimatedCostUsd).toFixed(4)} USD`;
      }),
    ].join("\n");
  }
  throw new Error(`no model usage records found for attempt ${attemptId}`);
}

module.exports = {
  formatCurrentAttemptUsage,
  summarizeAttemptUsage,
  readAllUsageRecords,
  formatUsageWindowReport,
  formatAttemptUsageDetail,
};
