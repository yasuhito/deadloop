import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { deliverPendingDriverHandoff, runScheduledAutomation, type AutomationState } from "../src/automation-runner";
import { normalizeProject, type AutomationFileResolution } from "../src/core";

const { collectOrphanedLaunchHandoffs, consumeLaunchHandoffSidecar } = require("../src/launch-handoff-sidecar.cts");
const { transitionPersistedAttempt } = require("../src/attempt-lifecycle-runtime.cjs");

function monitoredAttemptRecordFilesOf(state: unknown): Set<string> {
  const files = new Set<string>();
  for (const entry of Object.values((state as { automations?: Record<string, Record<string, unknown>> }).automations || {})) {
    const handoff = entry && typeof entry === "object" ? (entry as Record<string, unknown>).pendingDriverHandoff : undefined;
    const monitorHandoff = handoff && typeof handoff === "object" ? (handoff as Record<string, unknown>).monitorHandoff : undefined;
    const input = monitorHandoff && typeof monitorHandoff === "object" ? (monitorHandoff as Record<string, unknown>).input : undefined;
    const file = input && typeof input === "object" ? (input as Record<string, unknown>).attemptRecordFile : undefined;
    if (typeof file === "string" && file) files.add(path.resolve(file));
  }
  return files;
}

function foundFile(requested: string | undefined): AutomationFileResolution {
  const name = requested || "";
  return { requested: name, resolved: name, found: name.length > 0 };
}

