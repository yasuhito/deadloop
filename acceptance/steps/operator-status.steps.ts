import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

import { fixtureStateDir } from "../support/fixture-state-dir";

import { normalizeProject } from "../../src/core";
import { buildStatusSnapshot, formatStatusReport, type StatusReportInput } from "../../src/status";

const fixture = JSON.parse(readFileSync("test/fixtures/status/report-case.json", "utf8"));
const projects = fixture.projects.map(normalizeProject);

type StoppedTarget = "issue" | "pull-request";

type OperatorStatusWorld = {
  report?: string;
  statusInput?: StatusReportInput;
  stoppedTarget?: StoppedTarget;
  blockedComment?: string;
  commands?: string[];
};

function baseStatusInput(): StatusReportInput {
  return {
    cwd: fixture.cwd,
    nowMs: fixture.nowMs,
    projects,
  };
}

function statusReport(input: StatusReportInput): string {
  return formatStatusReport(buildStatusSnapshot(input));
}

function runDriverFixture(target: StoppedTarget): string {
  const isIssue = target === "issue";
  const script = isIssue
    ? "extensions/deadloop/automations/issue-coordinator-driver.cts"
    : "extensions/deadloop/automations/pr-reviewer-driver.cts";
  const fixturePath = isIssue
    ? "test/fixtures/issue-coordinator/driver-blocked-prd.json"
    : "test/fixtures/pr-reviewer-driver/draft-pr.json";
  const result = spawnSync("node", [script, "--fixture", path.join(fixturePath)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEADLOOP_PROJECT_ID: "demo",
      DEADLOOP_STATE_DIR: fixtureStateDir(),
      DEADLOOP_REPO_PATH: isIssue ? "/repo path" : "/repo",
      DEADLOOP_GITHUB_REPO: "owner/repo",
      DEADLOOP_BLOCKED_LABEL: "agent:blocked",
      DEADLOOP_IMPLEMENT_LABEL: "agent:implement",
      DEADLOOP_CHECK_COMMAND: "npm test",
      DEADLOOP_WORKER_AGENT: "pi",
      DEADLOOP_REVIEWER_AGENT: "pi",
      DEADLOOP_REVIEWER_MODEL: "",
      DEADLOOP_AUTO_MERGE: "0",
      DEADLOOP_AUTHORIZED_AUTOMATION_LOGINS: "deadloop-bot",
      DEADLOOP_NOW: "2026-07-08T00:00:00Z",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout).comment;
}

Given("There is no Issue waiting for implementation.", function (this: OperatorStatusWorld) {
  this.statusInput = { ...baseStatusInput(), issues: [] };
});

Given("An Issue has the `agent:implement` request without `ready-for-agent`", function (this: OperatorStatusWorld) {
  this.statusInput = {
    ...baseStatusInput(),
    issues: [{ number: 14, title: "Requested without triage metadata", labels: [{ name: "agent:implement" }] }],
  };
});

Given("An Issue has the `agent:implement` request and `ready-for-human`", function (this: OperatorStatusWorld) {
  this.statusInput = {
    ...baseStatusInput(),
    issues: [{ number: 15, title: "Waiting for a person", labels: [{ name: "agent:implement" }, { name: "ready-for-human" }] }],
  };
});

Given("Issue #13 is being implemented", function (this: OperatorStatusWorld) {
  this.statusInput = { ...baseStatusInput(), issues: fixture.issues };
});

Given("pull request #21 is waiting for review", function (this: OperatorStatusWorld) {
  this.statusInput = { ...baseStatusInput(), openPrs: fixture.openPrs };
});

Given("Worktree remains for merged pull request #20", function (this: OperatorStatusWorld) {
  this.statusInput = {
    ...baseStatusInput(),
    closedPrs: fixture.closedPrs,
    worktrees: [fixture.worktrees[0]],
    gitStatuses: fixture.gitStatuses,
    gitHeads: fixture.gitHeads,
  };
});

Given("Worktree of Issue #13 in progress is up and running", function (this: OperatorStatusWorld) {
  this.statusInput = { ...baseStatusInput(), worktrees: [fixture.worktrees[1]] };
});

Given("The loaded deadloop code differs from the deployed code", function (this: OperatorStatusWorld) {
  this.statusInput = {
    ...baseStatusInput(),
    codeIdentity: {
      loadedIdentity: "a".repeat(40),
      deployedIdentity: "b".repeat(40),
      action: "stop",
      reason: "the loaded deadloop code identity differs from the deployed code identity",
      recovery: "Run /reload in this session to load the deployed deadloop code.",
    },
  };
});

Given("Automation selected Issue #12 in most recent run", function (this: OperatorStatusWorld) {
  this.statusInput = { ...baseStatusInput(), state: fixture.state };
});

Given(
  "The location of the local configuration is unknown, and the repository configuration is read from deadloop.json in origin\\/main.",
  function (this: OperatorStatusWorld) {
    this.statusInput = baseStatusInput();
  },
);

When("The operator requests deadloop status", function (this: OperatorStatusWorld) {
  if (!this.statusInput) throw new Error("status input is required");
  this.report = statusReport(this.statusInput);
});

Then("Status reports that no Issue is waiting for implementation", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /- eligible: none/);
});

