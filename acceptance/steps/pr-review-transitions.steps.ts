import assert from "node:assert/strict";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";
import { type PrReviewerDriverResult, runPrReviewerDriverFixture } from "../support/pr-reviewer-driver";

const { mergeReviewedPr } = require("../../extensions/deadloop/automations/merge-reviewed-pr.cts");

const currentHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const previousHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type TransitionWorld = {
  fixtureName?: string;
  externalReviewEnabled?: boolean;
  result?: PrReviewerDriverResult;
  staleApproval?: boolean;
  completionCommands?: string[][];
};

Given("No pull request is currently reviewable", function (this: TransitionWorld) {
  this.fixtureName = "no-candidate.json";
});

Given("The pull request CI is running", function (this: TransitionWorld) {
  this.fixtureName = "pending-ci.json";
});

Given("A pull request is waiting for review after CI completes", function (this: TransitionWorld) {
  this.fixtureName = "external-review-request.json";
});

Given("External review was requested only for a previous pull request head", function (this: TransitionWorld) {
  this.fixtureName = "previous-head-external-review.json";
});

Given("External review is configured as disabled", function (this: TransitionWorld) {
  this.externalReviewEnabled = false;
});

Given("External review is configured as enabled", function (this: TransitionWorld) {
  this.externalReviewEnabled = true;
});

Given("An approval result exists for a previous pull request head", function (this: TransitionWorld) {
  this.staleApproval = true;
});

When("deadloop decides the pull request's next action", function (this: TransitionWorld) {
  if (!this.fixtureName) throw new Error("pull request state is missing");
  this.result = runPrReviewerDriverFixture(
    path.join("test/fixtures/pr-reviewer-driver", this.fixtureName),
    { DEADLOOP_EXTERNAL_REVIEW_ENABLED: this.externalReviewEnabled ? "1" : "0" },
  );
});

Then("Review processing does not start", function (this: TransitionWorld) {
  assert.equal(this.result?.testAdapterEffects?.herdrStarts?.length ?? 0, 0);
});

Then("deadloop waits for CI to complete", function (this: TransitionWorld) {
  assert.equal(this.result?.driverAction, "wait");
});

Then("deadloop starts normal review", function (this: TransitionWorld) {
  assert.equal(this.result?.testAdapterEffects?.herdrStarts?.length, 1);
});

Then("deadloop leaves the external review request untouched before consumption", function (this: TransitionWorld) {
  const effects = this.result?.testAdapterEffects as { githubComments?: unknown[]; labelMutations?: unknown[]; herdrStarts?: unknown[] } | undefined;
  assert.deepEqual({
    action: this.result?.driverAction,
    comments: effects?.githubComments?.length ?? 0,
    labels: effects?.labelMutations?.length ?? 0,
    starts: effects?.herdrStarts?.length ?? 0,
  }, { action: "external_review_unclaimed", comments: 0, labels: 0, starts: 0 });
});

When("deadloop completes approval processing for the current pull request", function (this: TransitionWorld) {
  if (!this.staleApproval) throw new Error("approval result is missing");
  const commands: string[][] = [];
  try {
    mergeReviewedPr(
      {
        attemptRecord: "/state/runs/reviewer/attempt.json",
        projectRepo: "/repo",
        githubRepo: "owner/repo",
        stateDir: "/state",
        enabledAt: 1,
        pr: "25",
        expectedHead: currentHead,
        reviewPromise: "/state/reviewer-promise.json",
        inProgressLabel: "agent:in-progress",
        blockedLabel: "agent:blocked",
      },
      {
        loadAttemptRecord: () => ({
          role: "reviewer", repository: "owner/repo", target: { kind: "pull-request", number: 25 },
          inputRevision: { head: currentHead },
        }),
        withLock: (_project: unknown, operation: (enabled: unknown) => number) => operation({
          firstEnableAutoMerge: false,
          firstStartPending: false,
          autoMergeAcknowledged: false,
        }),
        isAutoMergeEnabled: () => true,
        validateReviewPromise: () => ({
          status: "complete",
          promise: {
            status: "complete",
            outcome: "approved",
            reviewedHead: previousHead,
            reason: "",
            summary: "approved",
            findings: [],
          },
        }),
        assertReviewVerification: () => {},
        run: (args: string[]) => {
          commands.push(args);
          if (args[0] === "gh" && args[1] === "pr" && args[2] === "view") {
            return {
              status: 0,
              stdout: JSON.stringify({
                state: "OPEN",
                isDraft: false,
                headRefOid: currentHead,
                mergeable: "MERGEABLE",
                mergeStateStatus: "CLEAN",
                statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
                labels: [{ name: "agent:review" }, { name: "agent:in-progress" }],
              }),
              stderr: "",
            };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "reviewed head does not match the guarded merge head; automatic merge stopped") {
      throw error;
    }
  }
  this.completionCommands = commands;
});

Then("The current pull request is not merged", function (this: TransitionWorld) {
  assert.equal(
    this.completionCommands?.some((args) => args[0] === "gh" && args[1] === "pr" && args[2] === "merge"),
    false,
  );
});
