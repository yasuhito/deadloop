import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AutomationState } from "../src/automation-runner";
import { normalizeProject, type AutomationFileResolution } from "../src/core";
const {
  ONE_SHOT_EXECUTION_TTL_MS,
  clearOneShotExecution,
  issueOneShotExecution,
  readValidOneShotExecution,
} = require("../src/one-shot-execution.cjs");
const { assertLocallyEnabled } = require("../src/enabled-operation.cjs");
const { advanceDisableGeneration } = require("../src/disable-generation.cjs");
import {
  executeSchedulerTick,
  formatOneShotTickReport,
  planOneShotTick,
  type SchedulerTickDeps,
  type SchedulerTickOutcome,
} from "../src/scheduler-tick";
import type { NormalizedProject } from "../src/core";

type Harness = {
  savedStates: AutomationState[];
};

const NOW = 30 * 60_000;
const ENABLED_AT = 777;

function dueProject(): NormalizedProject {
  return normalizeProject({
    id: "demo",
    automations: [{
      id: "demo:ticker",
      name: "demo ticker",
      schedule: "*/10 * * * *",
      initialLastScheduledAt: 0,
      precheckFile: "ticker-precheck.sh",
      driverFile: "ticker-driver.cts",
    }],
  });
}

function foundFile(requested: string | undefined): AutomationFileResolution {
  const name = requested || "";
  return { requested: name, resolved: name, found: name.length > 0 };
}

function freshHarness(): Harness {
  return { savedStates: [] };
}

function driverDoneRunnerDeps(harness: Harness) {
  return {
    enabledAt: () => ENABLED_AT,
    isEnabled: () => true,
    now: () => NOW,
    prepareExecutionSupply: () => ({
      codeIdentity: "a".repeat(40),
      lockHash: "b".repeat(64),
      packageRoot: "/snapshot",
      automationDir: "/snapshot/automations",
      dependencyRoot: "/dependencies",
    }),
    readPrompt: () => "prompt",
    resolveAutomationFileInDir: (_kind: unknown, _automation: unknown, requested?: string) => foundFile(requested),
    runPrecheck: async () => ({ code: 0, stdout: "", stderr: "" }),
    runDriver: async () => ({ code: 0, stdout: JSON.stringify({ action: "done", summary: "driver ran" }), stderr: "" }),
    saveState: (state: AutomationState) => harness.savedStates.push(JSON.parse(JSON.stringify(state))),
    sendUserMessage: (prompt: string) => prompt,
  };
}

function tickDeps(harness: Harness, overrides: Partial<SchedulerTickDeps> = {}): SchedulerTickDeps {
  return {
    guard: () => true,
    codeIdentityAllowsTick: () => true,
    reconcileWorkAuthority: async () => "",
    reconcileRetainedAttempts: async () => true,
    loadState: () => ({ automations: {} }),
    updateStatus: () => {},
    now: () => NOW,
    buildRunnerDeps: () => driverDoneRunnerDeps(harness),
    ...overrides,
  };
}

function selectedName(outcome: SchedulerTickOutcome): string | null {
  return outcome.status === "selected" ? outcome.automationName : null;
}

async function runCaller(kind: "normal" | "one-shot"): Promise<{ outcome: SchedulerTickOutcome; harness: Harness }> {
  const project = dueProject();
  const harness = freshHarness();
  const outcome = await executeSchedulerTick(project, tickDeps(harness, {
    buildRunnerDeps: () => ({
      ...driverDoneRunnerDeps(harness),
      isEnabled: kind === "one-shot" ? () => true : undefined,
    }),
  }));
  return { outcome, harness };
}

describe("shared scheduler tick", () => {
  it("selects the same due automation for the normal and one-shot caller", async () => {
    const normal = await runCaller("normal");
    const oneShot = await runCaller("one-shot");
    expect(selectedName(oneShot.outcome)).toEqual(selectedName(normal.outcome));
  });

  it("persists the same state for the normal and one-shot caller", async () => {
    const normal = await runCaller("normal");
    const oneShot = await runCaller("one-shot");
    expect(oneShot.harness.savedStates).toEqual(normal.harness.savedStates);
  });

  it("registers no successor timer after a one-shot completion", async () => {
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      await runCaller("one-shot");
      expect(intervalSpy).not.toHaveBeenCalled();
    } finally {
      intervalSpy.mockRestore();
    }
  });

  it("blocks before selection when execution authority was revoked mid-tick", async () => {
    const outcome = await executeSchedulerTick(dueProject(), tickDeps(freshHarness(), { guard: () => false }));
    expect(outcome.status).toBe("blocked");
  });
});

