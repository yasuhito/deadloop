import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { Given, Then, When } from "@cucumber/cucumber";

const { humanHandoffComplete, humanHandoffLabelMove } = require("../../src/human-handoff.cts");

type IssueDriverLaunch = { agentRequest?: { eventId?: string }; issueLabels?: string[] };
type IssueDriverResult = { driverAction?: string; launch?: IssueDriverLaunch };
type WorkflowStateWorld = {
  fixtureName?: string;
  agents?: Record<string, unknown>;
  attempts?: Record<string, unknown>[];
  decision?: { selected?: boolean; number?: number; reason?: string };
  driverResult?: IssueDriverResult;
};

const emptyAgents = { result: { agents: [] } };

function setPrFixture(world: WorkflowStateWorld, fixtureName: string): void {
  world.fixtureName = fixtureName;
  world.agents = emptyAgents;
  world.attempts = [];
}

Given("A pull request carries the retired `agent:reviewing` label with in-progress state and no live agent", function (this: WorkflowStateWorld) {
  setPrFixture(this, "precheck-retired-reviewing.json");
});

Given("A pull request waits for review with a retained journal from its finished attempt", function (this: WorkflowStateWorld) {
  setPrFixture(this, "precheck-agent-review.json");
  this.attempts = [{
    project: "demo",
    repository: "owner/repo",
    role: "reviewer",
    target: { kind: "pull-request", number: 7 },
    phase: "report_received",
  }];
});

Given("A migrating pull request carries both the retired reviewing label and a review request with stale in-progress state", function (this: WorkflowStateWorld) {
  setPrFixture(this, "precheck-migration-reviewing.json");
});

Given("An Issue carries both an exploration and an implementation request", function () {});

When("deadloop processes the Issue's queued requests", function (this: WorkflowStateWorld) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-issue-driver-"));
  try {
    const result = spawnSync(
      "node",
      ["extensions/deadloop/automations/issue-coordinator-driver.cts", "--fixture", "test/fixtures/issue-coordinator/driver-explore.json"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DEADLOOP_PROJECT_ID: "demo",
          DEADLOOP_REPO_PATH: "/repo path",
          DEADLOOP_GITHUB_REPO: "owner/repo",
          DEADLOOP_CHECK_COMMAND: "npm test",
          DEADLOOP_WORKER_AGENT: "pi",
          DEADLOOP_STATE_DIR: stateDir,
        },
      },
    );
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    this.driverResult = JSON.parse(result.stdout) as IssueDriverResult;
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

Then("The explorer starts for the Issue", function (this: WorkflowStateWorld) {
  assert.equal(this.driverResult?.driverAction, "explorer_monitor_request");
});

Then("The implementation request stays queued after exploration consumes its own", function (this: WorkflowStateWorld) {
  assert.ok((this.driverResult?.launch?.issueLabels ?? []).includes("agent:implement"));
});

Then("The explorer binds to the exploration request event", function (this: WorkflowStateWorld) {
  assert.equal(this.driverResult?.launch?.agentRequest?.eventId, "2");
});

Given("An approved draft pull request is handed to people", function () {});

Then("The handoff removes every agent workflow label and adds none", function () {
  const labels = {
    reviewLabel: "agent:review",
    implementLabel: "agent:implement",
    updateBranchLabel: "agent:update-branch",
    inProgressLabel: "agent:in-progress",
    blockedLabel: "agent:blocked",
    humanLabel: "ready-for-human",
  };
  assert.deepEqual(humanHandoffLabelMove(labels), {
    remove: ["agent:review", "agent:implement", "agent:update-branch", "agent:in-progress", "agent:blocked"],
    add: [],
  });
});

Then("The human handoff is complete for a ready pull request with no labels left", function () {
  const labels = {
    reviewLabel: "agent:review",
    implementLabel: "agent:implement",
    updateBranchLabel: "agent:update-branch",
    inProgressLabel: "agent:in-progress",
    blockedLabel: "agent:blocked",
    humanLabel: "ready-for-human",
  };
  assert.equal(humanHandoffComplete({ isDraft: false, labels: [] }, labels), true);
});
