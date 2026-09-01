import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { deliverPendingDriverHandoff, type AutomationState } from "../src/automation-runner";
import { executeSchedulerTick, type SchedulerTickDeps } from "../src/scheduler-tick";
import { automationStateKey, normalizeProject } from "../src/core";
const { proveRetainedHandoffSettlement } = require("../src/retained-handoff-settlement.cts");
const { closeSettledAttemptWorkspace } = require("../src/settled-workspace-closure.cts");

const NOW = Date.parse("2026-08-26T00:05:00Z");
const HEAD = "a".repeat(40);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type SettlementWorld = {
  root: string;
  runDir: string;
  attemptRecordFile: string;
  worktreePath: string;
  handoffInput: Record<string, unknown>;
};

/** Writes one reviewer attempt journal plus the monitor handoff input that points at it. */
function settlementFixture(recordOverrides: Record<string, unknown> = {}): SettlementWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-retained-settlement-"));
  roots.push(root);
  const runDir = path.join(root, "runs", "attempt-1");
  const worktreePath = path.join(root, "worktrees", "pr-42");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  const attemptRecordFile = path.join(runDir, "attempt.json");
  const promiseFile = path.join(runDir, "promise.json");
  fs.writeFileSync(attemptRecordFile, JSON.stringify({
    attemptId: "attempt-1",
    launchUuid: "launch-1",
    project: "demo",
    repository: "octo/demo",
    role: "reviewer",
    target: { kind: "pull-request", number: 42 },
    inputRevision: { head: HEAD },
    branch: "pr-42",
    worktreePath,
    agentName: "reviewer",
    workspaceLabel: "reviewer 42",
    promptFile: path.join(runDir, "prompt.md"),
    promiseFile,
    phase: "agent_started",
    lastSuccessfulPhase: "agent_started",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    rootPaneId: "pane-1",
    ...recordOverrides,
  }));
  return {
    root,
    runDir,
    attemptRecordFile,
    worktreePath,
    handoffInput: {
      attemptRecordFile,
      promiseFile,
      prNumber: 42,
      expectedHeadOid: HEAD,
      branch: "pr-42",
      automationDir: "/automation",
      actorName: "reviewer",
      projectId: "demo",
      repoPath: root,
      githubRepo: "octo/demo",
      stateDir: root,
      enabledAt: 1,
    },
  };
}

function retainedEntry(world: SettlementWorld): Record<string, unknown> {
  return {
    pendingDriverHandoff: {
      action: "monitor",
      monitorHandoff: { kind: "reviewer", input: world.handoffInput },
    },
  };
}

type DeliveryOptions = {
  targetState?: () => string | never;
  commandRunner?: { runText: (args: string[]) => string; runJson: (args: string[]) => unknown };
};

