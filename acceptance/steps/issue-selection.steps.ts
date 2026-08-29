import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import path from "node:path";

const { defaultIssueDecisionConfig, fixtureDecision } = require("../../extensions/deadloop/automations/issue-coordinator-decisions.cts");

type IssueSelectionDecision = {
  selected: boolean;
  number?: number;
};

type IssueSelectionWorld = {
  fixtureName?: string;
  decision?: IssueSelectionDecision;
};

function selectIssue(fixtureName: string): IssueSelectionDecision {
  return fixtureDecision(path.join("test/fixtures/issue-coordinator", fixtureName), defaultIssueDecisionConfig());
}

Given("An eligible Issue has the `agent:implement` request without `ready-for-agent`", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-ready-implement.json";
});

Given("An Issue lacks the required implementation request", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-missing-required-label.json";
});

Given("An Issue in progress has the `agent:in-progress` label", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-in-progress.json";
});

Given("A blocked Issue has the `agent:blocked` label", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-blocked.json";
});

Given("An Issue with all required public labels has an unfinished dependency in the {string}", function (this: IssueSelectionWorld, location: string) {
  const fixtures: Record<string, string> = {
    "dependency section": "selection-open-body-dependency.json",
    "end": "selection-open-final-section-dependency.json",
  };
  const fixtureName = fixtures[location];
  if (!fixtureName) throw new Error(`unknown dependency location: ${location}`);
  this.fixtureName = fixtureName;
});

Given("An eligible Issue has a completed dependency in its body", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-closed-body-dependency.json";
});

Given("An eligible Issue depends on an Issue in another repository", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-cross-repository-dependency.json";
});

Given("An eligible Issue depends on an Issue number that does not exist", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-missing-dependency-issue.json";
});

Given("An Issue with all required public labels has an unfinished dependency on GitHub", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-open-relationship-dependency.json";
});

When("deadloop selects a work target", function (this: IssueSelectionWorld) {
  if (!this.fixtureName) throw new Error("issue precondition is missing");
  this.decision = selectIssue(this.fixtureName);
});

Then("Issue #{int} is selected for work", function (this: IssueSelectionWorld, issueNumber: number) {
  assert.equal(this.decision?.number, issueNumber);
});

Then("The unprepared Issue is not selected for work", function (this: IssueSelectionWorld) {
  assert.equal(this.decision?.selected, false);
});

Then("The Issue in progress is not selected for work", function (this: IssueSelectionWorld) {
  assert.equal(this.decision?.selected, false);
});

Then("The blocked Issue is not selected for work", function (this: IssueSelectionWorld) {
  assert.equal(this.decision?.selected, false);
});

Then("The Issue with an unfinished dependency is not selected for work", function (this: IssueSelectionWorld) {
  assert.equal(this.decision?.selected, false);
});

Then("The Issue with an unfinished GitHub dependency is not selected for work", function (this: IssueSelectionWorld) {
  assert.equal(this.decision?.selected, false);
});

Then("The Issue with an unresolvable dependency reference is not selected for work", function (this: IssueSelectionWorld) {
  assert.equal(this.decision?.selected, false);
});
