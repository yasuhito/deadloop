import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";
import { runPrReviewerDriverFixture } from "../support/pr-reviewer-driver";

const { defaultDecisionConfig, selectPrForReview, workingReviewerPrNumbers } = require("../../extensions/deadloop/automations/pr-reviewer-decisions.ts");

type PullRequest = Record<string, unknown>;
type GithubEffect = {
  operation?: string;
  reviewer?: string;
  body?: string;
  move?: { add?: string | string[]; remove?: string | string[] };
};
type DriverResult = {
  driverAction?: string;
  comment?: string;
  prNumber?: number;
  decision?: { skipped?: Array<{ number?: number; reason?: string }> };
  githubEffects?: GithubEffect[];
  testAdapterEffects?: { herdrStarts?: unknown[]; githubComments?: unknown[]; labelReplacements?: unknown[] };
};
type SelectionWorld = {
  fixtureName?: string;
  agentsFixtureName?: string;
  autoMerge?: boolean;
  externalReviewEnabled?: boolean;
  driverFixtureName?: string;
  decision?: { selected?: boolean; number?: number; reason?: string };
  driverResult?: DriverResult;
  prs?: PullRequest[];
  agents?: Record<string, unknown>;
  attempts?: Record<string, unknown>[];
};

const fixtureDirectory = path.join(process.cwd(), "test/fixtures/pr-reviewer");
const fixedNow = new Date("2026-07-04T00:30:00Z");

function readFixture(name: string): PullRequest[] {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), "utf8")) as PullRequest[];
}

function setFixture(world: SelectionWorld, fixtureName: string): void {
  world.fixtureName = fixtureName;
}

Given("There is a pull request waiting for review.", function (this: SelectionWorld) {
  setFixture(this, "precheck-agent-review.json");
  this.driverFixtureName = "external-review-request.json";
});

Given("There is a pull request ready for human review.", function (this: SelectionWorld) {
  setFixture(this, "precheck-ready-for-human.json");
});

Given("There is a pull request that only has labels that are not subject to review.", function (this: SelectionWorld) {
  setFixture(this, "precheck-non-candidate-label.json");
});

Given("A pull request has CI running", function (this: SelectionWorld) {
  setFixture(this, "precheck-pending-checks.json");
});

Given("There is a pull request whose waiting period for external review has expired.", function (this: SelectionWorld) {
  setFixture(this, "precheck-stale-external-marker.json");
  this.driverFixtureName = "fallback-review.json";
});

Given("There is a pull request waiting for external review", function (this: SelectionWorld) {
  setFixture(this, "precheck-fresh-copilot-request.json");
  this.driverFixtureName = "external-review-wait.json";
});

Given("pull request is being processed by an external reviewer", function (this: SelectionWorld) {
  setFixture(this, "precheck-fresh-copilot-request.json");
});

Given("pull request is being processed by another external reviewer", function (this: SelectionWorld) {
  setFixture(this, "precheck-coderabbit-processing.json");
});

Given("There is a draft pull request", function (this: SelectionWorld) {
  setFixture(this, "precheck-draft.json");
  this.driverFixtureName = "draft-pr.json";
});

Given("There is a pull request under review with no active agents.", function (this: SelectionWorld) {
  setFixture(this, "precheck-reviewing.json");
  this.agentsFixtureName = "agents-empty.json";
});

Given("There is a pull request waiting for re-review after repair", function (this: SelectionWorld) {
  setFixture(this, "precheck-repair-rereview.json");
  this.agentsFixtureName = "agents-empty.json";
});

Given("There is a pull request waiting for review with an abandoned attempt with evidence.", function (this: SelectionWorld) {
  setFixture(this, "precheck-agent-review.json");
  this.attempts = [{ project: "demo", repository: "owner/repo", role: "reviewer", target: { kind: "pull-request", number: 7 }, phase: "abandoned" }];
});

