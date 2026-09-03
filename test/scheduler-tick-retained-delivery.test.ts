import { describe, expect, it } from "vitest";

import type { AutomationState } from "../src/automation-runner";
import { executeSchedulerTick, type SchedulerTickDeps } from "../src/scheduler-tick";
import { normalizeProject, type NormalizedProject } from "../src/core";

const ENABLED_AT = 777;
const START = 30 * 60_000;

function twoAutomationProject(): NormalizedProject {
  return normalizeProject({
    id: "demo",
    workerModel: "test-model",
    reviewerModel: "test-review-model",
    automations: [
      { id: "issue-coordinator", name: "issue coordinator", schedule: "*/10 * * * *", initialLastScheduledAt: START, driverFile: "coordinator-driver.cts" },
      { id: "pr-reviewer", name: "pr reviewer", schedule: "*/10 * * * *", initialLastScheduledAt: 0, driverFile: "reviewer-driver.cts" },
    ],
  });
}

function dueCoordinatorProject(): NormalizedProject {
  return normalizeProject({
    id: "demo",
    workerModel: "test-model",
    reviewerModel: "test-review-model",
    automations: [
      { id: "issue-coordinator", name: "issue coordinator", schedule: "*/10 * * * *", initialLastScheduledAt: 20 * 60_000, driverFile: "coordinator-driver.cts" },
      { id: "pr-reviewer", name: "pr reviewer", schedule: "*/10 * * * *", initialLastScheduledAt: START, driverFile: "reviewer-driver.cts" },
    ],
  });
}

function retainedEntry(marker: string): Record<string, unknown> {
  return {
    pendingDriverHandoff: {
      action: "monitor",
      monitorHandoff: { kind: "issue", input: { enabledAt: ENABLED_AT, marker } },
      monitorAccounting: { activeMilliseconds: 0, observedAt: new Date(START).toISOString(), runtimeWasWorking: false },
    },
  };
}

type Harness = {
  deps: SchedulerTickDeps;
  driversRun: string[];
  observedMarkers: string[];
};

type MonitorAction = "working" | "settled";

function tickHarness(
  state: AutomationState,
  overrides: Partial<SchedulerTickDeps> = {},
  observeAction: () => MonitorAction = () => "working",
): Harness {
  const driversRun: string[] = [];
  const observedMarkers: string[] = [];
  let clock = START;
  const runnerDeps = {
    enabledAt: () => ENABLED_AT,
    isEnabled: () => true,
    now: () => clock,
    prepareExecutionSupply: () => ({
      codeIdentity: "a".repeat(40),
      lockHash: "b".repeat(64),
      packageRoot: "/snapshot",
      automationDir: "/snapshot/automations",
      dependencyRoot: "/dependencies",
    }),
    resolveAutomationFileInDir: (_kind: unknown, _automation: unknown, requested?: string) =>
      ({ requested: requested || "", resolved: requested || "", found: (requested || "").length > 0 }),
    observeAttemptMonitoring: (handoff: Record<string, unknown>) => {
      const input = handoff.input as Record<string, unknown> | undefined;
      observedMarkers.push(String(input?.marker ?? ""));
      return {
        action: observeAction(),
        accounting: { activeMilliseconds: 0, observedAt: new Date(clock).toISOString(), runtimeWasWorking: false },
      } as const;
    },
    runDriver: async (_project: unknown, automation: { id: string }) => {
      driversRun.push(automation.id);
      return { code: 0, stdout: JSON.stringify({ action: "done", summary: "driver ran" }), stderr: "" };
    },
    saveState: () => {},
  };
  const deps: SchedulerTickDeps = {
    guard: () => true,
    codeIdentityAllowsTick: () => true,
    reconcileWorkAuthority: async () => "",
    reconcileRetainedAttempts: async () => true,
    loadState: () => state,
    updateStatus: () => {},
    now: () => (clock += 60_000),
    buildRunnerDeps: () => runnerDeps as never,
    ...overrides,
  };
  return { deps, driversRun, observedMarkers };
}