/** A fake Herdr-backed command runner for the real settled-workspace closure (#395). */
function herdrFixtureRunner(world: SettlementWorld): {
  commandRunner: NonNullable<DeliveryOptions["commandRunner"]>;
  state: { workspaceOpen: boolean };
} {
  const state = { workspaceOpen: true };
  const commandRunner = {
    runText(args: string[]) {
      if (args[0] === "git" && args.includes("--git-common-dir")) return `${world.root}/.git\n`;
      if (args[0] === "git" && args.includes("--show-toplevel")) return `${world.worktreePath}\n`;
      if (args[0] === "git" && args.includes("--porcelain")) {
        return `worktree ${world.root}\n\nworktree ${world.worktreePath}\nbranch refs/heads/pr-42\n`;
      }
      if (args[0] === "herdr" && args[1] === "workspace" && args[2] === "close") {
        state.workspaceOpen = false;
        return "";
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    },
    runJson(args: string[]) {
      if (args[0] === "herdr" && args[1] === "workspace") {
        return { result: { workspaces: state.workspaceOpen
          ? [{ workspace_id: "workspace-1", pane_count: 1, tab_count: 1, worktree: { checkout_path: world.worktreePath } }]
          : [] } };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    },
  };
  return { commandRunner, state };
}

/** The same input-to-closure binding the extension host wires for settled handoffs. */
function settleRetainedWorkspaceBinding(commandRunner: NonNullable<DeliveryOptions["commandRunner"]>) {
  return (handoff: Record<string, unknown>) => {
    const input = handoff.input as Record<string, string>;
    return closeSettledAttemptWorkspace({
      attemptRecord: input.attemptRecordFile,
      projectId: input.projectId,
      projectRepo: input.repoPath,
      githubRepo: input.githubRepo,
      stateDir: input.stateDir,
      enabledAt: String(input.enabledAt),
    }, commandRunner);
  };
}

/**
 * Delivers the retained entry once with the real settlement proof wired like the host does. Live
 * observation is stubbed to a working directive, so only the new proof can move the retention.
 */
function deliverOnce(entry: Record<string, unknown>, options: DeliveryOptions = {}): {
  delivered: boolean;
} {
  let saved = false;
  const delivered = deliverPendingDriverHandoff(entry, { automations: {} }, "PR reviewer", {
    enabledAt: () => 1,
    isEnabled: () => true,
    proveRetainedHandoffSettled: (handoff) =>
      proveRetainedHandoffSettlement(handoff as Record<string, unknown>, {
        targetState: (repository, kind, number) => {
          if (repository !== "octo/demo" || kind !== "pull-request" || number !== 42) throw new Error(`unexpected target ${repository} ${kind} ${number}`);
          if (options.targetState === undefined) return "OPEN";
          return (options.targetState as () => string)();
        },
      }),
    ...(options.commandRunner
      ? { settleRetainedWorkspace: settleRetainedWorkspaceBinding(options.commandRunner) }
      : {}),
    observeAttemptMonitoring: (_handoff: Record<string, unknown>, accounting: never) =>
      ({ action: "working", accounting } as never),
    now: () => NOW,
    saveState: () => { saved = true; },
  });
  expect(saved).toBe(delivered);
  return { delivered };
}

describe("retained driver-handoff settlement proofs", () => {
  it("closes the attempt workspace when the monitored pull request settles the retention", () => {
    const world = settlementFixture();
    const herdr = herdrFixtureRunner(world);
    const entry = retainedEntry(world);

    deliverOnce(entry, { targetState: () => "CLOSED", commandRunner: herdr.commandRunner });

    expect(herdr.state.workspaceOpen).toBe(false);
  });

  it("closes the attempt workspace when the journal already released the attempt", () => {
    const world = settlementFixture({
      phase: "authority_released",
      lastSuccessfulPhase: "agent_started",
      authorityRelease: { reason: "terminal_missing_report", releasedAt: new Date(NOW).toISOString() },
    });
    const herdr = herdrFixtureRunner(world);
    const entry = retainedEntry(world);

    deliverOnce(entry, { targetState: () => "OPEN", commandRunner: herdr.commandRunner });

    expect(herdr.state.workspaceOpen).toBe(false);
  });

  it("clears a reviewer retention once the attempt journal proves its authority release", () => {
    const world = settlementFixture({
      phase: "authority_released",
      lastSuccessfulPhase: "agent_started",
      authorityRelease: { reason: "terminal_missing_report", releasedAt: new Date(NOW).toISOString() },
    });
    const entry = retainedEntry(world);

    const first = deliverOnce(entry, { targetState: () => "OPEN" });

    expect({ first, result: entry.lastResult, summary: entry.lastSummary }).toEqual({
      first: { delivered: true },
      result: "driver_monitor_settled",
      summary: "the attempt journal already released the attempt",
    });
  });

  it("keeps the retention cleared on the next tick so selection can advance", () => {
    const world = settlementFixture({
      phase: "authority_released",
      lastSuccessfulPhase: "agent_started",
      authorityRelease: { reason: "terminal_missing_report", releasedAt: new Date(NOW).toISOString() },
    });
    const entry = retainedEntry(world);
    deliverOnce(entry, { targetState: () => "OPEN" });

    const second = deliverOnce(entry, { targetState: () => "OPEN" });

    expect(second).toEqual({ delivered: false });
  });

  it("clears the retention when the monitored pull request closed even while the journal stays mid-flight", () => {
    const world = settlementFixture();
    const entry = retainedEntry(world);

    const first = deliverOnce(entry, { targetState: () => "CLOSED" });

    expect({ first, result: entry.lastResult, summary: entry.lastSummary }).toEqual({
      first: { delivered: true },
      result: "driver_monitor_settled",
      summary: "the monitored pull request already closed",
    });
  });

  it("clears the retention when GitHub reports the merged state", () => {
    const world = settlementFixture();
    const entry = retainedEntry(world);

    deliverOnce(entry, { targetState: () => "MERGED" });

    expect(entry.pendingDriverHandoff).toBeUndefined();
  });

  it("keeps a live retention when neither proof applies", () => {
    const world = settlementFixture();
    const entry = retainedEntry(world);

    deliverOnce(entry, { targetState: () => "OPEN" });

    expect({ retained: entry.pendingDriverHandoff !== undefined, result: entry.lastResult }).toEqual({
      retained: true,
      result: "driver_attempt_working",
    });
  });

  it("leaves the retention untouched when the settlement reader fails transiently", () => {
    const world = settlementFixture();
    const entry = retainedEntry(world);

    const first = deliverOnce(entry, { targetState: () => { throw new Error("gh failed"); } });

    expect({ first, retained: entry.pendingDriverHandoff !== undefined, lastError: entry.lastError }).toEqual({
      first: { delivered: true },
      retained: true,
      lastError: undefined,
    });
  });

  it("lets the next tick advance to a fresh pull request selection after the clearance", async () => {
    const world = settlementFixture({
      phase: "authority_released",
      lastSuccessfulPhase: "agent_started",
      authorityRelease: { reason: "terminal_missing_report", releasedAt: new Date(NOW).toISOString() },
    });
    const entry = retainedEntry(world);
    const reviewerAutomation = { id: "reviewer-auto", name: "PR reviewer", schedule: "*/10 * * * *", initialLastScheduledAt: NOW, driverFile: "driver.cts" };
    const state = { automations: { [automationStateKey({ id: "demo" }, reviewerAutomation)]: entry } };
    const project = normalizeProject({
      id: "demo",
      workerModel: "test-model",
      reviewerModel: "test-review-model",
      automations: [
        reviewerAutomation,
        {
          id: "ticker",
          name: "ticker",
          schedule: "*/10 * * * *",
          initialLastScheduledAt: 0,
          driverFile: "ticker-driver.cts",
        },
      ],
    });
    const savedStates: AutomationState[] = [];
    const runnerDeps = () => ({
      enabledAt: () => 1,
      isEnabled: () => true,
      now: () => NOW,
      proveRetainedHandoffSettled: (handoff: Record<string, unknown>) =>
        proveRetainedHandoffSettlement(handoff, { targetState: () => "OPEN" }),
      observeAttemptMonitoring: (_handoff: Record<string, unknown>, accounting: never) =>
        ({ action: "working", accounting } as never),
      prepareExecutionSupply: () => ({
        codeIdentity: "a".repeat(40),
        lockHash: "b".repeat(64),
        packageRoot: "/snapshot",
        automationDir: "/snapshot/automations",
        dependencyRoot: "/dependencies",
      }),
      readPrompt: () => "prompt",
      resolveAutomationFileInDir: (_kind: unknown, _automation: unknown, requested?: string) =>
        ({ requested: requested || "", resolved: requested || "", found: (requested || "").length > 0 }),
      runPrecheck: async () => ({ code: 0, stdout: "", stderr: "" }),
      runDriver: async () => ({ code: 0, stdout: JSON.stringify({ action: "done", summary: "driver ran" }), stderr: "" }),
      saveState: (saved: AutomationState) => savedStates.push(JSON.parse(JSON.stringify(saved))),
      sendUserMessage: (prompt: string) => prompt,
    });
    const tickDeps = (): SchedulerTickDeps => ({
      guard: () => true,
      codeIdentityAllowsTick: () => true,
      reconcileWorkAuthority: async () => "",
      reconcileRetainedAttempts: async () => true,
      loadState: () => state as unknown as AutomationState,
      updateStatus: () => {},
      now: () => NOW,
      buildRunnerDeps: runnerDeps as never,
    });

    const settledTick = await executeSchedulerTick(project, tickDeps());
    const selectionTick = await executeSchedulerTick(project, tickDeps());

    expect({ settled: settledTick.status === "retained", clearedBy: entry.lastResult }).toEqual({
      settled: true,
      clearedBy: "driver_monitor_settled",
    });
    expect(selectionTick).toEqual({ status: "selected", automationName: "ticker", result: "driver_done", summary: "driver ran" });
  });
});