describe("one-shot start gate", () => {
  it("refuses to start while continuous enablement is on", () => {
    const plan = planOneShotTick({
      persistedEnabledProject: { repoPath: "/repo", githubRepo: "owner/repo" },
      lockAcquisition: { acquired: true },
    });
    expect(plan.ok).toBe(false);
  });

  it("refuses to start when the repository lock is held", () => {
    const plan = planOneShotTick({ persistedEnabledProject: null, lockAcquisition: { acquired: false, owner: 42 } });
    expect(plan.ok).toBe(false);
  });

  it("starts when enablement is off and the lock is free", () => {
    const plan = planOneShotTick({ persistedEnabledProject: null, lockAcquisition: { acquired: true } });
    expect(plan.ok).toBe(true);
  });
});

describe("scoped execution authority", () => {
  const originalConfigDir = process.env.PI_CODING_AGENT_DIR;
  const sandboxes: string[] = [];

  afterEach(() => {
    process.env.PI_CODING_AGENT_DIR = originalConfigDir;
    for (const root of sandboxes.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function authorityFixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-run-once-"));
    sandboxes.push(root);
    const configDir = path.join(root, "config");
    process.env.PI_CODING_AGENT_DIR = configDir;
    mkdirSync(configDir, { recursive: true });
    const stateDir = path.join(configDir, "deadloop");
    mkdirSync(stateDir, { recursive: true });
    return {
      stateDir,
      repoPath: path.join(root, "repo"),
      githubRepo: "owner/repo",
    };
  }

  function issue(fix: ReturnType<typeof authorityFixture>, overrides = {}) {
    return issueOneShotExecution({
      stateDir: fix.stateDir,
      repoPath: fix.repoPath,
      githubRepo: fix.githubRepo,
      githubRepositoryId: "R_1",
      automationLogin: "bot",
      enabledAt: ENABLED_AT,
      ...overrides,
    });
  }

  it("authorizes guarded operations without persisted enablement while it is valid", () => {
    const fix = authorityFixture();
    issue(fix);
    expect(() => assertLocallyEnabled({
      stateDir: fix.stateDir,
      repoPath: fix.repoPath,
      githubRepo: fix.githubRepo,
      enabledAt: ENABLED_AT,
    })).not.toThrow();
  });

  it("expires on its own deadline so a crash leaves no standing authority", () => {
    const fix = authorityFixture();
    vi.useFakeTimers();
    try {
      issue(fix);
      const issuedAtMs = readValidOneShotExecution({ stateDir: fix.stateDir, repoPath: fix.repoPath, githubRepo: fix.githubRepo, enabledAt: ENABLED_AT })?.issuedAtMs;
      if (typeof issuedAtMs !== "number") throw new Error("the scoped execution record was not issued");
      vi.setSystemTime(new Date(issuedAtMs + ONE_SHOT_EXECUTION_TTL_MS + 1));
      expect(() => assertLocallyEnabled({
        stateDir: fix.stateDir,
        repoPath: fix.repoPath,
        githubRepo: fix.githubRepo,
        enabledAt: ENABLED_AT,
      })).toThrow(/disabled/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops authorizing after /deadloop-disable advances the disable generation", () => {
    const fix = authorityFixture();
    issue(fix);
    advanceDisableGeneration(fix.stateDir, fix.repoPath, (file: string, value: unknown) => {
      writeFileSync(file, JSON.stringify(value));
    });
    expect(() => assertLocallyEnabled({
      stateDir: fix.stateDir,
      repoPath: fix.repoPath,
      githubRepo: fix.githubRepo,
      enabledAt: ENABLED_AT,
    })).toThrow(/disabled/);
  });

  it("keeps an existing enabled-record stop authoritative instead of falling back to one-shot", () => {
    const fix = authorityFixture();
    writeFileSync(path.join(fix.stateDir, "enabled-projects.json"), JSON.stringify({
      lastWriterCodeIdentity: "a".repeat(40),
      projects: [{
        repoPath: fix.repoPath,
        githubRepo: fix.githubRepo,
        githubRepositoryId: "R_1",
        enabled: true,
        firstEnableAutoMerge: false,
        firstStartPending: false,
        lastObservedAutoMerge: false,
        autoMergeAcknowledged: false,
        enabledAt: 5,
        disableGeneration: 0,
        automationLogin: "bot",
      }],
    }));
    issue(fix, { enabledAt: 123 });
    expect(() => assertLocallyEnabled({
      stateDir: fix.stateDir,
      repoPath: fix.repoPath,
      githubRepo: fix.githubRepo,
      enabledAt: 4,
    })).toThrow(/disabled/);
  });

  it("leaves persisted enablement untouched across its whole lifecycle", () => {
    const fix = authorityFixture();
    const enablementPath = path.join(fix.stateDir, "enabled-projects.json");
    issue(fix);
    readValidOneShotExecution({ stateDir: fix.stateDir, repoPath: fix.repoPath, githubRepo: fix.githubRepo, enabledAt: ENABLED_AT });
    clearOneShotExecution(fix.stateDir);
    expect(() => readFileSync(enablementPath)).toThrow();
  });
});

describe("model-availability wait in a one-shot tick", () => {
  function modelWaitHarness() {
    const harness = freshHarness();
    let retryCalls = 0;
    const deps = {
      ...driverDoneRunnerDeps(harness),
      observeAttemptMonitoring: () => ({
        action: "missing_report" as const,
        reason: "model_availability" as const,
        providerRetryAt: new Date(NOW + 60_000).toISOString(),
        accounting: { activeMilliseconds: 0, observedAt: new Date(NOW).toISOString(), runtimeWasWorking: true },
      }),
      applyAttemptMonitoring: () => ({ applied: true }),
      retryModelWait: () => {
        retryCalls += 1;
        return true;
      },
    };
    return { harness, deps, retryCalls: () => retryCalls };
  }

  function modelWaitDriverDeps(modelWait: ReturnType<typeof modelWaitHarness>) {
    return {
      ...modelWait.deps,
      runDriver: async () => ({
        code: 0,
        stdout: JSON.stringify({
          action: "monitor",
          summary: "",
          monitorHandoff: {
            kind: "issue",
            input: {
              readyLabel: "agent:ready",
              inProgressLabel: "agent:in-progress",
              blockedLabel: "agent:blocked",
              humanLabel: "agent:human",
              needsInfoLabel: "agent:needs-info",
              wontfixLabel: "agent:wontfix",
              issueNumber: 1,
              issueTitle: "t",
              issueBody: "b",
              enabledAt: ENABLED_AT,
            },
          },
        }),
        stderr: "",
      }),
    };
  }

  it("records that deadloop waits for model availability", async () => {
    const modelWait = modelWaitHarness();
    const outcome = await executeSchedulerTick(dueProject(), tickDeps(modelWait.harness, {
      buildRunnerDeps: () => modelWaitDriverDeps(modelWait),
    }));
    if (outcome.status !== "selected" && outcome.status !== "retained") throw new Error(`unexpected outcome ${outcome.status}`);
    expect(outcome.result).toBe("driver_monitor_waiting_for_model");
  });

  it("does not invoke the provider retry within the same tick", async () => {
    const modelWait = modelWaitHarness();
    await executeSchedulerTick(dueProject(), tickDeps(modelWait.harness, {
      buildRunnerDeps: () => modelWaitDriverDeps(modelWait),
    }));
    expect(modelWait.retryCalls()).toBe(0);
  });
});

describe("one-shot tick reports", () => {
  it("reports idle ticks as a distinguishable no-op", () => {
    const report = formatOneShotTickReport({ status: "idle" });
    expect(report).toMatch(/no automation was due/);
  });

  it("reports launched work", () => {
    const report = formatOneShotTickReport({ status: "selected", automationName: "demo ticker", result: "queued", summary: "" });
    expect(report).toMatch(/launched/);
  });

  it("reports a retained running attempt as needing another later tick", () => {
    const report = formatOneShotTickReport({ status: "retained", result: "driver_attempt_working", summary: "" });
    expect(report).toMatch(/another tick|again later/);
  });

  it("reports model waits as having scheduled no retry", () => {
    const report = formatOneShotTickReport({ status: "retained", result: "driver_monitor_waiting_for_model", summary: "" });
    expect(report).toMatch(/No retry was scheduled/);
  });

  it("reports a tick that ended in an automation error", () => {
    const report = formatOneShotTickReport({ status: "selected", automationName: "demo ticker", result: "driver_error", summary: "driver exited 1" });
    expect(report).toMatch(/ended in an error/);
  });

  it("reports blocked ticks with their reason", () => {
    const report = formatOneShotTickReport({ status: "blocked", reason: "the reconciliation reason" });
    expect(report).toContain("the reconciliation reason");
  });
});
