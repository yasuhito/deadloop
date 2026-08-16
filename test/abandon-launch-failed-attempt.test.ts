import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createPreparedAttempt, transitionPersistedAttempt } from "../src/attempt-lifecycle";

const { abandonLocked } = require("../extensions/deadloop/automations/abandon-launch-failed-attempt.ts");

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function failedAttempt(role: "worker" | "reviewer" = "reviewer") {
  const runDir = mkdtempSync(path.join(os.tmpdir(), "deadloop-abandon-"));
  roots.push(runDir);
  createPreparedAttempt(runDir, {
    attemptId: "attempt-211",
    launchUuid: "launch-211",
    project: "demo",
    repository: "owner/repo",
    role,
    target: { kind: role === "worker" ? "issue" : "pull-request", number: 211 },
    inputRevision: { head: "a".repeat(40) },
    branch: "agent/issue-211",
    baseBranch: "main",
    worktreePath: "/worktrees/issue-211",
    agentName: "dl-r-211-123456789abc",
    workspaceLabel: "review 211",
    promptFile: path.join(runDir, "prompt.md"),
    promiseFile: path.join(runDir, "promise.json"),
  });
  transitionPersistedAttempt(runDir, "github_claimed");
  const opened = transitionPersistedAttempt(runDir, "workspace_opened");
  // Persist the identities which the real launch flow records with workspace_opened.
  const recordFile = path.join(runDir, "attempt.json");
  const record = {
    ...opened,
    workspaceId: "workspace-211",
    tabId: "tab-211",
    rootPaneId: "pane-211",
  };
  writeFileSync(recordFile, `${JSON.stringify(record)}\n`);
  transitionPersistedAttempt(runDir, "launch_failed", "agent start rejected");
  return { runDir, recordFile };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const events: string[] = [];
  let targetState: "claimed" | "requeued" = "claimed";
  let closeStarted = false;
  return {
    events,
    deps: {
      listWorkspaces: () => [{ workspaceId: "workspace-211", worktreePath: "/worktrees/issue-211", tabCount: 1, paneCount: 1 }],
      listAgents: () => [],
      inspectWorktree: () => ({ head: "a".repeat(40), status: "", retained: true }),
      otherAttemptOwnsCheckout: () => false,
      workspaceCloseWasStarted: () => closeStarted,
      recordWorkspaceCloseStarted: () => { events.push("authorize-close"); closeStarted = true; },
      observeTarget: () => ({ state: targetState }),
      closeWorkspace: () => { events.push("close"); },
      workspaceStillExists: () => false,
      abandonAttempt: (runDir: string) => {
        events.push("abandon");
        return require("../src/attempt-lifecycle-runtime.cjs").abandonPersistedAttempt(runDir, "2026-07-24T00:00:00.000Z");
      },
      requeueTarget: () => { events.push("requeue"); targetState = "requeued"; },
      ...overrides,
    },
  };
}

