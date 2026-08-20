import assert from "node:assert/strict";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";
import { runPrReviewerDriverFixture, type PrReviewerDriverResult } from "../support/pr-reviewer-driver";

const { selectPrRequest } = require("../../src/pr-request-selection.cts");

const requestLabels = {
  updateBranch: "agent:update-branch",
  implement: "agent:implement",
  review: "agent:review",
};

type RequestWorld = {
  requestLabels?: string[];
  request?: { role?: string; label?: string } | null;
  driverResult?: PrReviewerDriverResult & { comment?: string; testAdapterEffects?: { labels?: Record<string, string[]> } };
};

Given("A pull request carries branch-update, repair, and review requests", function (this: RequestWorld) {
  this.requestLabels = ["agent:review", "agent:implement", "agent:update-branch"];
});

Given("A pull request carries repair and review requests", function (this: RequestWorld) {
  this.requestLabels = ["agent:review", "agent:implement"];
});

Given("A pull request carries only a review request", function (this: RequestWorld) {
  this.requestLabels = ["agent:review"];
});

Given("A pull request carries a branch-update request but no longer conflicts", function (this: RequestWorld) {
  this.driverResult = undefined;
});

When("deadloop chooses the request to consume", function (this: RequestWorld) {
  this.request = selectPrRequest(this.requestLabels || [], requestLabels);
});

When("deadloop processes the pull request request queue", function (this: RequestWorld) {
  this.driverResult = runPrReviewerDriverFixture(
    path.join(process.cwd(), "test/fixtures/pr-reviewer-driver/obsolete-branch-update.json"),
  );
});

Then("deadloop chooses the branch-update request", function (this: RequestWorld) {
  assert.equal(this.request?.role, "branch-update");
});

Then("deadloop chooses the repair request", function (this: RequestWorld) {
  assert.equal(this.request?.role, "review-repair");
});

Then("deadloop chooses the review request", function (this: RequestWorld) {
  assert.equal(this.request?.role, "reviewer");
});

Then("deadloop launches no agent for the obsolete request", function (this: RequestWorld) {
  assert.equal(this.driverResult?.testAdapterEffects?.herdrStarts?.length ?? 0, 0);
});

Then("deadloop explains why the obsolete request was consumed", function (this: RequestWorld) {
  assert.match(String(this.driverResult?.comment || ""), /no longer conflicts/);
});

Then("deadloop requests a review of the current head", function (this: RequestWorld) {
  assert.deepEqual(this.driverResult?.testAdapterEffects?.labels?.["31"], ["agent:review"]);
});
