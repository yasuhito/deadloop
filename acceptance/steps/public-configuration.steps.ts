import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";

import {
  observeCiFallbackDecision,
  observeReviewerLaunch,
  observeStatus,
  observeWorkerLaunch,
  resolveSelectedProject,
} from "../support/public-configuration-adapter";
import type { RawProject } from "../../src/core";

type ConfigurationWorld = {
  ciFallbackDecision?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  files?: Record<string, RawProject>;
  policy?: RawProject;
  reviewerLaunch?: string[];
  status?: string;
  workerLaunch?: string[];
};

const userPath = "/state/projects.json";
const extensionPath = "/extension/projects.json";

function local(world: ConfigurationWorld, project: RawProject): void {
  world.env = { DEADLOOP_CONFIG: userPath };
  world.files = { [userPath]: project };
}

Given("User and bundled scopes contain different configuration", function (this: ConfigurationWorld) {
  this.files = {
    [userPath]: { workerModel: "user-model" },
    [extensionPath]: { workerModel: "extension-model" },
  };
});

Given("Only bundled configuration is available", function (this: ConfigurationWorld) {
  this.env = {};
  this.files = { [extensionPath]: {} };
});

Given("Local configuration is empty", function (this: ConfigurationWorld) {
  local(this, {});
});

Given("Local configuration contains no automations", function (this: ConfigurationWorld) {
  local(this, { automations: [] });
});

Given(
  "Local configuration specifies claude and `worker-local-model` for Worker",
  function (this: ConfigurationWorld) {
    local(this, { workerAgent: "claude", workerModel: "worker-local-model" });
  },
);

Given(
  "Local configuration specifies claude and `reviewer-local-model` for Reviewer",
  function (this: ConfigurationWorld) {
    local(this, { reviewerAgent: "claude", reviewerModel: "reviewer-local-model" });
  },
);

Given("Shared policy specifies a Worker agent type and model and local configuration is empty", function (this: ConfigurationWorld) {
  local(this, {});
  this.policy = { workerAgent: "claude", workerModel: "shared-model" };
});

Given("Local configuration and shared policy specify different Worker agent types and models", function (this: ConfigurationWorld) {
  local(this, { workerAgent: "pi", workerModel: "local-model" });
  this.policy = { workerAgent: "claude", workerModel: "shared-model" };
});

Given("Shared policy specifies a Reviewer agent type and model and local configuration is empty", function (this: ConfigurationWorld) {
  local(this, {});
  this.policy = { reviewerAgent: "claude", reviewerModel: "shared-reviewer-model" };
});

Given("Local configuration and shared policy specify different Reviewer agent types and models", function (this: ConfigurationWorld) {
  local(this, { reviewerAgent: "pi", reviewerModel: "local-reviewer-model" });
  this.policy = { reviewerAgent: "claude", reviewerModel: "shared-reviewer-model" };
});

Given("Shared policy contains no automations and local configuration is empty", function (this: ConfigurationWorld) {
  local(this, {});
  this.policy = { automations: [] };
});

Given("Shared policy contains automation and local configuration is empty", function (this: ConfigurationWorld) {
  local(this, {});
  this.policy = { automations: [{ id: "demo:shared", name: "shared automation" }] };
});

Given("Local configuration explicitly enables automatic merge", function (this: ConfigurationWorld) {
  local(this, { autoMerge: true });
});

Given("Shared policy enables external review and local configuration is empty", function (this: ConfigurationWorld) {
  local(this, {});
  this.policy = { externalReview: { enabled: true } };
});

function projectFor(world: ConfigurationWorld) {
  if (!world.files) throw new Error("configuration precondition is missing");
  return resolveSelectedProject({ env: world.env, files: world.files, policy: world.policy });
}

When("deadloop status is requested", function (this: ConfigurationWorld) {
  this.status = observeStatus(projectFor(this));
});

When("A Worker launch is requested", function (this: ConfigurationWorld) {
  this.workerLaunch = observeWorkerLaunch(projectFor(this));
});

When("A Reviewer launch is requested", function (this: ConfigurationWorld) {
  this.reviewerLaunch = observeReviewerLaunch(projectFor(this));
});

When("CI fallback permission is determined from public configuration", function (this: ConfigurationWorld) {
  this.ciFallbackDecision = observeCiFallbackDecision(projectFor(this));
});

