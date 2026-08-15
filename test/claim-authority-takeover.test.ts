import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { takeWorkAuthorityFromRetainedAttempts } = require("../extensions/deadloop/automations/pr-reviewer-driver.ts");
const { readAttemptRecord } = require("../src/attempt-lifecycle-runtime.cjs");

const attemptHead = "a".repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function stateDirWith(attempts: Array<Record<string, unknown>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-takeover-"));
  roots.push(root);
  attempts.forEach((attempt, index) => {
    const runDir = path.join(root, "runs", `run-${index}`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
      schemaVersion: 1,
      attemptId: `attempt-${index}`,
      launchUuid: `uuid-${index}`,
      project: "demo",
      repository: "owner/repo",
      role: "reviewer",
      target: { kind: "pull-request", number: 31 },
      inputRevision: { head: attemptHead },
      branch: "agent/issue-31",
      worktreePath: `/wt-${index}`,
      agentName: `dl-r-31-${index}`,
      workspaceId: `workspace-${index}`,
      workspaceLabel: `demo-pr-31-reviewer-${index}`,
      rootPaneId: `pane-${index}`,
      promptFile: path.join(runDir, "reviewer-prompt.md"),
      promiseFile: path.join(runDir, "promise.json"),
      phase: "report_received",
      lastSuccessfulPhase: "report_received",
      ...attempt,
    }));
  });
  return root;
}

function workspaceOf(index: number) {
  return { workspaceId: `workspace-${index}`, worktreePath: `/wt-${index}`, tabCount: 1, paneCount: 1 };
}

/**
 * The runtime an Automation host sees for attempts whose agent is gone. The workspaces stay listed
 * on purpose: a workspace nobody works in is not a running attempt.
 */
function stoppedRuntime(attempts = 1) {
  const indexes = Array.from({ length: attempts }, (_value, index) => index);
  return {
    listWorkspaces: () => indexes.map(workspaceOf),
    listAgents: () => [],
    listWorktrees: () => indexes.map((index) => ({ path: `/wt-${index}` })),
  };
}

/** The runtime an Automation host sees while the attempt's own agent is still working. */
function liveRuntime(index = 0) {
  return {
    ...stoppedRuntime(index + 1),
    listAgents: () => [{ name: `dl-r-31-${index}`, paneId: `pane-${index}`, cwd: `/wt-${index}`, status: "working" }],
  };
}

function takeover(stateDir: string, runner: Record<string, unknown> = stoppedRuntime()) {
  return takeWorkAuthorityFromRetainedAttempts({
    stateDir, projectId: "demo", githubRepo: "owner/repo", prNumber: 31,
  }, { runner });
}

describe("work authority takeover at claim time", () => {
  it("releases an attempt the runtime reports stopped", () => {
    const stateDir = stateDirWith([{}]);

    expect(takeover(stateDir)).toEqual(["attempt-0"]);
  });

  it("releases a stopped attempt whatever request event it consumed", () => {
    const stateDir = stateDirWith([{ requestEventId: "req-2" }]);

    expect(takeover(stateDir)).toEqual(["attempt-0"]);
  });

  it("records the released phase on the attempt it took authority from", () => {
    const stateDir = stateDirWith([{}]);
    takeover(stateDir);

    expect(readAttemptRecord(path.join(stateDir, "runs", "run-0")).phase).toBe("authority_released");
  });

  it("keeps the journal of an attempt it took authority from", () => {
    const stateDir = stateDirWith([{}]);
    takeover(stateDir);

    expect(fs.existsSync(path.join(stateDir, "runs", "run-0", "attempt.json"))).toBe(true);
  });

  it("keeps an attempt whose own agent is still working", () => {
    const stateDir = stateDirWith([{}]);

    expect(takeover(stateDir, liveRuntime())).toEqual([]);
  });

  it("releases an attempt whose agent is gone whatever its workspace holds", () => {
    const stateDir = stateDirWith([{}]);
    const crowded = { ...stoppedRuntime(), listWorkspaces: () => [{ ...workspaceOf(0), tabCount: 3, paneCount: 4 }] };

    expect(takeover(stateDir, crowded)).toEqual(["attempt-0"]);
  });

  it("releases a stopped attempt that never reported a completion", () => {
    const stateDir = stateDirWith([{ phase: "agent_started", lastSuccessfulPhase: "agent_started" }]);

    expect(takeover(stateDir)).toEqual(["attempt-0"]);
  });

  it("keeps an attempt whose checkout another agent occupies", () => {
    const stateDir = stateDirWith([{}]);
    const occupied = { ...stoppedRuntime(), listAgents: () => [{ name: "other", paneId: "pane-9", cwd: "/wt-0", status: "working" }] };

    expect(takeover(stateDir, occupied)).toEqual([]);
  });

  it("keeps an attempt whose runtime cannot be reached", () => {
    const stateDir = stateDirWith([{}]);
    const unreachable = { ...stoppedRuntime(), listAgents: () => { throw new Error("connection refused"); } };

    expect(takeover(stateDir, unreachable)).toEqual([]);
  });

  it("ignores an attempt that already released ownership", () => {
    const stateDir = stateDirWith([{ phase: "workspace_closed", lastSuccessfulPhase: "workspace_closed" }]);

    expect(takeover(stateDir)).toEqual([]);
  });

  it("ignores an attempt targeting another pull request", () => {
    const stateDir = stateDirWith([{ target: { kind: "pull-request", number: 99 } }]);

    expect(takeover(stateDir)).toEqual([]);
  });

  it("releases every retained attempt the runtime reports stopped", () => {
    const stateDir = stateDirWith([{}, {}, {}]);

    expect(takeover(stateDir, stoppedRuntime(3))).toEqual(["attempt-0", "attempt-1", "attempt-2"]);
  });
});
