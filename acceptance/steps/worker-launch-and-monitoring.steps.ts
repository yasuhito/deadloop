import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

import type { RunnerAdapter, RunnerAgent } from "../../src/runner";

const { launchAgentFlow, prepareAgentLaunchFlow, recordAgentLaunchGithubClaimed } = require("../../src/agent-launch-flow.ts");
const { decideWorkerWatch } = require("../../extensions/deadloop/automations/worker-watch-decision.ts");

const workerName = "demo-issue-12-worker";
const workerPath = "/worktrees/demo/agent-issue-12-task";

type WorkerWorld = {
  agents?: RunnerAgent[];
  launchTarget?: "worker";
  launchCount?: number;
  launchEvents?: string[];
  worktreeRequest?: { branch: string; baseBranch: string; label: string };
  launchError?: Error;
  coordinatorResult?: Record<string, unknown>;
  watchInput?: Record<string, unknown>;
  watchDecision?: Record<string, unknown>;
};

function launchWorker(world: WorkerWorld): void {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "deadloop-worker-acceptance-"));
  const agents = world.agents ?? [];
  const launchEvents: string[] = [];
  const name = workerName;
  const worktreePath = workerPath;
  let launchCount = 0;
  const runner: RunnerAdapter = {
    createWorktree: (input) => {
      world.worktreeRequest = { branch: input.branch, baseBranch: input.baseBranch, label: input.label };
      return { workspaceId: "workspace-12", tabId: "tab-12", rootPaneId: "pane-12", worktreePath };
    },
    openWorktree: () => { throw new Error("worker の既存作業場所を開いてはならない"); },
    renameWorkspace: () => {
      launchEvents.push("rename-workspace");
      return "";
    },
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
        inputRevision: { head: "f".repeat(40) },
        intendedWorktreePath: worktreePath,
        resolveWorktreeHead: true,
        renderPrompt: ({ promiseFile }: { promiseFile: string }) => `promise: ${promiseFile}`,
      };
    const ops = {
        mkdirSync: () => {},
        runner,
        runText: (args) => {
          if (args.includes("rev-parse")) return `${"f".repeat(40)}\n`;
          launchCount += 1;
          launchEvents.push("launch");
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
  } catch (error) {
    world.launchError = error instanceof Error ? error : new Error(String(error));
  }

  world.agents = agents;
  world.launchCount = launchCount;
  world.launchEvents = launchEvents;
  rmSync(stateDir, { recursive: true, force: true });
}

Given("An Issue is ready for work", function (this: WorkerWorld) {
  this.launchTarget = "worker";
  this.agents = [];
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
  const result = spawnSync(
    "node",
    ["extensions/deadloop/automations/issue-coordinator-driver.ts", "--fixture", "test/fixtures/issue-coordinator/driver-ready-worker.json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("DEADLOOP_"))),
        DEADLOOP_PROJECT_ID: "demo",
      },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  this.coordinatorResult = JSON.parse(result.stdout);
});

Then("The Issue enters promise-file monitoring", function (this: WorkerWorld) {
  assert.equal(this.coordinatorResult?.driverAction, "worker_monitor_request");
});

Given("The agent has recent activity after being asked for a promise file", function (this: WorkerWorld) {
  this.watchInput = {
    now: "2026-07-07T11:17:37Z",
    promiseStatus: "none",
    worktreeHasChanges: false,
    nudgeSentAt: "2026-07-07T11:10:33Z",
    agentStatus: "idle",
    activity: [{ kind: "tool", at: "2026-07-07T11:16:20Z" }],
  };
});

Given("The promise-file request is still within its grace period", function (this: WorkerWorld) {
  this.watchInput = {
    now: "2026-07-07T11:17:00Z",
    promiseStatus: "none",
    agentStatus: "idle",
    nudgeSentAt: "2026-07-07T11:15:00Z",
  };
});

Given("An agent has finished activity without writing a promise file", function (this: WorkerWorld) {
  this.watchInput = { now: "2026-07-07T11:17:00Z", promiseStatus: "none", agentStatus: "done" };
});

Given("Agent inactivity and expiry of the post-request grace period are confirmed", function (this: WorkerWorld) {
  this.watchInput = {
    now: "2026-07-07T11:30:00Z",
    promiseStatus: "none",
    agentStatus: "done",
    nudgeSentAt: "2026-07-07T11:15:00Z",
    lastAgentSessionUpdatedAt: "2026-07-07T11:00:00Z",
    recentOutputAt: "2026-07-07T11:00:00Z",
  };
});

Given("The post-request grace period expired without an observation of the agent pane", function (this: WorkerWorld) {
  this.watchInput = {
    now: "2026-07-07T11:30:00Z",
    promiseStatus: "none",
    agentStatus: "done",
    nudgeSentAt: "2026-07-07T11:15:00Z",
    lastAgentSessionUpdatedAt: "2026-07-07T11:00:00Z",
  };
});

Given("The {word} agent has finished writing the promise file", function (this: WorkerWorld, status: string) {
  this.watchInput = {
    now: "2026-07-07T11:30:00Z",
    promiseStatus: "complete",
    agentStatus: status === "working" ? "working" : "done",
  };
});

When("deadloop evaluates the agent's monitoring state", function (this: WorkerWorld) {
  this.watchDecision = decideWorkerWatch(this.watchInput ?? {});
});

Then("deadloop continues monitoring the agent", function (this: WorkerWorld) {
  assert.equal(this.watchDecision?.action, "continue_waiting");
});

Then("deadloop asks the agent to write the promise file", function (this: WorkerWorld) {
  assert.equal(this.watchDecision?.action, "nudge_worker");
});

Then("deadloop permits the agent pane to close", function (this: WorkerWorld) {
  assert.equal(this.watchDecision?.action, "may_close_pane");
});

Then("deadloop collects the missing observation before termination", function (this: WorkerWorld) {
  assert.equal(this.watchDecision?.action, "collect_observations");
});

Then("deadloop ends monitoring according to the promise file", function (this: WorkerWorld) {
  assert.equal(this.watchDecision?.action, "promise_settled");
});