Given("There is a pull request being reviewed by another agent.", function (this: SelectionWorld) {
  setFixture(this, "precheck-reviewing.json");
  this.agents = { result: { agents: [{ name: "dl-r-13-111111111111", agent_status: "working" }] } };
  this.attempts = [{ project: "demo", repository: "owner/repo", role: "reviewer", target: { kind: "pull-request", number: 13 }, phase: "agent_started", agentName: "dl-r-13-111111111111" }];
});

Given("There is a blocked pull request", function (this: SelectionWorld) {
  setFixture(this, "precheck-blocked.json");
});

Given("A blocked pull request has a new Agent request after its author pushed a fix", function (this: SelectionWorld) {
  setFixture(this, "precheck-blocked-request-after-push.json");
});

Given("A blocked pull request has only an Agent request that predates its block", function (this: SelectionWorld) {
  setFixture(this, "precheck-blocked-request-before-block.json");
});

Given("Reviewable and unreviewable pull requests are both available", function (this: SelectionWorld) {
  setFixture(this, "precheck-mixed-candidates.json");
  this.agents = { result: { agents: [{ name: "dl-r-13-111111111111", agent_status: "working" }] } };
  this.attempts = [{ project: "demo", repository: "owner/repo", role: "reviewer", target: { kind: "pull-request", number: 13 }, phase: "agent_started", agentName: "dl-r-13-111111111111" }];
});

Given("automatic merge is enabled", function (this: SelectionWorld) {
  this.autoMerge = true;
});

Given("Automatic merge is disabled", function (this: SelectionWorld) {
  this.autoMerge = false;
});

Given("External review is enabled", function (this: SelectionWorld) {
  this.externalReviewEnabled = true;
});

Given("External review is disabled", function (this: SelectionWorld) {
  this.externalReviewEnabled = false;
});

When("deadloop searches for review target", function (this: SelectionWorld) {
  if (!this.fixtureName) throw new Error("review state is missing");
  const agents = this.agents ?? (this.agentsFixtureName
    ? JSON.parse(fs.readFileSync(path.join(fixtureDirectory, this.agentsFixtureName), "utf8"))
    : { result: { agents: [] } });
  const config = defaultDecisionConfig({
    autoMerge: this.autoMerge ?? false,
    externalReviewEnabled: this.externalReviewEnabled ?? false,
    now: fixedNow,
    projectId: "demo",
    automationLogin: "deadloop-bot",
  });
  this.decision = selectPrForReview(readFixture(this.fixtureName), config, workingReviewerPrNumbers(agents, config.projectId, this.attempts || [], "owner/repo"));
});

When("deadloop decides how to handle external reviews", function (this: SelectionWorld) {
  if (!this.driverFixtureName) throw new Error("review state is missing");
  if (this.externalReviewEnabled === undefined) throw new Error("external review state is missing");
  this.driverResult = runDriver(this.driverFixtureName, { DEADLOOP_EXTERNAL_REVIEW_ENABLED: this.externalReviewEnabled ? "1" : "0" });
});

function runDriver(fixtureName: string, extraEnv: Record<string, string> = {}): DriverResult {
  return runDriverPath(`test/fixtures/pr-reviewer-driver/${fixtureName}`, extraEnv);
}

function runDriverPath(fixturePath: string, extraEnv: Record<string, string> = {}): DriverResult {
  return runPrReviewerDriverFixture(fixturePath, extraEnv);
}

When("deadloop tries to start a review", function (this: SelectionWorld) {
  if (!this.driverFixtureName) throw new Error("review state is missing");
  this.driverResult = runDriver(this.driverFixtureName);
});

