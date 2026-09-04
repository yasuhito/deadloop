import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const {
  collectModelUsage,
  groupByProviderModel,
  groupByRole,
  readPersistedRecordIds,
  totalsOf,
  usageLedgerFile,
  withinDays,
  USAGE_UNKNOWN,
} = require("../src/model-usage.cts");
const { collectAttemptModelUsage } = require("../src/model-usage-collector.cts");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const root = mkdtempSync(path.join(tmpdir(), "deadloop-model-usage-"));
  tempDirs.push(root);
  return root;
}

/** A pi-shaped session file: one session header plus two assistant responses. */
function writePiSession(dir: string, cwd: string, sessionId = "pi-session", fileName = `${sessionId}.jsonl`): void {
  writeFileSync(path.join(dir, fileName), [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd }),
    "",
    JSON.stringify({
      type: "message", id: "resp-1", parentId: null, timestamp: "2026-01-01T00:00:10.000Z",
      message: {
        role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", duration: 12_000,
        usage: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 50, reasoning: 40, totalTokens: 1590, cost: { total: 0.02 } },
        stopReason: "toolUse", timestamp: "2026-01-01T00:00:10.000Z",
      },
    }),
    "",
    JSON.stringify({
      type: "message", id: "resp-2", parentId: "resp-1", timestamp: "2026-01-01T00:00:20.000Z",
      message: {
        role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", duration: 8000,
        usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 20, totalTokens: 620, cost: { total: 0.01 } },
        stopReason: "stop", timestamp: "2026-01-01T00:00:20.000Z",
      },
    }),
  ].join("\n"), "utf8");
}

/** A claude-shaped session file: one assistant response. */
function writeClaudeSession(dir: string, sessionId = "claude-session"): void {
  writeFileSync(path.join(dir, `${sessionId}.jsonl`), [
    JSON.stringify({
      type: "assistant", uuid: "msg_1", sessionId, timestamp: "2026-01-01T00:00:00.000Z",
      message: {
        model: "claude-sonnet-5",
        usage: { input_tokens: 2, cache_creation_input_tokens: 28754, cache_read_input_tokens: 24318, output_tokens: 1241, output_tokens_details: { thinking_tokens: 529 } },
        stop_reason: "tool_use",
      },
    }),
  ].join("\n"), "utf8");
}

const worktree = "/wt/repo-checkout";
const attributionBase = { attemptId: "attempt-1", agentName: "demo-worker" };

function piCollectionOptions(root: string, sessionsRoot: string) {
  return {
    runDir: root, ...attributionBase, agentKind: "pi" as const, role: "worker" as const, worktreePath: worktree,
    sessionsRoots: { pi: { kind: "pi" as const, root: sessionsRoot } },
  };
}

