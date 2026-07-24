import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const decisionScript = "extensions/deadloop/automations/worker-watch-decision.ts";

function runDecisionArgs(args: string[]) {
  return spawnSync("node", [decisionScript, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function runDecision(input: Record<string, unknown>): { reason: string } {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "deadloop-worker-watch-"));
  try {
    const inputPath = path.join(tempRoot, "input.json");
    writeFileSync(inputPath, JSON.stringify(input));
    const result = runDecisionArgs(["--input", inputPath]);
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("worker watch decision", () => {
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