Then("Status shows the user configuration file", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /config: local=\/state\/projects\.json/);
});

Then("Status shows the bundled configuration file", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /config: local=\/extension\/projects\.json/);
});

Then("Status shows two default automations", function (this: ConfigurationWorld) {
  const lines = (this.status ?? "").split("\n");
  const automationLines = lines.slice(lines.indexOf("Automations:") + 1);
  const automationNames = automationLines
    .slice(0, automationLines.indexOf(""))
    .map((line) => line.match(/^- ([^:]+):/)?.[1]);
  assert.deepEqual(automationNames, ["demo issue coordinator", "demo PR reviewer"]);
});

Then("Status shows no enabled automation", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /Automations:\n- none/);
});

Then("The Worker launch command is pi", function (this: ConfigurationWorld) {
  assert.equal(this.workerLaunch?.[0], "pi");
});

Then("The Reviewer launch command is pi", function (this: ConfigurationWorld) {
  assert.equal(this.reviewerLaunch?.[0], "pi");
});

Then("The Worker is launched with the configured agent type", function (this: ConfigurationWorld) {
  assert.equal(this.workerLaunch?.[0], "claude");
});

Then("The Worker is launched with the configured model", function (this: ConfigurationWorld) {
  const modelIndex = this.workerLaunch?.indexOf("--model") ?? -1;
  assert.equal(this.workerLaunch?.[modelIndex + 1], "worker-local-model");
});

Then("The Reviewer is launched with the configured agent type", function (this: ConfigurationWorld) {
  assert.equal(this.reviewerLaunch?.[0], "claude");
});

Then("The Reviewer is launched with the configured model", function (this: ConfigurationWorld) {
  const modelIndex = this.reviewerLaunch?.indexOf("--model") ?? -1;
  assert.equal(this.reviewerLaunch?.[modelIndex + 1], "reviewer-local-model");
});

Then("The Worker is launched with the shared-policy agent type", function (this: ConfigurationWorld) {
  assert.equal(this.workerLaunch?.[0], "claude");
});

Then("The Worker is launched with the shared-policy model", function (this: ConfigurationWorld) {
  const modelIndex = this.workerLaunch?.indexOf("--model") ?? -1;
  assert.equal(this.workerLaunch?.[modelIndex + 1], "shared-model");
});

Then("The Worker is launched with the local agent type", function (this: ConfigurationWorld) {
  assert.equal(this.workerLaunch?.[0], "pi");
});

Then("The Worker is launched with the local model", function (this: ConfigurationWorld) {
  const modelIndex = this.workerLaunch?.indexOf("--model") ?? -1;
  assert.equal(this.workerLaunch?.[modelIndex + 1], "local-model");
});

Then("Status shows the shared-policy automation", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /shared automation:/);
});

Then("Status shows automatic merge as disabled", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /autoMerge: off/);
});

Then("Public configuration does not allow CI fallback verification", function (this: ConfigurationWorld) {
  assert.equal(this.ciFallbackDecision?.fallbackAllowed, false);
});

Then("Status shows external review as disabled", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /externalReview: off/);
});

Then("The Reviewer is launched with the shared-policy agent type", function (this: ConfigurationWorld) {
  assert.equal(this.reviewerLaunch?.[0], "claude");
});

Then("The Reviewer is launched with the shared-policy model", function (this: ConfigurationWorld) {
  const modelIndex = this.reviewerLaunch?.indexOf("--model") ?? -1;
  assert.equal(this.reviewerLaunch?.[modelIndex + 1], "shared-reviewer-model");
});

Then("The Reviewer is launched with the local agent type", function (this: ConfigurationWorld) {
  assert.equal(this.reviewerLaunch?.[0], "pi");
});

Then("The Reviewer is launched with the local model", function (this: ConfigurationWorld) {
  const modelIndex = this.reviewerLaunch?.indexOf("--model") ?? -1;
  assert.equal(this.reviewerLaunch?.[modelIndex + 1], "local-reviewer-model");
});

Then("Status shows automatic merge as enabled", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /autoMerge: on/);
});

Then("Status shows external review as enabled", function (this: ConfigurationWorld) {
  assert.match(this.status ?? "", /externalReview: on/);
});