describe("retained delivery within a scheduler tick", () => {
  it("still selects a due automation in the same tick that observed a working retained attempt", async () => {
    const project = twoAutomationProject();
    const state: AutomationState = {
      automations: { "demo:issue-coordinator": retainedEntry("coordinator") },
    };
    const { deps, driversRun } = tickHarness(state);

    const outcome = await executeSchedulerTick(project, deps);

    expect({ outcome, driversRun }).toEqual({
      outcome: {
        status: "retained_and_selected",
        retained: { result: "driver_attempt_working", summary: "deterministic attempt monitoring: active work 0ms" },
        automationName: "pr reviewer",
        result: "driver_done",
        summary: "driver ran",
      },
      driversRun: ["pr-reviewer"],
    });
  });

  it("delivers retained handoffs round-robin from the least-recently-advanced automation", async () => {
    const project = normalizeProject({
      id: "demo",
      workerModel: "test-model",
      reviewerModel: "test-review-model",
      automations: [
        { id: "issue-coordinator", name: "issue coordinator", schedule: "*/10 * * * *", initialLastScheduledAt: START, driverFile: "coordinator-driver.cts" },
        { id: "pr-reviewer", name: "pr reviewer", schedule: "*/10 * * * *", initialLastScheduledAt: START, driverFile: "reviewer-driver.cts" },
      ],
    });
    const state: AutomationState = {
      automations: {
        "demo:issue-coordinator": retainedEntry("coordinator"),
        "demo:pr-reviewer": retainedEntry("reviewer"),
      },
    };
    const { deps, observedMarkers } = tickHarness(state);

    await executeSchedulerTick(project, deps);
    await executeSchedulerTick(project, deps);
    await executeSchedulerTick(project, deps);

    expect(observedMarkers).toEqual(["coordinator", "reviewer", "coordinator"]);
  });

  it("does not launch the same automation again while a working retained attempt keeps its monitor handoff", async () => {
    const project = dueCoordinatorProject();
    const state: AutomationState = { automations: { "demo:issue-coordinator": retainedEntry("coordinator") } };
    const { deps, driversRun } = tickHarness(state);

    await executeSchedulerTick(project, deps);

    expect(driversRun).toEqual([]);
  });

  it("keeps the working retained handoff when the same automation is due and deferred", async () => {
    const project = dueCoordinatorProject();
    const state: AutomationState = { automations: { "demo:issue-coordinator": retainedEntry("coordinator") } };
    const { deps } = tickHarness(state);

    await executeSchedulerTick(project, deps);

    const payload = state.automations["demo:issue-coordinator"].pendingDriverHandoff as { monitorHandoff: { input: { marker: string } } };
    expect(payload.monitorHandoff.input.marker).toBe("coordinator");
  });

  it("reports a due automation deferred for its retained handoff in the host activity log", async () => {
    const project = dueCoordinatorProject();
    const state: AutomationState = { automations: { "demo:issue-coordinator": retainedEntry("coordinator") } };
    const events: unknown[] = [];
    const { deps } = tickHarness(state, { emitHostLog: (event) => events.push(event) });

    await executeSchedulerTick(project, deps);

    expect(events.filter((event) => (event as { kind: string }).kind === "automation_deferred")).toEqual([{
      kind: "automation_deferred",
      projectId: "demo",
      automationId: "issue-coordinator",
      dueAt: new Date(30 * 60_000).toISOString(),
      reason: "a retained monitor handoff is still active",
    }]);
  });

  it("selects the deferred automation after the retained handoff reaches a terminal state", async () => {
    const project = dueCoordinatorProject();
    const state: AutomationState = { automations: { "demo:issue-coordinator": retainedEntry("coordinator") } };
    const actions: MonitorAction[] = ["working", "working", "settled"];
    const { deps, driversRun } = tickHarness(state, {}, () => actions.shift() ?? "settled");

    await executeSchedulerTick(project, deps);
    await executeSchedulerTick(project, deps);
    await executeSchedulerTick(project, deps);
    await executeSchedulerTick(project, deps);

    expect(driversRun).toEqual(["issue-coordinator"]);
  });

  it("records an automation that was due but not selected as starved in the host activity log", async () => {
    const project = normalizeProject({
      id: "demo",
      workerModel: "test-model",
      reviewerModel: "test-review-model",
      automations: [
        { id: "issue-coordinator", name: "issue coordinator", schedule: "*/10 * * * *", initialLastScheduledAt: 0, driverFile: "coordinator-driver.cts" },
        { id: "pr-reviewer", name: "pr reviewer", schedule: "*/10 * * * *", initialLastScheduledAt: 0, driverFile: "reviewer-driver.cts" },
      ],
    });
    const state: AutomationState = { automations: {} };
    const events: unknown[] = [];
    const { deps } = tickHarness(state, { emitHostLog: (event) => events.push(event) });

    await executeSchedulerTick(project, deps);

    expect(events.filter((event) => (event as { kind: string }).kind === "automation_starved")).toEqual([{
      kind: "automation_starved",
      projectId: "demo",
      automationId: "pr-reviewer",
      dueAt: new Date(10 * 60_000).toISOString(),
      reason: "selection went to issue coordinator",
    }]);
  });
});
