import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const decisionScript = "extensions/pi-looper/automations/worker-watch-decision.ts";

type WatchDecision = {
  action: string;
  reason: string;
};

function runDecisionArgs(args: string[]) {
  return spawnSync("node", [decisionScript, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function runDecision(input: Record<string, unknown>): WatchDecision {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "pi-looper-worker-watch-"));
  try {
    const inputPath = path.join(tempRoot, "input.json");
    writeFileSync(inputPath, JSON.stringify(input));
    const result = runDecisionArgs(["--input", inputPath]);
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    return JSON.parse(result.stdout);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("worker watch decision", () => {
  it("keeps waiting for a worker with recent tool activity and no worktree diff", () => {
    expect(
      runDecision({
        now: "2026-07-07T11:17:37Z",
        promiseStatus: "none",
        worktreeHasChanges: false,
        nudgeSentAt: "2026-07-07T11:15:33Z",
        agentStatus: "idle",
        activity: [{ kind: "tool", at: "2026-07-07T11:16:20Z" }],
      }).action,
    ).toBe("continue_waiting");
  });

  it("keeps waiting during the post-nudge grace period", () => {
    expect(
      runDecision({
        now: "2026-07-07T11:17:00Z",
        promiseStatus: "none",
        worktreeHasChanges: false,
        nudgeSentAt: "2026-07-07T11:15:00Z",
        agentStatus: "idle",
      }).reason,
    ).toBe("nudge_grace_period");
  });

  it("asks for a promise before any pane close is considered", () => {
    expect(
      runDecision({
        now: "2026-07-07T11:17:00Z",
        promiseStatus: "none",
        worktreeHasChanges: false,
        agentStatus: "done",
      }).action,
    ).toBe("nudge_worker");
  });

  it("allows pane close only after inactivity and grace have both elapsed", () => {
    expect(
      runDecision({
        now: "2026-07-07T11:30:00Z",
        promiseStatus: "none",
        worktreeHasChanges: false,
        nudgeSentAt: "2026-07-07T11:15:00Z",
        agentStatus: "done",
        lastAgentSessionUpdatedAt: "2026-07-07T11:00:00Z",
        recentOutputAt: "2026-07-07T11:00:00Z",
      }).action,
    ).toBe("may_close_pane");
  });

  it("requires pane output inspection before pane close", () => {
    expect(
      runDecision({
        now: "2026-07-07T11:30:00Z",
        promiseStatus: "none",
        worktreeHasChanges: false,
        nudgeSentAt: "2026-07-07T11:15:00Z",
        agentStatus: "done",
        lastAgentSessionUpdatedAt: "2026-07-07T11:00:00Z",
      }).action,
    ).toBe("collect_observations");
  });

  it("returns settled when the promise is complete", () => {
    expect(
      runDecision({
        now: "2026-07-07T11:30:00Z",
        promiseStatus: "complete",
        worktreeHasChanges: false,
        agentStatus: "done",
      }).action,
    ).toBe("promise_settled");
  });

  it("treats timezone-less timestamps as UTC", () => {
    expect(
      runDecision({
        now: "2026-07-07T11:17:00Z",
        promiseStatus: "none",
        worktreeHasChanges: false,
        nudgeSentAt: "2026-07-07T11:00:00",
        agentStatus: "idle",
        lastAgentSessionUpdatedAt: "2026-07-07T11:16:00",
        recentOutputAt: "2026-07-07T11:00:00",
      }).reason,
    ).toBe("recent_activity");
  });

  it("rejects missing input flag values", () => {
    expect(runDecisionArgs(["--input"]).status).toBe(2);
  });

  it("rejects missing now flag values", () => {
    expect(runDecisionArgs(["--now"]).status).toBe(2);
  });
});
