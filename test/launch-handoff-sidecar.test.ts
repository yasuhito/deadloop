import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runScheduledAutomation } from "../src/automation-runner";
import { normalizeProject, type AutomationFileResolution } from "../src/core";

const {
  collectOrphanedLaunchHandoffs,
  consumeLaunchHandoffSidecar,
  writeLaunchHandoffSidecar,
} = require("../src/launch-handoff-sidecar.cts");
const {
  createPreparedAttempt,
  transitionPersistedAttempt,
} = require("../src/attempt-lifecycle-runtime.cjs");
const {
  launchAgentFlow,
  prepareAgentLaunchFlow,
  recordAgentLaunchGithubClaimed,
} = require("../src/agent-launch-flow.cts");
import type { RunnerAdapter, RunnerAgent } from "../src/runner";

const HEAD = "a".repeat(40);
const WORKER_NAME = "demo-issue-12-worker";
const WORKTREE_PATH = "/worktrees/agent-issue-12-task";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-handoff-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function collectAttemptIds(runsRoot: string, projectId: string, monitored: ReadonlySet<string>): string[] {
  return collectOrphanedLaunchHandoffs({
    runsRoot,
    projectId,
    monitoredAttemptRecordFiles: monitored,
    now: Date.parse("2026-08-29T00:00:00Z"),
  }).map((found) => found.attemptId);
}

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

/** One journal advanced to agent_started exactly like a launched attempt, without a live runtime. */
function setupAgentStartedAttempt(root: string, id: string): { runDir: string; attemptRecordFile: string } {
  const runDir = path.join(root, "runs", id);
  const promiseFile = path.join(runDir, "worker-promise.md");
  createPreparedAttempt(runDir, {
    attemptId: id, launchUuid: id, project: "demo", repository: "octo/demo", role: "worker",
    target: { kind: "issue", number: 12 }, inputRevision: { head: HEAD },
    branch: "agent/issue-12", baseBranch: "origin/main",
    worktreePath: "/worktrees/issue-12", agentName: "dl-w-12-abcdef123456",
    workspaceLabel: "Issue 12", promptFile: path.join(runDir, "prompt.md"), promiseFile,
    workspaceId: "ws-launch-1",
    agentRequest: { role: "worker", label: "agent:implement", eventId: "request-7" },
  });
  transitionPersistedAttempt(runDir, "github_claimed");
  transitionPersistedAttempt(runDir, "workspace_opened");
  transitionPersistedAttempt(runDir, "agent_started");
  return { runDir, attemptRecordFile: path.join(runDir, "attempt.json") };
}

function payloadFor(attemptRecordFile: string, projectId = "demo"): Record<string, unknown> {
  return {
    action: "monitor",
    summary: "Launched Worker for Issue #12",
    monitorHandoff: { kind: "issue", input: { projectId, attemptRecordFile } },
  };
}

function sidecarFor(stateDir: string): Record<string, unknown> {
  return {
    action: "monitor",
    summary: "Launched Worker for Issue #12",
    monitorHandoff: { kind: "issue", input: handoffInputFor(stateDir) },
  };
}

function handoffInputFor(stateDir: string): Record<string, unknown> {
  const runDir = path.join(stateDir, "runs", "worker-12");
  return {
    issueNumber: 12,
    automationDir: "/automation",
    promiseFile: path.join(runDir, "worker-promise.md"),
    attemptRecordFile: path.join(runDir, "attempt.json"),
    actorName: "Worker",
    projectId: "demo",
    repoPath: "/repo",
    githubRepo: "octo/demo",
    stateDir,
    enabledAt: 456,
    worktreePath: WORKTREE_PATH,
    branch: "agent/issue-12",
    readyLabel: "ready-for-agent",
    implementLabel: "agent:implement",
    inProgressLabel: "agent:in-progress",
    blockedLabel: "agent:blocked",
    requestEventId: "request-7",
    maxActiveMilliseconds: 86_400_000,
  };
}

function coordinatorProject() {
  return normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",
    id: "demo",
    automations: [{ id: "coordinator", name: "issue coordinator", driverFile: "issue-coordinator-driver.cts" }],
  });
}

