import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";

import { normalizeProject } from "../../src/core";
import { buildDoctorSnapshot, formatDoctorReport, type DoctorInput } from "../../src/doctor";

type DoctorWorld = { input?: DoctorInput; report?: string };

const nowMs = Date.parse("2026-07-05T00:00:00Z");
const project = normalizeProject({
  id: "deadloop",
  repoPath: "/repo",
  githubRepo: "owner/repo",
  worktreeRoot: "/wt",
  automations: [{ id: "auto", name: "issue-coordinator", schedule: "*/10 * * * *", precheckFile: "issue-coordinator.precheck.sh" }],
});

function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    cwd: "/repo",
    projects: [project],
    issues: [],
    openPrs: [],
    worktrees: [],
    gitStatuses: {},
    automationDir: "/ext/automations",
    statePath: "/state/state.json",
    nowMs,
    ...overrides,
  };
}

function setInput(world: DoctorWorld, overrides: Partial<DoctorInput>): void {
  world.input = input(overrides);
}

Given("`agent:blocked` の Issue がある", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 1, labels: ["agent:blocked"] }] });
});

Given("停止理由が記録された `agent:blocked` の Issue がある", function (this: DoctorWorld) {
  setInput(this, {
    issues: [{
      number: 1,
      labels: ["agent:blocked"],
      comments: [
        { body: "BLOCKED: old reason", createdAt: "2026-07-03T00:00:00Z" },
        { body: "BLOCKED: missing API token.\n\nTry again later.", createdAt: "2026-07-04T00:00:00Z" },
      ],
    }],
  });
});

Given("更新が24時間以上止まった `agent:in-progress` の Issue と作業場所がある", function (this: DoctorWorld) {
  setInput(this, {
    issues: [{ number: 2, labels: ["agent:in-progress"], updatedAt: "2026-07-03T23:59:59Z" }],
    worktrees: [{ branch: "agent/issue-2-demo", path: "/wt/agent-issue-2-demo", open_workspace_id: "ws-2" }],
  });
});

Given("最近更新され作業中の `agent:in-progress` の Issue がある", function (this: DoctorWorld) {
  setInput(this, {
    issues: [{ number: 2, labels: ["agent:in-progress"], updatedAt: "2026-07-04T00:00:01Z" }],
    agents: [{ name: "deadloop-issue-2-worker", agent_status: "working" }],
  });
});

Given("変更のない孤立した作業場所がある", function (this: DoctorWorld) {
  setInput(this, {
    worktrees: [{ branch: "agent/issue-3-old", path: "/wt/agent-issue-3-old", open_workspace_id: "ws-3" }],
    gitStatuses: { "/wt/agent-issue-3-old": "" },
  });
});

Given("変更中の孤立した作業場所がある", function (this: DoctorWorld) {
  setInput(this, {
    worktrees: [{ branch: "agent/issue-4-dirty", path: "/wt/agent-issue-4-dirty", open_workspace_id: "ws-4" }],
    gitStatuses: { "/wt/agent-issue-4-dirty": " M src/file.ts" },
  });
});

Given("開いている pull request に紐づく作業場所がある", function (this: DoctorWorld) {
  setInput(this, {
    openPrs: [{ number: 5, headRefName: "agent/issue-5-active" }],
    worktrees: [{ branch: "agent/issue-5-active", path: "/wt/agent-issue-5-active", open_workspace_id: "ws-5" }],
    gitStatuses: { "/wt/agent-issue-5-active": "" },
  });
});

Given("`ready-for-agent` だけが付いた Issue がある", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 6, labels: ["ready-for-agent"] }] });
});

Given("`needs-triage` の Issue がある", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 7, labels: ["needs-triage"] }] });
});

Given("実行前確認が利用できない記録がある", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "precheck_skipped:127", lastAttemptAt: nowMs } } } });
});

Given("実行前確認ファイルがない記録がある", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "precheck_file_missing", lastAttemptAt: nowMs } } } });
});

Given("同じ自動化失敗が繰り返された記録がある", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "precheck_error", lastAttemptAt: nowMs, failureStreak: 3 } } } });
});

Given("作業がない通常の待機の記録がある", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "precheck_skipped:1", lastAttemptAt: nowMs, failureStreak: 3 } } } });
});

Given("自動化の試行が3回分以上止まっている", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "queued", lastAttemptAt: nowMs - 1_800_001 } } } });
});

Given("最近試行した正常な自動化がある", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "queued", lastAttemptAt: nowMs } } } });
});

Given("信頼していない Claude の作業場所がある", function (this: DoctorWorld) {
  setInput(this, { projects: [normalizeProject({ ...project, workerAgent: "claude" })], claudeConfig: { ok: true, projects: {} } });
});

