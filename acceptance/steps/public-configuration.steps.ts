import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";

import {
  observeCiFallbackLaunches,
  observeReviewerLaunch,
  observeStatus,
  observeWorkerLaunch,
  resolveSelectedProject,
  type CiInfrastructureFailure,
} from "../support/public-configuration-adapter";
import type { RawProject } from "../../src/core";

type ConfigurationWorld = {
  env?: Record<string, string | undefined>;
  files?: Record<string, RawProject>;
  policy?: RawProject;
  ciFailure?: CiInfrastructureFailure;
  launchedCiCommands?: string[];
  reviewerLaunch?: string[];
  status?: string;
  workerLaunch?: string[];
};

const environmentPath = "/environment/projects.json";
const userPath = "/state/projects.json";
const extensionPath = "/extension/projects.json";

function local(world: ConfigurationWorld, project: RawProject): void {
  world.env = { DEADLOOP_CONFIG: userPath };
  world.files = { [userPath]: project };
}

Given("環境変数、利用者領域、同梱領域に異なる設定がある", function (this: ConfigurationWorld) {
  this.files = {
    [environmentPath]: { workerModel: "environment-model" },
    [userPath]: { workerModel: "user-model" },
    [extensionPath]: { workerModel: "extension-model" },
  };
});

Given("`DEADLOOP_CONFIG` で環境変数の設定を指定する", function (this: ConfigurationWorld) {
  this.env = { DEADLOOP_CONFIG: environmentPath };
});

Given("`DEADLOOP_CONFIG` を指定しない", function (this: ConfigurationWorld) {
  this.env = {};
});

Given("同梱設定だけがある", function (this: ConfigurationWorld) {
  this.env = {};
  this.files = { [extensionPath]: {} };
});

Given("空のローカル設定がある", function (this: ConfigurationWorld) {
  local(this, {});
});

Given("自動化を空にしたローカル設定がある", function (this: ConfigurationWorld) {
  local(this, { automations: [] });
});

Given("CI 代替コマンドを含み、有効化を省略したローカル設定がある", function (this: ConfigurationWorld) {
  local(this, { ciFallback: { localCommands: ["npm test"] } });
});

Given(
  "Worker に claude と `worker-local-model` を指定したローカル設定がある",
  function (this: ConfigurationWorld) {
    local(this, { workerAgent: "claude", workerModel: "worker-local-model" });
  },
);

Given(
  "Reviewer に claude と `reviewer-local-model` を指定したローカル設定がある",
  function (this: ConfigurationWorld) {
    local(this, { reviewerAgent: "claude", reviewerModel: "reviewer-local-model" });
  },
);

Given("Worker の種別とモデルを含む共有方針と空のローカル設定がある", function (this: ConfigurationWorld) {
  local(this, {});
  this.policy = { workerAgent: "claude", workerModel: "shared-model" };
});

Given("Worker の種別とモデルが異なる共有方針とローカル設定がある", function (this: ConfigurationWorld) {
  local(this, { workerAgent: "pi", workerModel: "local-model" });
  this.policy = { workerAgent: "claude", workerModel: "shared-model" };
});

Given("Reviewer の種別とモデルを含む共有方針と空のローカル設定がある", function (this: ConfigurationWorld) {
  local(this, {});
  this.policy = { reviewerAgent: "claude", reviewerModel: "shared-reviewer-model" };
});

Given("Reviewer の種別とモデルが異なる共有方針とローカル設定がある", function (this: ConfigurationWorld) {
  local(this, { reviewerAgent: "pi", reviewerModel: "local-reviewer-model" });
  this.policy = { reviewerAgent: "claude", reviewerModel: "shared-reviewer-model" };
});

Given("自動化を空にした共有方針と空のローカル設定がある", function (this: ConfigurationWorld) {
  local(this, {});
  this.policy = { automations: [] };
});

Given("自動化を含む共有方針と空のローカル設定がある", function (this: ConfigurationWorld) {
  local(this, {});
  this.policy = { automations: [{ id: "demo:shared", name: "shared automation" }] };
});