function runnerDeps(
  _state: { automations: Record<string, Record<string, unknown>> },
  stateDir: string,
  runDriver: () => Promise<{ code: number; stdout: string }>,
) {
  return {
    notify: () => undefined,
    now: () => 456,
    prepareExecutionSupply: () => ({ codeIdentity: "a".repeat(40), lockHash: "b".repeat(64), packageRoot: "/snapshot", automationDir: "/snapshot/automations", dependencyRoot: "/dependencies" }),
    resolveAutomationFileInDir: (_kind: unknown, _automation: unknown, requested?: string): AutomationFileResolution =>
      ({ requested: requested || "", resolved: requested || "", found: Boolean(requested) }),
    runDriver: runDriver as never,
    adoptOrphanedLaunchHandoffs: (current: unknown, automation: { driverFile?: string }) =>
      automation.driverFile === "issue-coordinator-driver.cts"
        ? collectOrphanedLaunchHandoffs({
            runsRoot: path.join(stateDir, "runs"),
            projectId: "demo",
            monitoredAttemptRecordFiles: monitoredAttemptRecordFilesOf(current),
            now: Date.parse("2026-08-29T00:00:00Z"),
          }).map((found) => found.payload)
        : [],
    consumeLaunchHandoffSidecar: (payload: Record<string, unknown>) => consumeLaunchHandoffSidecar(payload),
    saveState: () => undefined,
    setStatus: () => undefined,
  };
}

/** One lost-result coordinator tick: a launched attempt whose driver output carried no handoff. */
async function coordinatorTickWithLostResult(): Promise<{ stateDir: string; entry: Record<string, unknown> }> {
  const stateDir = tempRoot();
  const project = coordinatorProject();
  const state = { automations: {} };
  await runScheduledAutomation(project, project.automations[0], 123, state, runnerDeps(state, stateDir, async () => {
    const { runDir } = launchWorkerInto(stateDir);
    // The driver's durable handoff copy lands beside the journal before its result is evaluated.
    writeLaunchHandoffSidecar(path.join(runDir, "attempt.json"), sidecarFor(stateDir));
    // The observed incident: a valid monitor summary but no monitorHandoff.
    return { code: 0, stdout: JSON.stringify({ action: "monitor", summary: "Launched Worker for Issue #12" }) };
  }));
  return { stateDir, entry: state.automations["demo:coordinator"] };
}

/** Launches one real Worker attempt journal through the launch flow with a fake runner. */
function launchWorkerInto(stateDir: string): { runDir: string } {
  const agents: RunnerAgent[] = [];
  const runner: RunnerAdapter = {
    createWorktree: () => ({ workspaceId: "workspace-12", tabId: "tab-12", rootPaneId: "pane-12", worktreePath: WORKTREE_PATH }),
    openWorktree: () => { throw new Error("worker の既存作業場所を開いてはならない"); },
    renameWorkspace: () => "",
    startAgent: () => { throw new Error("起動は共通ランチャーを経由する"); },
    listWorktrees: () => [],
    listAgents: () => agents,
    closeWorkspace: () => "",
    listWorkspaces: () => [],
    removeWorktree: () => "",
  };
  const launchInput = {
    worktree: { mode: "create" as const, branch: "agent/issue-12", baseBranch: "origin/main" },
    repoPath: "/repo",
    automationDir: "/automation",
    stateDir,
    workspaceLabel: WORKER_NAME,
    agent: "pi",
    model: "",
    level: "medium",
    uuid: "worker-12",
    promptFilePrefix: "worker-prompt",
    project: "demo",
    repository: "octo/demo",
    role: "worker" as const,
    target: { kind: "issue" as const, number: 12 },
    inputRevision: { head: HEAD },
    requiredVerification: {
      repository: "octo/demo", command: "npm test", source: { kind: "repo_policy" as const, location: "deadloop.json" }, baseRevision: HEAD,
    },
    intendedWorktreePath: WORKTREE_PATH,
    resolveWorktreeHead: true,
    renderPrompt: ({ promiseFile }: { promiseFile: string }) => `promise: ${promiseFile}`,
  };
  const ops = {
    mkdirSync: () => undefined,
    alignCheckout: () => undefined,
    runner,
    runText: (args: string[]) => {
      if (args.includes("rev-parse")) return `${HEAD}\n`;
      const nameIndex = args.indexOf("--name");
      const paneIndex = args.indexOf("--pane");
      agents.push({ name: args[nameIndex + 1], status: "working", cwd: WORKTREE_PATH, paneId: args[paneIndex + 1], agentId: "fixture" });
      return "started";
    },
    writeFileSync: () => undefined,
  };
  prepareAgentLaunchFlow(launchInput, ops);
  recordAgentLaunchGithubClaimed(launchInput);
  launchAgentFlow(launchInput, ops);
  return { runDir: path.join(stateDir, "runs", "worker-12") };
}