Given("信頼済み Claude の作業場所がある", function (this: DoctorWorld) {
  setInput(this, { projects: [normalizeProject({ ...project, workerAgent: "claude" })], claudeConfig: { ok: true, projects: { "/repo": { hasTrustDialogAccepted: true } } } });
});

Given("信頼していない Claude のレビュー作業場所がある", function (this: DoctorWorld) {
  setInput(this, { projects: [normalizeProject({ ...project, reviewerAgent: "claude" })], claudeConfig: { ok: true, projects: {} } });
});

Given("Pi だけを使う作業場所がある", function (this: DoctorWorld) {
  setInput(this, { claudeConfig: { ok: false } });
});

Given("Claude の信頼設定を読めない作業場所がある", function (this: DoctorWorld) {
  setInput(this, { projects: [normalizeProject({ ...project, workerAgent: "claude" })], claudeConfig: { ok: false } });
});

Given("動いているレビューエージェントがいない `agent:reviewing` の pull request がある", function (this: DoctorWorld) {
  setInput(this, { openPrs: [{ number: 10, headRefName: "agent/issue-10-demo", labels: ["agent:reviewing"] }] });
});

Given("動いているレビューエージェントがある `agent:reviewing` の pull request がある", function (this: DoctorWorld) {
  setInput(this, {
    openPrs: [{ number: 10, headRefName: "agent/issue-10-demo", labels: ["agent:reviewing"] }],
    agents: [{ name: "deadloop-pr-10-reviewer", agent_status: "working" }],
  });
});

Given("動いている Worker がいない `agent:in-progress` の Issue と作業場所がある", function (this: DoctorWorld) {
  setInput(this, {
    issues: [{ number: 11, labels: ["agent:in-progress"] }],
    worktrees: [{ branch: "agent/issue-11-demo", path: "/wt/agent-issue-11-demo", open_workspace_id: "ws-11" }],
  });
});

Given("占有ラベルのない Issue と pull request がある", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 13, labels: [] }], openPrs: [{ number: 12, headRefName: "agent/issue-12-demo", labels: [] }] });
});

Given("問題のない deadloop プロジェクトがある", function (this: DoctorWorld) {
  setInput(this, {});
});

When("オペレーターが doctor を実行する", function (this: DoctorWorld) {
  if (!this.input) throw new Error("doctor input is missing");
  this.report = formatDoctorReport(buildDoctorSnapshot(this.input));
});

Then("Issue を再投入するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /gh issue edit 1 --remove-label agent:blocked --add-label agent:implement/);
});

Then("最新の停止理由が表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /BLOCKED: missing API token\./);
});

Then("古い作業場所の変更を確認するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /git -C \/wt\/agent-issue-2-demo status --short/);
});

Then("変更中の作業場所を確認するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /git -C \/wt\/agent-issue-4-dirty status --short/);
});

Then("doctor は問題を表示しない", function (this: DoctorWorld) {
  assert.match(this.report || "", /Findings: none/);
});

Then("作業場所を片付けるコマンドが表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /herdr worktree remove --workspace ws-3/);
});

Then("Issue を投入するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /gh issue edit 6 --add-label agent:implement/);
});

Then("Issue を確認するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /gh issue view 7/);
});

Then("要確認の Issue を再投入するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /gh issue edit 7 --remove-label needs-triage --add-label ready-for-agent --add-label agent:implement/);
});

Then("実行前確認ファイルを調べるコマンドが表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /ls \/ext\/automations\/issue-coordinator\.precheck\.sh/);
});

Then("繰り返している自動化失敗が表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /\[automation_spinning\]/);
});

Then("停止した自動化が表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /\[coordinator_stalled\]/);
});

Then("Claude の作業場所を開くコマンドが表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /cd \/repo && claude/);
});

Then("Claude の信頼設定を調べるコマンドが表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /jq --arg p \/repo '.projects\[\$p\]\.hasTrustDialogAccepted' ~\/\.claude\.json/);
});

Then("レビュー占有を解放するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /gh pr edit 10 -R owner\/repo --remove-label agent:reviewing/);
});

Then("作業場所のコミットを確認するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /git -C \/wt\/agent-issue-11-demo log origin\/main\.\.HEAD --oneline/);
});

Then("doctor は問題なしを表示する", function (this: DoctorWorld) {
  assert.match(this.report || "", /Findings: none/);
});

Then("設定の出所が表示される", function (this: DoctorWorld) {
  assert.match(this.report || "", /config: local=unknown local projects\.json; repoPolicy=origin\/main:deadloop\.json \(not-read\)/);
});
