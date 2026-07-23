import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";

import { normalizeProject } from "../../src/core";
import { buildDoctorSnapshot, formatDoctorReport, type DoctorInput } from "../../src/doctor";

const NOW = Date.parse("2026-07-05T00:00:00Z");
const SLOT_MS = 10 * 60_000;

type DoctorWorld = { input?: DoctorInput; report?: string };

function project(overrides: Record<string, unknown> = {}) {
  return normalizeProject({
    id: "deadloop",
    repoPath: "/repo",
    githubRepo: "owner/repo",
    worktreeRoot: "/wt",
    automations: [{ id: "auto", name: "issue-coordinator", schedule: "*/10 * * * *", precheckFile: "issue-coordinator.precheck.sh" }],
    ...overrides,
  });
}

function setInput(world: DoctorWorld, overrides: Partial<DoctorInput> = {}): void {
  world.input = {
    cwd: "/repo",
    projects: [project()],
    issues: [],
    openPrs: [],
    worktrees: [],
    agents: [],
    gitStatuses: {},
    automationDir: "/ext/automations",
    statePath: "/state/state.json",
    nowMs: NOW,
    ...overrides,
  };
}

function report(world: DoctorWorld): string {
  if (!world.report) throw new Error("doctor report is missing");
  return world.report;
}

Given("Issue が停止状態である", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 1, labels: ["agent:blocked"] }] });
});

Given("Issue が停止理由のコメントを持つ", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 1, labels: ["agent:blocked"], comments: [{ body: "BLOCKED: missing API token.", createdAt: "2026-07-04T00:00:00Z" }] }] });
});

Given("作業場所を持つ古い作業中 Issue がある", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 2, labels: ["agent:in-progress"], updatedAt: "2026-07-03T23:59:59Z" }], worktrees: [{ branch: "agent/issue-2-demo", path: "/wt/agent-issue-2-demo" }] });
});

Given("担当者が稼働中の最近更新された作業中 Issue がある", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 2, labels: ["agent:in-progress"], updatedAt: "2026-07-04T00:00:01Z" }], agents: [{ name: "deadloop-issue-2-worker", agent_status: "working" }] });
});

Given("きれいな未使用の作業場所がある", function (this: DoctorWorld) {
  setInput(this, { worktrees: [{ branch: "agent/issue-3-old", path: "/wt/agent-issue-3-old", open_workspace_id: "ws-3" }], gitStatuses: { "/wt/agent-issue-3-old": "" } });
});

Given("変更のある未使用の作業場所がある", function (this: DoctorWorld) {
  setInput(this, { worktrees: [{ branch: "agent/issue-4-dirty", path: "/wt/agent-issue-4-dirty", open_workspace_id: "ws-4" }], gitStatuses: { "/wt/agent-issue-4-dirty": " M src/file.ts" } });
});

Given("開いている pull request の作業場所がある", function (this: DoctorWorld) {
  setInput(this, { openPrs: [{ number: 5, headRefName: "agent/issue-5-active" }], worktrees: [{ branch: "agent/issue-5-active", path: "/wt/agent-issue-5-active", open_workspace_id: "ws-5" }], gitStatuses: { "/wt/agent-issue-5-active": "" } });
});

Given("実装待ちラベルがない準備済み Issue がある", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 6, labels: ["ready-for-agent"] }] });
});

Given("トリアージ待ち Issue がある", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 7, labels: ["needs-triage"] }] });
});

Given("事前確認スクリプトが実行できない自動化がある", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "precheck_skipped:127", lastAttemptAt: NOW, failureStreak: 1 } } } });
});

Given("事前確認スクリプトが存在しない自動化がある", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "precheck_file_missing", lastAttemptAt: NOW, failureStreak: 1 } } } });
});

Given("同じ失敗を繰り返す自動化がある", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "precheck_error", lastAttemptAt: NOW, failureStreak: 3 } } } });
});

Given("作業がない通常の自動化がある", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "precheck_skipped:1", lastAttemptAt: NOW, failureStreak: 3 } } } });
});

Given("実行が停止した自動化がある", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "queued", lastAttemptAt: NOW - 3 * SLOT_MS - 1, failureStreak: 0 } } } });
});

Given("最近実行された自動化がある", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "queued", lastAttemptAt: NOW, failureStreak: 0 } } } });
});

Given("Claude 用の未承認作業場所がある", function (this: DoctorWorld) {
  setInput(this, { projects: [project({ workerAgent: "claude" })], claudeConfig: { ok: true, projects: {} } });
});

