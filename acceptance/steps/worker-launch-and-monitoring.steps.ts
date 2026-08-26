import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

import { fixtureStateDir } from "../support/fixture-state-dir";
const { observeAttemptMonitoringDirective } = require("../../src/monitor-handoff-observation.cts");

import type { RunnerAdapter, RunnerAgent } from "../../src/runner";

const { launchAgentFlow, prepareAgentLaunchFlow, recordAgentLaunchGithubClaimed } = require("../../src/agent-launch-flow.cts");

const workerName = "demo-issue-12-worker";
const workerPath = "/worktrees/demo/agent-issue-12-task";
const head = "f".repeat(40);

type WorkerWorld = {
  launchCount?: number;
  worktreeRequest?: { branch: string; baseBranch: string; label: string };
  coordinatorResult?: Record<string, unknown>;
  monitorAgents?: RunnerAgent[];
  monitorDirective?: Record<string, unknown> | null;
};

function launchWorker(world: WorkerWorld): void {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "deadloop-worker-acceptance-"));
  const agents: RunnerAgent[] = [];
  const name = workerName;
  const worktreePath = workerPath;
  let launchCount = 0;
  const runner: RunnerAdapter = {
    createWorktree: (input) => {
      world.worktreeRequest = { branch: input.branch, baseBranch: input.baseBranch, label: input.label };
      return { workspaceId: "workspace-12", tabId: "tab-12", rootPaneId: "pane-12", worktreePath };
    },
    openWorktree: () => { throw new Error("worker の既存作業場所を開いてはならない"); },
    renameWorkspace: () => "",
    startAgent: () => {
      throw new Error("起動は共通ランチャーを経由する");
    },
    listWorktrees: () => [],
    listAgents: () => agents,
    closeWorkspace: () => "",
    listWorkspaces: () => [],
    removeWorktree: () => "",
  };

  try {
    const launchInput = {
      worktree: { mode: "create", branch: "agent/issue-12-task", baseBranch: "origin/main" },
      repoPath: "/repo",
      automationDir: "/automation",
      stateDir,
      workspaceLabel: name,
      agent: "pi",
      model: "",
      level: "medium",
      uuid: "worker-12",
      promptFilePrefix: "worker-prompt",
      project: "demo",
      repository: "owner/repo",
      role: "worker",
      target: { kind: "issue", number: 12 },
      inputRevision: { head },
      requiredVerification: {
        repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: head,
      },
      intendedWorktreePath: worktreePath,
      resolveWorktreeHead: true,
      renderPrompt: ({ promiseFile }: { promiseFile: string }) => `promise: ${promiseFile}`,
    };
    const ops = {
      mkdirSync: () => {},
      alignCheckout: () => {},
      runner,
      runText: (args: string[]) => {
        if (args.includes("rev-parse")) return `${head}\n`;
        launchCount += 1;
        const nameIndex = args.indexOf("--name");
        const paneIndex = args.indexOf("--pane");
        agents.push({ name: args[nameIndex + 1], status: "working", cwd: worktreePath, paneId: args[paneIndex + 1], agentId: "replacement" });
        return "started";
      },
      writeFileSync: () => {},
    };
    prepareAgentLaunchFlow(launchInput, ops);
    recordAgentLaunchGithubClaimed(launchInput);
    launchAgentFlow(launchInput, ops);
  } finally {
    world.launchCount = launchCount;
    rmSync(stateDir, { recursive: true, force: true });
  }
}

