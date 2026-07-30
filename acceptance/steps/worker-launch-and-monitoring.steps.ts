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

Given("作業を開始できる Issue がある", function (this: WorkerWorld) {
  this.launchTarget = "worker";
  this.agents = [];
});

When("deadloop がその Issue の担当を起動する", function (this: WorkerWorld) {
  launchWorker(this);
});

Then("担当には基準ブランチから Issue 専用の作業場所を作る", function (this: WorkerWorld) {
  assert.deepEqual(this.worktreeRequest, {
    branch: "agent/issue-12-task",
    baseBranch: "origin/main",
    label: workerName,
  });
});

Then("新しい担当を一人だけ起動する", function (this: WorkerWorld) {
  assert.equal(this.launchCount, 1);
});

Given("作業を開始できる Issue が選ばれている", function (this: WorkerWorld) {
  this.coordinatorResult = undefined;
});

When("deadloop が選ばれた Issue の作業を開始する", function (this: WorkerWorld) {
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

Then("その Issue は完了ファイルの監視対象になる", function (this: WorkerWorld) {
  assert.equal(this.coordinatorResult?.driverAction, "worker_monitor_request");
});

Given("完了ファイルを求めた後に担当の最近の活動がある", function (this: WorkerWorld) {
  this.watchInput = {
    now: "2026-07-07T11:17:37Z",
    promiseStatus: "none",
    worktreeHasChanges: false,
    nudgeSentAt: "2026-07-07T11:10:33Z",
    agentStatus: "idle",
    activity: [{ kind: "tool", at: "2026-07-07T11:16:20Z" }],
  };
});

Given("完了ファイルを求めてから猶予時間内である", function (this: WorkerWorld) {
  this.watchInput = {
    now: "2026-07-07T11:17:00Z",
    promiseStatus: "none",
    agentStatus: "idle",
    nudgeSentAt: "2026-07-07T11:15:00Z",
  };
});

Given("活動を終えた担当の完了ファイルがない", function (this: WorkerWorld) {
  this.watchInput = { now: "2026-07-07T11:17:00Z", promiseStatus: "none", agentStatus: "done" };
});

Given("担当の活動停止と報告要求後の猶予経過を確認できる", function (this: WorkerWorld) {
  this.watchInput = {
    now: "2026-07-07T11:30:00Z",
    promiseStatus: "none",
    agentStatus: "done",
    nudgeSentAt: "2026-07-07T11:15:00Z",
    lastAgentSessionUpdatedAt: "2026-07-07T11:00:00Z",
    recentOutputAt: "2026-07-07T11:00:00Z",
  };
});

Given("報告要求後の猶予は過ぎたが担当画面の観測がない", function (this: WorkerWorld) {
  this.watchInput = {
    now: "2026-07-07T11:30:00Z",
    promiseStatus: "none",
    agentStatus: "done",
    nudgeSentAt: "2026-07-07T11:15:00Z",
    lastAgentSessionUpdatedAt: "2026-07-07T11:00:00Z",
  };
});

Given("{word}の担当が完了ファイルを書き終えている", function (this: WorkerWorld, status: string) {
  this.watchInput = {
    now: "2026-07-07T11:30:00Z",
    promiseStatus: "complete",
    agentStatus: status === "稼働中" ? "working" : "done",
  };
});

When("deadloop が担当の監視状態を判断する", function (this: WorkerWorld) {
  this.watchDecision = decideWorkerWatch(this.watchInput ?? {});
});

Then("担当の監視を続ける", function (this: WorkerWorld) {
  assert.equal(this.watchDecision?.action, "continue_waiting");
});

Then("担当に完了ファイルを書くよう求める", function (this: WorkerWorld) {
  assert.equal(this.watchDecision?.action, "nudge_worker");
});

Then("担当画面の終了を許す", function (this: WorkerWorld) {
  assert.equal(this.watchDecision?.action, "may_close_pane");
});

Then("終了前に不足した観測を集める", function (this: WorkerWorld) {
  assert.equal(this.watchDecision?.action, "collect_observations");
});

Then("完了ファイルに従って監視を終える", function (this: WorkerWorld) {
  assert.equal(this.watchDecision?.action, "promise_settled");
});