describe("normalized model usage records", () => {
  it("records every token category from a pi-shaped session response", () => {
    const root = sandbox();
    const sessions = path.join(root, "sessions", "-wt-repo-checkout");
    mkdirSync(sessions, { recursive: true });
    writePiSession(sessions, worktree);

    const { records } = collectModelUsage({
      runDir: root, attemptId: "attempt-1", agentName: "w", agentKind: "pi", role: "worker", worktreePath: worktree,
      sessionsRoots: { pi: { kind: "pi", root: path.dirname(sessions) } },
    });
    const first = records.find((record: any) => record.recordId === "pi-session:resp-1");

    expect(first && {
      input: first.inputTokens, cacheRead: first.cacheReadTokens, cacheWrite: first.cacheWriteTokens,
      output: first.outputTokens, reasoning: first.reasoningTokens, total: first.totalTokens,
    }).toEqual({ input: 1000, cacheRead: 300, cacheWrite: 50, output: 200, reasoning: 40, total: 1200 });
  });

  it("marks a claude response without cost metadata as unknown instead of zero", () => {
    const root = sandbox();
    const projects = path.join(root, "projects", worktree.replaceAll("/", "-"));
    mkdirSync(projects, { recursive: true });
    writeFileSync(path.join(projects, "claude-session.jsonl"), [
      JSON.stringify({
        type: "assistant", uuid: "msg_1", sessionId: "claude-session", timestamp: "2026-01-01T00:00:00.000Z",
        message: {
          model: "claude-sonnet-5",
          usage: { input_tokens: 2, cache_creation_input_tokens: 28754, cache_read_input_tokens: 24318, output_tokens: 1241, output_tokens_details: { thinking_tokens: 529 } },
          stop_reason: "tool_use",
        },
      }),
    ].join("\n"), "utf8");

    const { records } = collectModelUsage({
      runDir: root, ...attributionBase, agentKind: "claude", role: "reviewer", worktreePath: worktree,
      claudeProjectsRoot: path.dirname(projects),
    });
    const record = records[0];

    expect(record && { input: record.inputTokens, cacheRead: record.cacheReadTokens, output: record.outputTokens, cost: record.estimatedCostUsd })
      .toEqual({ input: 2, cacheRead: 24318, output: 1241, cost: USAGE_UNKNOWN });
  });

  it("skips a pi session-tree file whose header cwd is outside the attempt checkout", () => {
    const root = sandbox();
    const sessions = path.join(root, "sessions", "-elsewhere");
    mkdirSync(sessions, { recursive: true });
    writePiSession(sessions, "/other/place", "elsewhere-session");

    const { records, unrelatedSkipped } = collectModelUsage({
      runDir: root, ...attributionBase, agentKind: "pi", role: "worker", worktreePath: worktree,
      sessionsRoots: { pi: { kind: "pi", root: path.dirname(sessions) } },
    });

    expect(records.length === 0 && unrelatedSkipped === 1).toBe(true);
  });

  it("keeps recording a pi attempt session when unrelated sessions share the tree", () => {
    const root = sandbox();
    const related = path.join(root, "sessions", "-wt-repo-checkout");
    mkdirSync(related, { recursive: true });
    writePiSession(related, worktree);
    const elsewhere = path.join(root, "sessions", "-elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writePiSession(elsewhere, "/other/place", "elsewhere-session");

    const { records } = collectModelUsage(piCollectionOptions(root, path.dirname(related)));

    expect(records.every((record: any) => record.recordId.startsWith("pi-session:"))).toBe(true);
  });

  it("keeps recording an omp attempt session when unrelated sessions share the tree", () => {
    const root = sandbox();
    const related = path.join(root, "sessions", "-wt-repo-checkout");
    mkdirSync(related, { recursive: true });
    writePiSession(related, worktree);
    const elsewhere = path.join(root, "sessions", "-elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writePiSession(elsewhere, "/other/place", "elsewhere-session");

    const { records } = collectModelUsage({
      ...piCollectionOptions(root, path.dirname(related)), agentKind: "omp" as const,
      sessionsRoots: { omp: { kind: "omp" as const, root: path.dirname(related) } },
    });

    expect(records.every((record: any) => record.recordId.startsWith("pi-session:"))).toBe(true);
  });

  it("keeps recording a claude attempt session when unrelated projects share the tree", () => {
    const root = sandbox();
    const related = path.join(root, "projects", worktree.replaceAll("/", "-"));
    mkdirSync(related, { recursive: true });
    writeClaudeSession(related);
    const elsewhere = path.join(root, "projects", "-elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writeClaudeSession(elsewhere, "elsewhere-session");

    const { records } = collectModelUsage({
      runDir: root, ...attributionBase, agentKind: "claude", role: "reviewer", worktreePath: worktree,
      claudeProjectsRoot: path.dirname(related),
    });

    expect(records.every((record: any) => record.recordId.startsWith("claude-session:"))).toBe(true);
  });

  it("does not grow the saved count when unrelated session fixtures multiply", () => {
    const root = sandbox();
    const related = path.join(root, "sessions", "-wt-repo-checkout");
    mkdirSync(related, { recursive: true });
    writePiSession(related, worktree);
    const elsewhere = path.join(root, "sessions", "-elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    writePiSession(elsewhere, "/other/place", "elsewhere-session");
    const options = piCollectionOptions(root, path.dirname(related));
    const baseline = collectModelUsage(options);
    for (let index = 0; index < 10; index += 1) {
      const dir = path.join(root, "sessions", `-elsewhere-${index}`);
      mkdirSync(dir, { recursive: true });
      writePiSession(dir, `/other/place-${index}`, `elsewhere-session-${index}`);
    }

    const grown = collectModelUsage(options);

    expect(grown.records.length === baseline.records.length).toBe(true);
  });

  it("keeps a declared artifact response with a foreign cwd visible as unattributed", () => {
    const root = sandbox();
    const sessions = path.join(root, "sessions", "-wt-repo-checkout");
    mkdirSync(sessions, { recursive: true });
    writePiSession(sessions, worktree);
    const artifact = path.join(root, "artifact-session.jsonl");
    writePiSession(root, "/other/place", "artifact-session", "artifact-session.jsonl");

    const { records } = collectModelUsage({
      ...piCollectionOptions(root, path.dirname(sessions)),
      extraSessionFiles: [artifact],
    });
    const artifactRecord = records.find((record: any) => record.recordId === "artifact-session:resp-1");

    expect(artifactRecord?.role).toBe("unattributed");
  });

  it("counts duplicate session records once when parent and artifact copies coexist", () => {
    const root = sandbox();
    const sessions = path.join(root, "sessions", "-wt-repo-checkout");
    mkdirSync(sessions, { recursive: true });
    writePiSession(sessions, worktree);
    const artifactCopy = path.join(root, "artifact-copy.jsonl");
    copyFileSync(path.join(sessions, "pi-session.jsonl"), artifactCopy);

    const { records, duplicatesSkipped } = collectModelUsage({
      runDir: root, ...attributionBase, agentKind: "pi", role: "worker", worktreePath: worktree,
      sessionsRoots: { pi: { kind: "pi" as const, root: path.dirname(sessions) } },
      extraSessionFiles: [artifactCopy],
    });

    expect(records.length === 2 && duplicatesSkipped === 2).toBe(true);
  });

  it("sums totals per category with unknown propagating through the sum", () => {
    const totals = totalsOf([
      { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.5, model: "m" },
      { inputTokens: USAGE_UNKNOWN, outputTokens: 7, estimatedCostUsd: USAGE_UNKNOWN, model: "m" },
    ] as any);

    expect(totals.inputTokens === USAGE_UNKNOWN && totals.outputTokens === 12).toBe(true);
  });
});

describe("collector persistence", () => {
  function preparedAttempt(root: string): string {
    const runDir = path.join(root, "runs", "attempt-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "attempt.json"), `${JSON.stringify({
      attemptId: "attempt-1", launchUuid: "uuid-1", project: "demo", repository: "owner/repo", role: "worker",
      target: { kind: "issue", number: 1 }, inputRevision: { head: "a".repeat(40) }, branch: "agent/issue-1",
      worktreePath: worktree, agentName: "demo-worker", agent: "pi", workspaceLabel: "demo-worker",
      promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"),
      phase: "agent_started", lastSuccessfulPhase: "agent_started",
    })}\n`, "utf8");
    return runDir;
  }

  it("writes normalized records into the state-directory ledger before workspace closure", () => {
    const root = sandbox();
    const sessions = path.join(root, "sessions", "-wt-repo-checkout");
    mkdirSync(sessions, { recursive: true });
    writePiSession(sessions, worktree);
    const runDir = preparedAttempt(root);

    const { written } = collectAttemptModelUsage({ runDir, roots: { pi: path.dirname(sessions), omp: undefined, claude: undefined }, extraSessionFiles: [] });

    const ledger = readFileSync(usageLedgerFile(runDir), "utf8").trim().split("\n");
    expect(written.length === ledger.length && ledger.length === 2).toBe(true);
  });

  it("appends nothing on a second collection of the same session tree", () => {
    const root = sandbox();
    const sessions = path.join(root, "sessions", "-wt-repo-checkout");
    mkdirSync(sessions, { recursive: true });
    writePiSession(sessions, worktree);
    const runDir = preparedAttempt(root);
    collectAttemptModelUsage({ runDir, roots: { pi: path.dirname(sessions) } });

    const second = collectAttemptModelUsage({ runDir, roots: { pi: path.dirname(sessions) } });

    expect(readPersistedRecordIds(runDir).size === 2 && second.written.length === 0).toBe(true);
  });

  it("stores no prompt or response body text in the persisted ledger", () => {
    const root = sandbox();
    const sessions = path.join(root, "sessions", "-wt-repo-checkout");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path.join(sessions, "body-session.jsonl"), [
      JSON.stringify({ type: "session", version: 3, id: "body-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: worktree }),
      JSON.stringify({ type: "message", id: "user-1", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "user", content: "SECRET-PROMPT-BODY implement the issue" } }),
      JSON.stringify({ type: "message", id: "resp-1", timestamp: "2026-01-01T00:00:10.000Z", message: { role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", content: "SECRET-RESPONSE-BODY done", usage: { input: 10, output: 2, totalTokens: 12 }, stopReason: "stop", timestamp: "2026-01-01T00:00:10.000Z" } }),
    ].join("\n"), "utf8");
    const runDir = preparedAttempt(root);
    collectAttemptModelUsage({ runDir, roots: { pi: path.dirname(sessions) } });

    const ledger = readFileSync(usageLedgerFile(runDir), "utf8");

    expect(ledger.includes("SECRET-PROMPT-BODY") || ledger.includes("SECRET-RESPONSE-BODY")).toBe(false);
  });
});

describe("usage reporting helpers", () => {
  it("filters records to the requested window by timestamp", () => {
    const now = Date.parse("2026-08-21T00:00:00.000Z");
    const records = [
      { timestamp: "2026-08-20T00:00:00.000Z" },
      { timestamp: "2026-08-01T00:00:00.000Z" },
      { timestamp: "not-a-date" },
    ] as any[];

    expect(withinDays(records, 7, now)).toHaveLength(1);
  });

  it("groups records by provider and model without merging distinct models", () => {
    const groups = groupByProviderModel([
      { provider: "openai-codex", model: "gpt-5.6-sol" },
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "openai-codex", model: "gpt-5.6-sol" },
    ] as any[]);

    expect(groups.map((group: any) => `${group.provider}/${group.model}:${group.totals.responses}`))
      .toEqual(["anthropic/claude-sonnet-5:1", "openai-codex/gpt-5.6-sol:2"]);
  });

  it("keeps an unattributed role visible as its own group", () => {
    const groups = groupByRole([
      { role: "worker" }, { role: "unattributed" },
    ] as any[]);

    expect(groups.map((group: any) => group.role)).toEqual(["unattributed", "worker"]);
  });
});