describe("durable launch handoff sidecar", () => {
  it("survives beside the attempt journal after the driver wrote it", () => {
    const root = tempRoot();
    const { attemptRecordFile } = setupAgentStartedAttempt(root, "launch-1");
    const payload = payloadFor(attemptRecordFile);

    writeLaunchHandoffSidecar(attemptRecordFile, payload);

    expect(JSON.parse(readFileSync(path.join(path.dirname(attemptRecordFile), "monitor-handoff.json"), "utf8")))
      .toEqual(payload);
  });

  it("collects an unmonitored sidecar whose attempt journal is still at agent_started", () => {
    const root = tempRoot();
    const { attemptRecordFile } = setupAgentStartedAttempt(root, "launch-1");
    writeLaunchHandoffSidecar(attemptRecordFile, payloadFor(attemptRecordFile));

    const collected = collectOrphanedLaunchHandoffs({
      runsRoot: path.join(root, "runs"),
      projectId: "demo",
      monitoredAttemptRecordFiles: new Set<string>(),
      now: Date.parse("2026-08-29T00:00:00Z"),
    });

    expect(collected.map((found) => found.attemptId)).toEqual(["launch-1"]);
  });

  it("keeps a monitored attempt's sidecar from being re-adopted", () => {
    const root = tempRoot();
    const { attemptRecordFile } = setupAgentStartedAttempt(root, "launch-1");
    writeLaunchHandoffSidecar(attemptRecordFile, payloadFor(attemptRecordFile));

    const collected = collectOrphanedLaunchHandoffs({
      runsRoot: path.join(root, "runs"),
      projectId: "demo",
      monitoredAttemptRecordFiles: new Set([path.resolve(attemptRecordFile)]),
      now: Date.parse("2026-08-29T00:00:00Z"),
    });

    expect(collected).toEqual([]);
  });

  it("ignores a sidecar that names another project", () => {
    const root = tempRoot();
    const { attemptRecordFile } = setupAgentStartedAttempt(root, "launch-1");
    writeLaunchHandoffSidecar(attemptRecordFile, payloadFor(attemptRecordFile, "other"));

    const collected = collectAttemptIds(path.join(root, "runs"), "demo", new Set<string>());

    expect(collected).toEqual([]);
  });

  it("collects nothing once the attempt journal left agent_started", () => {
    const root = tempRoot();
    const { runDir, attemptRecordFile } = setupAgentStartedAttempt(root, "launch-1");
    transitionPersistedAttempt(runDir, "report_received");
    writeLaunchHandoffSidecar(attemptRecordFile, payloadFor(attemptRecordFile));

    const collected = collectAttemptIds(path.join(root, "runs"), "demo", new Set<string>());

    expect(collected).toEqual([]);
  });

  it("removes the sidecar once its handoff is registered in state", () => {
    const root = tempRoot();
    const { attemptRecordFile } = setupAgentStartedAttempt(root, "launch-1");
    writeLaunchHandoffSidecar(attemptRecordFile, payloadFor(attemptRecordFile));

    consumeLaunchHandoffSidecar(payloadFor(attemptRecordFile));

    expect(existsSync(path.join(path.dirname(attemptRecordFile), "monitor-handoff.json"))).toBe(false);
  });

  it("re-adopts the monitoring handoff when the driver result is lost after the launch", async () => {
    const { stateDir, entry } = await coordinatorTickWithLostResult();

    expect((entry.pendingDriverHandoff as { monitorHandoff?: { input?: { attemptRecordFile?: string } } })
      ?.monitorHandoff?.input?.attemptRecordFile).toBe(path.join(stateDir, "runs", "worker-12", "attempt.json"));
  });

  it("records the invalidity reason of a lost monitor result in lastError", async () => {
    const { entry } = await coordinatorTickWithLostResult();

    expect(entry.lastError).toBe("monitor driver result did not include a monitor handoff");
  });

  it("names the invalidity reason as the host-log reason of the failed driver result", async () => {
    const { entry } = await coordinatorTickWithLostResult();

    expect(entry.lastSummary).toContain("monitor driver result did not include a monitor handoff");
  });

  it("consumes the sidecar after a valid monitor delivery so it is never re-adopted", async () => {
    const stateDir = tempRoot();
    const project = coordinatorProject();
    const state = { automations: {} };
    await runScheduledAutomation(project, project.automations[0], 123, state, runnerDeps(state, stateDir, async () => {
      const { runDir } = launchWorkerInto(stateDir);
      writeLaunchHandoffSidecar(path.join(runDir, "attempt.json"), sidecarFor(stateDir));
      return { code: 0, stdout: JSON.stringify({ action: "monitor", summary: "Launched Worker for Issue #12", monitorHandoff: { kind: "issue", input: { ...handoffInputFor(stateDir), enabledAt: 456 } } }) };
    }));

    expect(existsSync(path.join(stateDir, "runs", "worker-12", "monitor-handoff.json"))).toBe(false);
  });
});