describe("launch-failed attempt abandonment", () => {
  it.each(["worker", "reviewer"] as const)("closes, records abandonment, and requeues a %s attempt in that order", (role) => {
    const attempt = failedAttempt(role);
    const fixture = dependencies();

    const result = abandonLocked({ attemptRecord: attempt.recordFile }, fixture.deps, () => fixture.events.push("recheck"));

    expect({ action: result.action, events: fixture.events }).toEqual({
      action: "done",
      events: ["recheck", "authorize-close", "close", "abandon", "recheck", "requeue"],
    });
  });

  it("refuses an unexplained disappearance of the recorded workspace", () => {
    const attempt = failedAttempt("reviewer");
    const fixture = dependencies({ listWorkspaces: () => [] });

    const result = abandonLocked({ attemptRecord: attempt.recordFile }, fixture.deps, () => fixture.events.push("recheck"));

    expect({ action: result.action, events: fixture.events }).toEqual({ action: "error", events: [] });
  });

  it("recovers idempotently when a prior invocation already closed the owned workspace", () => {
    const attempt = failedAttempt("reviewer");
    const fixture = dependencies({ listWorkspaces: () => [], workspaceCloseWasStarted: () => true });

    const result = abandonLocked({ attemptRecord: attempt.recordFile }, fixture.deps, () => fixture.events.push("recheck"));

    expect({ action: result.action, events: fixture.events }).toEqual({
      action: "done",
      events: ["abandon", "recheck", "requeue"],
    });
  });

  it("abandons a retained checkout whose only untracked files are an agent scratch area", () => {
    const attempt = failedAttempt("reviewer");
    const fixture = dependencies({
      listWorkspaces: () => [],
      workspaceCloseWasStarted: () => true,
      inspectWorktree: () => ({ head: "a".repeat(40), status: "?? .pi/subagents/artifacts/input.md\n", retained: true }),
    });

    const result = abandonLocked({ attemptRecord: attempt.recordFile }, fixture.deps, () => fixture.events.push("recheck"));

    expect(result.action).toBe("done");
  });

  it("refuses a retained checkout whose scratch area holds a tracked change", () => {
    const attempt = failedAttempt("reviewer");
    const fixture = dependencies({
      listWorkspaces: () => [],
      workspaceCloseWasStarted: () => true,
      inspectWorktree: () => ({ head: "a".repeat(40), status: " M .pi/subagents/report.md\n", retained: true }),
    });

    const result = abandonLocked({ attemptRecord: attempt.recordFile }, fixture.deps, () => fixture.events.push("recheck"));

    expect(result.action).toBe("error");
  });

  it("re-proves the retained checkout before requeueing an already-abandoned attempt", () => {
    const attempt = failedAttempt("worker");
    require("../src/attempt-lifecycle-runtime.cjs").abandonPersistedAttempt(attempt.runDir, "2026-07-24T00:00:00.000Z");
    const fixture = dependencies({
      listWorkspaces: () => [],
      workspaceCloseWasStarted: () => true,
      inspectWorktree: () => ({ head: "a".repeat(40), status: " M changed.ts", retained: true }),
    });

    const result = abandonLocked({ attemptRecord: attempt.recordFile }, fixture.deps, () => fixture.events.push("recheck"));

    expect({ action: result.action, events: fixture.events }).toEqual({ action: "error", events: [] });
  });

  it("refuses to close while an agent owns the recorded pane", () => {
    const attempt = failedAttempt("reviewer");
    const fixture = dependencies({ listAgents: () => [{ name: "other", paneId: "pane-211", status: "working" }] });

    const result = abandonLocked({ attemptRecord: attempt.recordFile }, fixture.deps, () => fixture.events.push("recheck"));

    expect({ action: result.action, events: fixture.events }).toEqual({ action: "error", events: [] });
  });

  it("refuses to close when an agent reports the workspace with a mismatched pane", () => {
    const attempt = failedAttempt("reviewer");
    const fixture = dependencies({ listAgents: () => [{ name: "other", paneId: "stale-pane", workspace_id: "workspace-211", status: "working" }] });

    const result = abandonLocked({ attemptRecord: attempt.recordFile }, fixture.deps, () => fixture.events.push("recheck"));

    expect({ action: result.action, events: fixture.events }).toEqual({ action: "error", events: [] });
  });

  it("refuses to close a workspace whose disposable shape is not proven", () => {
    const attempt = failedAttempt("reviewer");
    const fixture = dependencies({ listWorkspaces: () => [{ workspaceId: "workspace-211", worktreePath: "/worktrees/issue-211", tabCount: 2, paneCount: 2 }] });

    const result = abandonLocked({ attemptRecord: attempt.recordFile }, fixture.deps, () => fixture.events.push("recheck"));

    expect({ action: result.action, events: fixture.events }).toEqual({ action: "error", events: [] });
  });

  it.each([
    ["becomes dirty", { head: "a".repeat(40), status: " M changed.ts", retained: true }],
    ["moves to another revision", { head: "b".repeat(40), status: "", retained: true }],
    ["is no longer retained", { head: "a".repeat(40), status: "", retained: false }],
  ])("refuses to abandon when the retained checkout %s while its workspace closes", (_case, changedWorktree) => {
    const attempt = failedAttempt("reviewer");
    let inspections = 0;
    const fixture = dependencies({
      inspectWorktree: () => {
        inspections += 1;
        return inspections === 1
          ? { head: "a".repeat(40), status: "", retained: true }
          : changedWorktree;
      },
    });

    const result = abandonLocked({ attemptRecord: attempt.recordFile }, fixture.deps, () => fixture.events.push("recheck"));

    expect({ action: result.action, events: fixture.events }).toEqual({
      action: "error",
      events: ["recheck", "authorize-close", "close"],
    });
  });

  it("refuses to requeue when the target changed after launch", () => {
    const attempt = failedAttempt("worker");
    const fixture = dependencies({ observeTarget: () => ({ state: "unsafe" as const, reason: "issue labels changed" }) });

    const result = abandonLocked({ attemptRecord: attempt.recordFile }, fixture.deps, () => fixture.events.push("recheck"));

    expect({ action: result.action, events: fixture.events }).toEqual({ action: "error", events: [] });
  });
});
