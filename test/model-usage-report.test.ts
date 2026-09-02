import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const {
  formatAttemptUsageDetail,
  formatCurrentAttemptUsage,
  formatUsageWindowReport,
  summarizeAttemptUsage,
} = require("../src/model-usage-report.cts");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function stateWithLedger(): string {
  const root = mkdtempSync(path.join(tmpdir(), "deadloop-usage-report-"));
  tempDirs.push(root);
  const runDir = path.join(root, "runs", "attempt-1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "attempt.json"), `${JSON.stringify({
    attemptId: "attempt-1", launchUuid: "uuid-1", project: "demo", repository: "owner/repo", role: "worker",
    target: { kind: "issue", number: 7 }, inputRevision: { head: "a".repeat(40) }, branch: "agent/issue-7",
    worktreePath: "/wt/repo-checkout", agentName: "demo-worker", agent: "pi", workspaceLabel: "demo-worker",
    promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"),
    phase: "agent_started", lastSuccessfulPhase: "agent_started",
  })}\n`, "utf8");
  writeFileSync(path.join(runDir, "model-usage.jsonl"), [
    JSON.stringify({
      schemaVersion: 1, recordId: "s:r1", attemptId: "attempt-1", agentName: "demo-worker", role: "worker",
      action: "turn", agentKind: "pi", provider: "openai-codex", model: "gpt-5.6-sol",
      inputTokens: 1000, cacheReadTokens: 3000, cacheWriteTokens: 100, outputTokens: 200,
      reasoningTokens: 40, totalTokens: 1200, durationMilliseconds: 12_000, stopReason: "stop",
      errorPresent: false, timestamp: new Date().toISOString(), estimatedCostUsd: 0.03,
    }),
  ].join("\n"), "utf8");
  return root;
}

describe("model usage reports", () => {
  it("summarizes an active attempt with its model and totals for the current-attempt view", () => {
    const summaries = summarizeAttemptUsage(stateWithLedger());

    expect(summaries.length === 1 && summaries[0].active && summaries[0].models[0] === "gpt-5.6-sol").toBe(true);
  });

  it("formats the current-attempt usage line with the model and token categories", () => {
    const [summary] = summarizeAttemptUsage(stateWithLedger());
    const lines = formatCurrentAttemptUsage([summary]);

    expect(lines.join("\n")).toContain("attempt-1 (worker, issue #7): model=gpt-5.6-sol");
  });

  it("shows the seven-day window grouped by role and by provider/model", () => {
    const report = formatUsageWindowReport(stateWithLedger(), Date.now());

    expect({
      groupsByRole: report.includes("- worker:"),
      groupsByProviderModel: report.includes("- openai-codex/gpt-5.6-sol:"),
      hasInvoiceDisclaimer: report.includes("never a provider invoice"),
    }).toEqual({ groupsByRole: true, groupsByProviderModel: true, hasInvoiceDisclaimer: true });
  });

  it("reports response-level detail for one attempt id", () => {
    const detail = formatAttemptUsageDetail(stateWithLedger(), "attempt-1");

    expect({ hasRole: detail.includes("role=worker"), hasCacheRead: detail.includes("cache-read=3000") }).toEqual({
      hasRole: true,
      hasCacheRead: true,
    });
  });

  it("fails clearly when an unknown attempt id has no records", () => {
    expect(() => formatAttemptUsageDetail(stateWithLedger(), "missing")).toThrow(/no model usage records/);
  });
});