/** The driver result for one fixture Issue selection, with its prepared attempt journal retained. */
function startSelectedIssueWork(): Record<string, unknown> {
  const result = spawnSync(
    "node",
    ["extensions/deadloop/automations/issue-coordinator-driver.cts", "--fixture", "test/fixtures/issue-coordinator/driver-ready-worker.json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("DEADLOOP_"))),
        DEADLOOP_PROJECT_ID: "demo",
        DEADLOOP_GITHUB_REPO: "owner/repo",
        DEADLOOP_STATE_DIR: fixtureStateDir(),
      },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

Given("An Issue is ready for work", function (this: WorkerWorld) {
  this.worktreeRequest = undefined;
});

When("deadloop starts the Issue's agent", function (this: WorkerWorld) {
  launchWorker(this);
});

Then("The agent receives a dedicated Issue worktree from the base branch", function (this: WorkerWorld) {
  assert.deepEqual(this.worktreeRequest, {
    branch: "agent/issue-12-task",
    baseBranch: "origin/main",
    label: workerName,
  });
});

Then("deadloop starts exactly one new agent", function (this: WorkerWorld) {
  assert.equal(this.launchCount, 1);
});

Given("An Issue ready for work has been selected", function (this: WorkerWorld) {
  this.coordinatorResult = undefined;
});

When("deadloop starts work on the selected Issue", function (this: WorkerWorld) {
  this.coordinatorResult = startSelectedIssueWork();
});

Then("The driver registers model-free deterministic monitoring for the Issue", function (this: WorkerWorld) {
  assert.equal(this.coordinatorResult?.action, "monitor");
});

Then("deadloop queues no host-model prompt for the Issue", function (this: WorkerWorld) {
  assert.equal(this.coordinatorResult?.prompt, undefined);
});

Then("The monitor handoff carries the consumed request generation", function (this: WorkerWorld) {
  const launch = this.coordinatorResult?.launch as Record<string, any>;
  const handoffInput = (this.coordinatorResult?.monitorHandoff as { input: Record<string, unknown> }).input;
  assert.equal(handoffInput.requestEventId, String(launch.agentRequest.eventId));
});

/**
 * Evaluate the shared directive interface against the launched fixture attempt. The runtime agent
 * list decides whether the attempt observes as working; no report exists, so terminal evidence is empty.
 */
function evaluateMonitorDirective(world: WorkerWorld): Record<string, unknown> | null {
  const handoffInput = ((world.coordinatorResult?.monitorHandoff ?? {}) as { input?: Record<string, unknown> }).input ?? {};
  let record;
  try {
    record = JSON.parse(readFileSync(path.join(path.dirname(String(handoffInput.attemptRecordFile)), "attempt.json"), "utf8"));
  } catch {
    record = null;
  }
  if (!record) return null;
  return observeAttemptMonitoringDirective(record, {
    activeMilliseconds: 0,
    observedAt: new Date(0).toISOString(),
    runtimeWasWorking: false,
  }, Date.parse("2026-07-07T11:30:00Z"), Number(handoffInput.maxActiveMilliseconds), {
    runner: { listAgents: () => world.monitorAgents ?? [] },
    readTerminalEvidence: () => "",
  }) as unknown as Record<string, unknown>;
}

Given("A monitored Issue Worker whose runtime reports working status past its last observation", function (this: WorkerWorld) {
  this.coordinatorResult = startSelectedIssueWork();
  const handoffInput = ((this.coordinatorResult?.monitorHandoff ?? {}) as { input?: Record<string, unknown> }).input ?? {};
  const journal = path.join(path.dirname(String(handoffInput.attemptRecordFile)), "attempt.json");
  const record = JSON.parse(readFileSync(journal, "utf8"));
  this.monitorAgents = [{
    name: String(record.agentName || "demo-issue-12-worker"),
    status: "working",
    cwd: String(record.worktreePath || workerPath),
    // Match the journal exactly: an absent root pane must not make the runtime look ambiguous.
    ...(record.rootPaneId === undefined ? {} : { paneId: String(record.rootPaneId) }),
    agentId: "fixture",
  }] as RunnerAgent[];
});

Given("A monitored Issue Worker whose runtime ended terminally without writing a report", function (this: WorkerWorld) {
  this.coordinatorResult = startSelectedIssueWork();
  this.monitorAgents = [];
});

When("the deterministic monitor evaluates the attempt", function (this: WorkerWorld) {
  this.monitorDirective = evaluateMonitorDirective(this);
});

Then("deadloop continues the attempt as working", function (this: WorkerWorld) {
  assert.equal(this.monitorDirective?.action, "working");
});

Then("deadloop records a missing report without sending any monitor prompt", function (this: WorkerWorld) {
  assert.equal(this.monitorDirective?.action, "missing_report");
});