Given("Claude 用の承認済み作業場所がある", function (this: DoctorWorld) {
  setInput(this, { projects: [project({ workerAgent: "claude" })], claudeConfig: { ok: true, projects: { "/repo": { hasTrustDialogAccepted: true } } } });
});

Given("Claude レビュアー用の未承認作業場所がある", function (this: DoctorWorld) {
  setInput(this, { projects: [project({ reviewerAgent: "claude" })], claudeConfig: { ok: true, projects: {} } });
});

Given("Claude を使わない作業場所がある", function (this: DoctorWorld) {
  setInput(this, { claudeConfig: { ok: false } });
});

Given("信頼状態を確認できない Claude 作業場所がある", function (this: DoctorWorld) {
  setInput(this, { projects: [project({ workerAgent: "claude" })], claudeConfig: { ok: false } });
});

Given("担当者がいないレビュー占有がある", function (this: DoctorWorld) {
  setInput(this, { openPrs: [{ number: 10, headRefName: "agent/issue-10-demo", labels: ["agent:reviewing"] }] });
});

Given("担当者が稼働中のレビュー占有がある", function (this: DoctorWorld) {
  setInput(this, { openPrs: [{ number: 10, headRefName: "agent/issue-10-demo", labels: ["agent:reviewing"] }], agents: [{ name: "deadloop-pr-10-reviewer", agent_status: "working" }] });
});

Given("作業場所を持つ担当者がいない実装占有がある", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 11, labels: ["agent:in-progress"] }], worktrees: [{ branch: "agent/issue-11-demo", path: "/wt/agent-issue-11-demo" }] });
});

Given("占有ラベルがない作業がある", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 13, labels: [] }], openPrs: [{ number: 12, headRefName: "agent/issue-12-demo", labels: [] }] });
});

Given("問題のない deadloop プロジェクトがある", function (this: DoctorWorld) {
  setInput(this);
});

When("deadloop doctor を実行する", function (this: DoctorWorld) {
  if (!this.input) throw new Error("doctor input is missing");
  this.report = formatDoctorReport(buildDoctorSnapshot(this.input));
});

Then("停止した Issue の再投入コマンドが表示される", function (this: DoctorWorld) {
  assert.match(report(this), /gh issue edit 1 --remove-label agent:blocked --add-label agent:implement/);
});

Then("トリアージ待ち Issue の再投入コマンドが表示される", function (this: DoctorWorld) {
  assert.match(report(this), /gh issue edit 7 --remove-label needs-triage --add-label ready-for-agent --add-label agent:implement/);
});

Then("停止理由が表示される", function (this: DoctorWorld) {
  assert.match(report(this), /BLOCKED: missing API token\./);
});

Then("作業場所の変更を確認するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(report(this), /git -C \/wt\/(?:agent-issue-2-demo|agent-issue-4-dirty) status --short/);
});

Then("問題は表示されない", function (this: DoctorWorld) {
  assert.match(report(this), /Findings: none/);
});

Then("作業場所を片付けるコマンドが表示される", function (this: DoctorWorld) {
  assert.match(report(this), /herdr worktree remove --workspace ws-3/);
});

Then("実装待ちラベルを付けるコマンドが表示される", function (this: DoctorWorld) {
  assert.match(report(this), /gh issue edit 6 --add-label agent:implement/);
});

Then("Issue を確認するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(report(this), /gh issue view 7/);
});

Then("事前確認スクリプトを確認するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(report(this), /ls \/ext\/automations\/issue-coordinator\.precheck\.sh/);
});

Then("繰り返し失敗する自動化が表示される", function (this: DoctorWorld) {
  assert.match(report(this), /\[automation_spinning\]/);
});

Then("停止した自動化が表示される", function (this: DoctorWorld) {
  assert.match(report(this), /\[coordinator_stalled\]/);
});

Then("作業場所を承認するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(report(this), /cd \/repo && claude/);
});

Then("信頼状態を確認するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(report(this), /jq --arg p \/repo/);
});

Then("レビュー占有を解除するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(report(this), /gh pr edit 10 -R owner\/repo --remove-label agent:reviewing/);
});

Then("未担当の実装占有を確認するコマンドが表示される", function (this: DoctorWorld) {
  assert.match(report(this), /git -C \/wt\/agent-issue-11-demo log origin\/main\.\.HEAD --oneline/);
});

Then("問題がないことが表示される", function (this: DoctorWorld) {
  assert.match(report(this), /Findings: none/);
});

Then("設定の読み込み元が表示される", function (this: DoctorWorld) {
  assert.match(report(this), /config: local=unknown local projects\.json; repoPolicy=origin\/main:deadloop\.json \(not-read\)/);
});
