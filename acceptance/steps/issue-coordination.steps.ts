import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

type IssueCoordinationResult = {
  action?: string;
  comment?: string;
  launch?: { instructions?: string; simulated?: boolean };
  monitorHandoff?: { kind?: string };
};

type IssueCoordinationWorld = {
  fixtureName?: string;
  result?: IssueCoordinationResult;
};

const driverScript = "extensions/deadloop/automations/issue-coordinator-driver.ts";

function coordinateIssue(fixtureName: string): IssueCoordinationResult {
  const result = spawnSync(
    "node",
    [driverScript, "--fixture", path.join("test/fixtures/issue-coordinator", fixtureName)],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DEADLOOP_PROJECT_ID: "acceptance",
        DEADLOOP_REPO_PATH: "/example/repository",
        DEADLOOP_GITHUB_REPO: "owner/repository",
        DEADLOOP_CHECK_COMMAND: "npm run check",
        DEADLOOP_WORKER_AGENT: "pi",
      },
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

Given("The selected Issue lacks the required implementation contract", function (this: IssueCoordinationWorld) {
  this.fixtureName = "driver-contract-missing.json";
});

Given("The selected Issue is a planning Issue", function (this: IssueCoordinationWorld) {
  this.fixtureName = "driver-blocked-prd.json";
});

Given("The selected Issue only lists child Issues", function (this: IssueCoordinationWorld) {
  this.fixtureName = "driver-parent-task-list.json";
});

Given("Selected implementable Issue references design document", function (this: IssueCoordinationWorld) {
  this.fixtureName = "driver-prd-doc-reference.json";
});

Given("Selected implementable Issue references parent Issue in acceptance criteria", function (this: IssueCoordinationWorld) {
  this.fixtureName = "driver-acceptance-parent-reference.json";
});

Given("The selected Issue has an implementation contract.", function (this: IssueCoordinationWorld) {
  this.fixtureName = "driver-ready-worker.json";
});

When("deadloop decides the selected Issue's next action", function (this: IssueCoordinationWorld) {
  if (!this.fixtureName) throw new Error("issue precondition is missing");
  this.result = coordinateIssue(this.fixtureName);
});

Then("deadloop blocks the Issue without using the language model", function (this: IssueCoordinationWorld) {
  assert.equal(this.result?.action, "done");
});

Then("Work on the Issue does not start", function (this: IssueCoordinationWorld) {
  assert.equal(this.result?.launch, undefined);
});

Then("deadloop lists the implementation-contract items to add to the Issue", function (this: IssueCoordinationWorld) {
  assert.match(this.result?.comment || "", /`## Agent Brief` or `## What to build`[\s\S]*`## Acceptance criteria`/);
});

Then("deadloop explains how to requeue the corrected Issue", function (this: IssueCoordinationWorld) {
  assert.match(this.result?.comment || "", /Update the issue body, then add `agent:implement` again\./);
});

Then("deadloop explains how to split the plan into implementable Issues", function (this: IssueCoordinationWorld) {
  assert.match(this.result?.comment || "", /Create a separate implementable issue or split this issue's scope\./);
});

Then("deadloop provides recovery steps after blocking the Issue", function (this: IssueCoordinationWorld) {
  assert.match(this.result?.comment || "", /## Recovery steps/);
});

Then("deadloop explains how to add the selection labels to the split Issues", function (this: IssueCoordinationWorld) {
  assert.match(
    this.result?.comment || "",
    /gh issue edit "\$implementable_issue_number"[^\n]*--add-label ready-for-agent[^\n]*--add-label agent:implement/,
  );
});

Then("The blocking comment are created only as a guide for users.", function (this: IssueCoordinationWorld) {
  assert.doesNotMatch(
    this.result?.comment || "",
    /extract-worker-promise|herdr|\/example\/repository|<(?:promiseFile|workspaceId|worktreePath|branch)>/i,
  );
});

Then("Work on the Issue starts", function (this: IssueCoordinationWorld) {
  assert.equal(this.result?.launch?.simulated, true);
});

Then("The work instructions contain only information needed by the implementation agent", function (this: IssueCoordinationWorld) {
  assert.doesNotMatch(this.result?.launch?.instructions || "", /issue coordinator|driver|renderer/i);
});

Then("Completion monitoring starts for the Issue", function (this: IssueCoordinationWorld) {
  assert.equal(this.result?.monitorHandoff?.kind, "issue");
});

Then("Completion monitoring for the Issue does not start", function (this: IssueCoordinationWorld) {
  assert.equal(this.result?.monitorHandoff, undefined);
});

Then("No blocking guidance is created for the Issue", function (this: IssueCoordinationWorld) {
  assert.equal(this.result?.comment, undefined);
});
