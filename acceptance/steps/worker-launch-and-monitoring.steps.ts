import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { Given, Then, When } from "@cucumber/cucumber";

import type { RunnerAdapter, RunnerAgent } from "../../src/runner";

const { launchAgentFlow } = require("../../src/agent-launch-flow.ts");
const { decideWorkerWatch } = require("../../extensions/deadloop/automations/worker-watch-decision.ts");

const workerName = "demo-issue-12-worker";
const workerPath = "/worktrees/demo/agent-issue-12-task";
const reviewerName = "demo-pr-44-reviewer";
const reviewerPath = "/worktrees/demo/feature-review";

type WorkerWorld = {
  agents?: RunnerAgent[];
  launchTarget?: "worker" | "reviewer";
  removedAgentIds?: string[];
  launchCount?: number;
  launchEvents?: string[];
  worktreeRequest?: { branch: string; baseBranch: string; label: string };
  launchError?: Error;
  coordinatorResult?: Record<string, unknown>;
  watchInput?: Record<string, unknown>;
  watchDecision?: Record<string, unknown>;
};

function launchWorker(world: WorkerWorld): void {
  const agents = world.agents ?? [];
  const removedAgentIds: string[] = [];
  const launchEvents: string[] = [];
  const isReviewer = world.launchTarget === "reviewer";
  const name = isReviewer ? reviewerName : workerName;
  const worktreePath = isReviewer ? reviewerPath : workerPath;
  let launchCount = 0;
  const runner: RunnerAdapter = {
    createWorktree: (input) => {
      if (isReviewer) throw new Error("reviewer の作業場所を作ってはならない");
      world.worktreeRequest = { branch: input.branch, baseBranch: input.baseBranch, label: input.label };
      return { workspaceId: "workspace-12", worktreePath };
    },
    openWorktree: () => {
      if (!isReviewer) throw new Error("worker の既存作業場所を開いてはならない");
      return { workspaceId: "workspace-44", worktreePath };
    },
    createTab: () => {
      launchEvents.push("create-tab");
      return { tabId: "tab-12" };
    },
    startAgent: () => {
      throw new Error("起動は共通ランチャーを経由する");
    },
    listWorktrees: () => [],
    listAgents: () => agents,
    removeAgent: (agentId) => {
      launchEvents.push(`remove:${agentId}`);
      removedAgentIds.push(agentId);
      const index = agents.findIndex((agent) => agent.agentId === agentId);
      if (index >= 0) agents.splice(index, 1);
      return "";
    },
    removeWorktree: () => "",
  };

  try {
    launchAgentFlow(
      {
        worktree: isReviewer
          ? { mode: "open", branch: "feature/review" }
          : { mode: "create", branch: "agent/issue-12-task", baseBranch: "origin/main" },
        repoPath: "/repo",
        automationDir: "/automation",
        stateDir: "/state/deadloop",
        name,
        agent: "pi",
        model: "",
        level: "medium",
        uuid: isReviewer ? "reviewer-44" : "worker-12",
        promptFilePrefix: isReviewer ? "reviewer-prompt" : "worker-prompt",
        renderPrompt: ({ promiseFile }: { promiseFile: string }) => `promise: ${promiseFile}`,
      },
      {
        mkdirSync: () => {},
        runner,
        runText: () => {
          launchCount += 1;
          launchEvents.push("launch");
          agents.push({ name, status: "working", cwd: worktreePath, agentId: "replacement" });
          return "started";
        },
        writeFileSync: () => {},
      },
    );
  } catch (error) {
    world.launchError = error instanceof Error ? error : new Error(String(error));
  }

  world.agents = agents;
  world.removedAgentIds = removedAgentIds;
  world.launchCount = launchCount;
  world.launchEvents = launchEvents;
}

Given("作業を開始できる Issue がある", function (this: WorkerWorld) {
  this.launchTarget = "worker";
  this.agents = [];
});

Given("同じ作業場所に完了済みの同名 reviewer がいる", function (this: WorkerWorld) {
  this.launchTarget = "reviewer";
  this.agents = [{ name: reviewerName, status: "done", cwd: reviewerPath, agentId: "finished" }];
});

Given("同じ作業場所に稼働中の同名 reviewer がいる", function (this: WorkerWorld) {
  this.launchTarget = "reviewer";
  this.agents = [{ name: reviewerName, status: "working", cwd: reviewerPath, agentId: "working" }];
});

Given("同じ作業場所に複数の完了済み同名 reviewer がいる", function (this: WorkerWorld) {
  this.launchTarget = "reviewer";
  this.agents = [
    { name: reviewerName, status: "done", cwd: reviewerPath, agentId: "finished-1" },
    { name: reviewerName, status: "done", cwd: reviewerPath, agentId: "finished-2" },
  ];
});

Given("別の作業場所に完了済みの同名 reviewer がいる", function (this: WorkerWorld) {
  this.launchTarget = "reviewer";
  this.agents = [{ name: reviewerName, status: "done", cwd: "/worktrees/demo/other-task", agentId: "foreign" }];
});

When("deadloop がその Issue の担当を起動する", function (this: WorkerWorld) {
  launchWorker(this);
});

When("deadloop が pull request の reviewer を起動する", function (this: WorkerWorld) {
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

Then("完了済みの担当を片付けてから交代を起動する", function (this: WorkerWorld) {
  assert.equal(this.launchEvents?.join(">"), "remove:finished>create-tab>launch");
});

Then("一人の交代担当を起動する", function (this: WorkerWorld) {
  assert.equal(this.launchCount, 1);
});

Then("稼働中の同名担当がいるため起動を拒否する", function (this: WorkerWorld) {
  assert.equal(this.launchError?.message, `agent name ${reviewerName} is working; refusing duplicate launch`);
});

Then("複数の同名担当がいるため起動を拒否する", function (this: WorkerWorld) {
  assert.equal(this.launchError?.message, `agent name ${reviewerName} has 2 live candidates; refusing cleanup`);
});

Then("別の作業場所に同名担当がいるため起動を拒否する", function (this: WorkerWorld) {
  assert.equal(
    this.launchError?.message,
    `agent name ${reviewerName} belongs to a different worktree; refusing cleanup`,
  );
});

Then("新しい担当は起動しない", function (this: WorkerWorld) {
  assert.equal(this.launchCount, 0);
});

Then("稼働中の担当は残る", function (this: WorkerWorld) {
  assert.equal(this.agents?.some((agent) => agent.agentId === "working"), true);
});

Then("候補を特定できない同名担当は片付けない", function (this: WorkerWorld) {
  assert.equal(this.removedAgentIds?.length, 0);
});

Then("別の作業場所の同名担当は片付けない", function (this: WorkerWorld) {
  assert.equal(this.removedAgentIds?.length, 0);
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
    nudgeSentAt: "2026-07-07T11:15:33Z",
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