When("deadloop selects and processes the review target", function (this: SelectionWorld) {
  if (!this.fixtureName) throw new Error("review state is missing");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-acceptance-"));
  const fixturePath = path.join(tempRoot, "selection-cycle.json");
  try {
    fs.writeFileSync(fixturePath, JSON.stringify({ prs: readFixture(this.fixtureName), agents: { result: { agents: [] } } }));
    this.driverResult = runDriverPath(fixturePath);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

Given("Another agent has started the review after selection.", function (this: SelectionWorld) {
  if (!this.fixtureName) throw new Error("review state is missing");
  const config = defaultDecisionConfig({ now: fixedNow, projectId: "demo", automationLogin: "deadloop-bot" });
  this.prs = readFixture(this.fixtureName);
  const firstDecision = selectPrForReview(this.prs, config);
  const selected = this.prs.find((pr) => pr.number === firstDecision.number);
  if (!selected) throw new Error("selected pull request is missing");
  selected.labels = [...(selected.labels as unknown[]), { name: "agent:reviewing" }];
  const agentName = `dl-r-${firstDecision.number}-111111111111`;
  this.agents = { result: { agents: [{ name: agentName, agent_status: "working" }] } };
  this.attempts = [{ project: "demo", repository: "owner/repo", role: "reviewer", target: { kind: "pull-request", number: firstDecision.number }, phase: "agent_started", agentName }];
});

When("The next selection cycle begins", function (this: SelectionWorld) {
  if (!this.prs || !this.agents) throw new Error("review state is missing");
  const config = defaultDecisionConfig({ now: fixedNow, projectId: "demo", automationLogin: "deadloop-bot" });
  this.decision = selectPrForReview(this.prs, config, workingReviewerPrNumbers(this.agents, config.projectId, this.attempts || [], "owner/repo"));
});

Then("deadloop selects pull request #{int} for review", function (this: SelectionWorld, number: number) {
  assert.equal(this.decision?.number, number);
});

Then("No review target is selected", function (this: SelectionWorld) {
  assert.equal(this.decision?.selected, false);
});

Then("The selection reason is stale review claim recovery", function (this: SelectionWorld) {
  assert.equal(this.decision?.reason, "stale_reclaim");
});

Then("The selection reason is repair re-review", function (this: SelectionWorld) {
  assert.equal(this.decision?.reason, "repair_rereview");
});

Then("deadloop leaves external-review request state untouched before claim", function (this: SelectionWorld) {
  assert.deepEqual({
    action: this.driverResult?.driverAction,
    comments: this.driverResult?.testAdapterEffects?.githubComments?.length ?? 0,
    labels: this.driverResult?.testAdapterEffects?.labelReplacements?.length ?? 0,
    starts: this.driverResult?.testAdapterEffects?.herdrStarts?.length ?? 0,
  }, { action: "external_review_unclaimed", comments: 0, labels: 0, starts: 0 });
});

Then("deadloop does not start the Reviewer", function (this: SelectionWorld) {
  assert.equal(this.driverResult?.testAdapterEffects?.herdrStarts?.length ?? 0, 0);
});

Then("deadloop waits for external review without mutation", function (this: SelectionWorld) {
  assert.deepEqual({
    action: this.driverResult?.driverAction,
    comments: this.driverResult?.testAdapterEffects?.githubComments?.length ?? 0,
    labels: this.driverResult?.testAdapterEffects?.labelReplacements?.length ?? 0,
    starts: this.driverResult?.testAdapterEffects?.herdrStarts?.length ?? 0,
  }, { action: "wait", comments: 0, labels: 0, starts: 0 });
});

Then("deadloop stops skipping pull request #14 as blocked", function (this: SelectionWorld) {
  assert.equal(this.driverResult?.prNumber, 14);
});

Then("deadloop skips pull request #14 as blocked", function (this: SelectionWorld) {
  assert.deepEqual(this.driverResult?.decision?.skipped, [{ number: 14, reason: "blocked" }]);
});

Then("deadloop starts the Reviewer for normal review", function (this: SelectionWorld) {
  assert.equal(this.driverResult?.testAdapterEffects?.herdrStarts?.length, 1);
});

Then("deadloop leaves the draft pull request untouched before claim", function (this: SelectionWorld) {
  assert.deepEqual({
    action: this.driverResult?.driverAction,
    comments: this.driverResult?.testAdapterEffects?.githubComments?.length ?? 0,
    labels: this.driverResult?.testAdapterEffects?.labelReplacements?.length ?? 0,
    starts: this.driverResult?.testAdapterEffects?.herdrStarts?.length ?? 0,
  }, { action: "draft_unclaimed", comments: 0, labels: 0, starts: 0 });
});