Given("自動マージを有効にしたローカル設定がある", function (this: ConfigurationWorld) {
  local(this, { autoMerge: true });
});

Given("外部レビューを有効にした共有方針と空のローカル設定がある", function (this: ConfigurationWorld) {
  local(this, {});
  this.policy = { externalReview: { enabled: true } };
});

Given("CI が課金制限によるインフラ障害で失敗している", function (this: ConfigurationWorld) {
  this.ciFailure = {
    checks: { statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }] },
    logs: "GitHub Actions disabled because of billing",
  };
});

function projectFor(world: ConfigurationWorld) {
  if (!world.files) throw new Error("configuration precondition is missing");
  return resolveSelectedProject({ env: world.env, files: world.files, policy: world.policy });
}

When("deadloop の状態表示を要求する", function (this: ConfigurationWorld) {
  this.status = observeStatus(projectFor(this));
});

When("Worker の起動を要求する", function (this: ConfigurationWorld) {
  this.workerLaunch = observeWorkerLaunch(projectFor(this));
});

When("Reviewer の起動を要求する", function (this: ConfigurationWorld) {
  this.reviewerLaunch = observeReviewerLaunch(projectFor(this));
});

When("CI 代替実行を要求する", function (this: ConfigurationWorld) {
  if (!this.ciFailure) throw new Error("CI failure precondition is missing");
  this.launchedCiCommands = [];
  observeCiFallbackLaunches(projectFor(this), this.ciFailure, (command) => this.launchedCiCommands?.push(command));
});

Then("状態表示は環境変数の設定ファイルを示す", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /config: local=\/environment\/projects\.json/);
});

Then("状態表示は利用者設定ファイルを示す", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /config: local=\/state\/projects\.json/);
});

Then("状態表示は同梱設定ファイルを示す", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /config: local=\/extension\/projects\.json/);
});

Then("状態表示に標準の自動化が二つある", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /demo issue coordinator:[\s\S]*demo PR reviewer:/);
});

Then("状態表示に有効な自動化はない", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /Automations:\n- none/);
});

Then("Worker の起動コマンドは pi である", function (this: ConfigurationWorld) {
  assert.equal(this.workerLaunch?.[0], "pi");
});

Then("Reviewer の起動コマンドは pi である", function (this: ConfigurationWorld) {
  assert.equal(this.reviewerLaunch?.[0], "pi");
});

Then("Worker は指定したエージェントとモデルで起動する", function (this: ConfigurationWorld) {
  assert.match((this.workerLaunch ?? []).join(" "), /^claude .* --model worker-local-model /);
});

Then("Reviewer は指定したエージェントとモデルで起動する", function (this: ConfigurationWorld) {
  assert.match((this.reviewerLaunch ?? []).join(" "), /^claude .* --model reviewer-local-model /);
});

Then("Worker は共有方針の種別とモデルで起動する", function (this: ConfigurationWorld) {
  assert.match((this.workerLaunch ?? []).join(" "), /^claude .* --model shared-model /);
});

Then("Worker はローカルの種別とモデルで起動する", function (this: ConfigurationWorld) {
  assert.match((this.workerLaunch ?? []).join(" "), /^pi .* --model local-model /);
});

Then("状態表示に共有方針の自動化がある", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /shared automation:/);
});

Then("状態表示で自動マージは無効である", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /autoMerge: off/);
});

Then("状態表示で外部レビューは無効である", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /externalReview: off/);
});

Then("Reviewer は共有方針の種別とモデルで起動する", function (this: ConfigurationWorld) {
  assert.match((this.reviewerLaunch ?? []).join(" "), /^claude .* --model shared-reviewer-model /);
});

Then("Reviewer はローカルの種別とモデルで起動する", function (this: ConfigurationWorld) {
  assert.match((this.reviewerLaunch ?? []).join(" "), /^pi .* --model local-reviewer-model /);
});

Then("CI 代替コマンドは起動されない", function (this: ConfigurationWorld) {
  assert.equal(this.launchedCiCommands?.length, 0);
});

Then("状態表示で自動マージは有効である", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /autoMerge: on/);
});

Then("状態表示で外部レビューは有効である", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /externalReview: on/);
});