Then("Status shows the Issue as waiting for implementation", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /- eligible: #14 Requested without triage metadata/);
});

Then("Status shows the Issue as waiting for a person", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /- waiting for a person: #15 Waiting for a person/);
});

Then("Status shows the target Issue", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /- in-progress: #13 Add deadloop status report/);
});

Then("Status shows the pull request awaiting review", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /- review target: #21 Add status report/);
});

Then("Status shows cleanup-candidate worktrees", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /#20 agent\/issue-12-old -> .*\(workspace-20; merged_pr\)/);
});

Then("Status displays active worktrees", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /agent\/issue-13-add-deadloop-status-report -> .*\(workspace-13\)/);
});

Then("Status shows both code identities and the reload recovery", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /loaded code identity: a{40}[\s\S]*deployed code identity: b{40}[\s\S]*\/reload/);
});

Then("Status shows the most recent automation decision", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /summary=driver selected Issue #12/);
});

Then("Status shows the configuration source", function (this: OperatorStatusWorld) {
  assert.match(this.report || "", /config: local=unknown local projects\.json; repoPolicy=origin\/main:deadloop\.json \(not-read\)/);
});

Given(
  "Issue #11, representing a PRD, design, or parent task, is awaiting implementation.",
  function (this: OperatorStatusWorld) {
    this.stoppedTarget = "issue";
  },
);

When("deadloop creates the blocking comment", function (this: OperatorStatusWorld) {
  if (!this.stoppedTarget) throw new Error("stopped target is required");
  this.blockedComment = runDriverFixture(this.stoppedTarget);
});

Then("The blocking comment shows the reason", function (this: OperatorStatusWorld) {
  assert.match(this.blockedComment || "", /Skipped automated implementation because this looks like a PRD, design, or parent issue/);
});

Then("The blocking comment shows recovery steps", function (this: OperatorStatusWorld) {
  assert.match(this.blockedComment || "", /## Recovery steps/);
});

Then("The blocking comment shows a safe requeue method", function (this: OperatorStatusWorld) {
  assert.match(
    this.blockedComment || "",
    /implementable_issue_number=123\ngh issue edit "\$implementable_issue_number" -R owner\/repo --remove-label agent:blocked --add-label ready-for-agent --add-label agent:implement/,
  );
});

Given("pull request #23 is a draft and waiting for review.", function (this: OperatorStatusWorld) {
  this.stoppedTarget = "pull-request";
});

Then("The pull request blocking comment shows the reason", function (this: OperatorStatusWorld) {
  assert.match(this.blockedComment || "", /Skipped automated review and auto-merge because the PR is a draft/);
});

Then("The blocking comment shows recovery steps of pull request", function (this: OperatorStatusWorld) {
  assert.match(this.blockedComment || "", /## Recovery steps/);
});

Then("No draft blocking comment is posted before claim", function (this: OperatorStatusWorld) {
  assert.equal(this.blockedComment || "", "");
});

Given("The deadloop extension can start", function (this: OperatorStatusWorld) {
  this.commands = [];
});

When("The deadloop extension registers public commands", function (this: OperatorStatusWorld) {
  const extension = require("../../extensions/deadloop/index.ts").default;
  extension({
    registerCommand: (name: string) => this.commands?.push(name),
    on: () => {},
  });
});

Then("`\\/deadloop-status` is available", function (this: OperatorStatusWorld) {
  assert.ok(this.commands?.includes("deadloop-status"));
});
