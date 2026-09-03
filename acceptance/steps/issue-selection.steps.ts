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

Given("An Issue with all required public labels has an unfinished dependency on GitHub", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-open-relationship-dependency.json";
});

Given("An Issue with all required public labels has an unfinished dependency on another repository", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-open-cross-repository-dependency.json";
});

Given("An eligible Issue whose GitHub dependencies are all closed", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-closed-dependency.json";
});

Given("An eligible Issue whose only GitHub dependency is a closed Issue in another repository", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-closed-cross-repository-dependency.json";
});

Given("An eligible Issue whose body mentions Blocked by without a GitHub dependency", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-body-text-without-dependency.json";
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

Then("The Issue with an unfinished GitHub dependency is not selected for work", function (this: IssueSelectionWorld) {
  assert.equal(this.decision?.selected, false);
});