describe("real driver handoff across disable and re-enable", () => {
  it.each([
    ["does not deliver the handoff while disabled", (result: { sentWhileDisabled: string[] }) => result.sentWhileDisabled, []],
    ["keeps deterministic monitoring off the host model across generations", (result: { hostModelTurns: string[] }) => result.hostModelTurns, []],
    ["reports deterministic attempt monitoring as its latest result", (result: { lastResult: unknown }) => result.lastResult, "driver_attempt_working"],
    ["retains the monitored issue attempt across the disabled window", (result: { pending?: { monitorHandoff?: { kind?: unknown } } }) => result.pending?.monitorHandoff?.kind, "issue"],
  ])("%s", async (_name, observation, expected) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-driver-handoff-"));
    const statePath = path.join(root, "state.json");
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",
      id: "demo",
      repoPath: "/repo path",
      githubRepo: "owner/repo",
      automations: [{
        id: "demo:issue-coordinator",
        name: "issue coordinator",
        driverFile: "issue-coordinator-driver.cts",
      }],
    });
    const state: AutomationState = { automations: {} };
    const sent: string[] = [];
    let enabled = true;

    try {
      await runScheduledAutomation(project, project.automations[0], 123, state, {
        enabledAt: () => 1,
        isEnabled: () => enabled,
        now: () => 456,
        prepareExecutionSupply: () => ({ codeIdentity: "a".repeat(40), lockHash: "b".repeat(64), packageRoot: "/snapshot", automationDir: "/snapshot/automations", dependencyRoot: "/dependencies" }),
        resolveAutomationFileInDir: (_kind, _automation, requested) => foundFile(requested),
        observeAttemptMonitoring: () => ({ action: "working", accounting: { activeMilliseconds: 0, observedAt: new Date(456).toISOString(), runtimeWasWorking: true } }),
        runDriver: async () => {
          const result = spawnSync(
            "node",
            [
              "extensions/deadloop/automations/issue-coordinator-driver.cts",
              "--fixture",
              "test/fixtures/issue-coordinator/driver-ready-worker.json",
            ],
            {
              cwd: process.cwd(),
              encoding: "utf8",
              env: {
                ...process.env,
                DEADLOOP_PROJECT_ID: "demo",
                DEADLOOP_REPO_PATH: "/repo path",
                DEADLOOP_GITHUB_REPO: "owner/repo",
                DEADLOOP_STATE_DIR: root,
                DEADLOOP_ENABLED_AT: "1",
              },
            },
          );
          enabled = false;
          return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
        },
        saveState: (next) => writeFileSync(statePath, JSON.stringify(next)),
      });

      const reloaded = JSON.parse(readFileSync(statePath, "utf8")) as AutomationState;
      const entry = reloaded.automations["demo:demo:issue-coordinator"];
      const handoff = entry.pendingDriverHandoff as { monitorHandoff: { input: { promiseFile: string; enabledAt?: number } } };
      mkdirSync(path.dirname(handoff.monitorHandoff.input.promiseFile), { recursive: true });
      writeFileSync(handoff.monitorHandoff.input.promiseFile, JSON.stringify({ status: "complete", reason: "implemented" }));
      const sentWhileDisabled = [...sent];
      enabled = true;
      deliverPendingDriverHandoff(entry, reloaded, "issue coordinator", {
        enabledAt: () => 2,
        isEnabled: () => enabled,
        now: () => 789,
        revalidatePendingDriverHandoff: () => true,
        observeAttemptMonitoring: (_monitorHandoff: Record<string, any>) => {
          // The re-enabled generation is what monitoring binds to from here on.
          handoff.monitorHandoff.input.enabledAt = 2;
          return { action: "working", accounting: { activeMilliseconds: 0, observedAt: new Date(789).toISOString(), runtimeWasWorking: true } };
        },
        saveState: (next) => writeFileSync(statePath, JSON.stringify(next)),
      });

      expect(observation({
        sentWhileDisabled,
        hostModelTurns: sent,
        lastResult: entry.lastResult,
        pending: entry.pendingDriverHandoff,
      })).toEqual(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a driver result lost after a launched attempt", () => {
  it("re-adopts the durable launch handoff so the attempt is not orphaned", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-lost-launch-result-"));
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",
      id: "demo",
      repoPath: "/repo path",
      githubRepo: "owner/repo",
      automations: [{
        id: "demo:issue-coordinator",
        name: "issue coordinator",
        driverFile: "issue-coordinator-driver.cts",
      }],
    });
    const state: AutomationState = { automations: {} };

    try {
      await runScheduledAutomation(project, project.automations[0], 123, state, {
        enabledAt: () => 1,
        isEnabled: () => true,
        now: () => 456,
        prepareExecutionSupply: () => ({ codeIdentity: "a".repeat(40), lockHash: "b".repeat(64), packageRoot: "/snapshot", automationDir: "/snapshot/automations", dependencyRoot: "/dependencies" }),
        resolveAutomationFileInDir: (_kind, _automation, requested) => foundFile(requested),
        runDriver: async () => {
          // The observed incident: the coordinator really launched the Worker, then the host
          // received a result it could not read as a monitor handoff.
          const result = spawnSync(
            "node",
            ["extensions/deadloop/automations/issue-coordinator-driver.cts", "--fixture", "test/fixtures/issue-coordinator/driver-ready-worker.json"],
            {
              cwd: process.cwd(),
              encoding: "utf8",
              env: {
                ...process.env,
                DEADLOOP_PROJECT_ID: "demo",
                DEADLOOP_REPO_PATH: "/repo path",
                DEADLOOP_GITHUB_REPO: "owner/repo",
                DEADLOOP_STATE_DIR: root,
                DEADLOOP_ENABLED_AT: "1",
              },
            },
          );
          if (result.status !== 0) throw new Error(result.stderr || result.stdout || "fixture driver failed");
          // A real launch ends at agent_started; the simulated fixture launch stops at github_claimed,
          // so finish the journal the way a real launch would before the host sees a broken result.
          const runDir = path.join(root, "runs", "fixture-worker-demo-12");
          transitionPersistedAttempt(runDir, "workspace_opened");
          transitionPersistedAttempt(runDir, "agent_started");
          return { code: 0, stdout: JSON.stringify({ action: "monitor", summary: "Launched Worker for Issue #12" }) };
        },
        adoptOrphanedLaunchHandoffs: (current, automation) => automation.driverFile === "issue-coordinator-driver.cts"
          ? collectOrphanedLaunchHandoffs({
              runsRoot: path.join(root, "runs"),
              projectId: "demo",
              monitoredAttemptRecordFiles: monitoredAttemptRecordFilesOf(current),
              now: Date.parse("2026-08-29T00:00:00Z"),
            }).map((found) => found.payload)
          : [],
        consumeLaunchHandoffSidecar: (payload) => consumeLaunchHandoffSidecar(payload),
        saveState: () => undefined,
      });

      const entry = state.automations["demo:demo:issue-coordinator"];
      expect(entry.lastResult).toBe("driver_invalid_result");
      const handoff = entry.pendingDriverHandoff as { monitorHandoff?: { input?: { attemptRecordFile?: string } } };
      expect(handoff.monitorHandoff?.input?.attemptRecordFile)
        .toBe(path.join(root, "runs", "fixture-worker-demo-12", "attempt.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
