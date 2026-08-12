#!/usr/bin/env node
// Turn one successful branch update into the next GitHub Agent request. The updater consumed the
// `agent:update-branch` request when it claimed the pull request, so the updated head is only
// reachable again once this handler replaces the active claim state with a new review request.
// This handler never pushes, comments, or launches work.

const { validatePromise } = require("./extract-worker-promise.ts");
const { createCommandRunner, driverResult } = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { runHerdrPreflight } = require("../../../src/herdr-preflight.cjs");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { assertAttemptProjectBinding, canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");
const {
  classifyPushedHeadAuthorityTransition,
  readGithubRestResponseHeaders,
  savedReviewClaimContract,
} = require("./pr-review-claim.ts");
const { assertCurrentReviewClaimAuthority } = require("./current-review-claim-authority.ts");

import type { DriverResult, JsonObject } from "../../../src/automation-driver-kit";

const REQUIRED_ARGUMENTS = [
  "promise", "attemptRecord", "projectId", "projectRepo", "githubRepo", "stateDir", "enabledAt",
  "pr", "expectedHead", "reviewLabel", "inProgressLabel", "blockedLabel", "reviewClaim",
];

function parseArgs(argv: string[]): JsonObject {
  const values: JsonObject = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const name of REQUIRED_ARGUMENTS) {
    if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return values;
}

/** The commit the updater proved it pushed, or "" when the report cannot authorize a transition. */
function pushedRevision(promiseFile: string): string {
  const validation = validatePromise(promiseFile);
  const promise = validation.promise as JsonObject | undefined;
  if (validation.status !== "complete" || !promise || promise.status !== "complete") return "";
  if (promise.result?.outcome !== "branch_update_pushed") return "";
  const revision = String(promise.result?.outputRevision || "").toLowerCase();
  return /^[0-9a-f]{40}$/.test(revision) ? revision : "";
}

function labelsOf(pr: JsonObject): string[] {
  return (pr.labels || []).map((label: JsonObject | string) => typeof label === "string" ? label : String(label.name || ""));
}

function completion(args: JsonObject): DriverResult {
  let suppliedReviewClaim: JsonObject;
  try {
    suppliedReviewClaim = typeof args.reviewClaim === "string" ? JSON.parse(args.reviewClaim) : args.reviewClaim;
  } catch {
    throw new Error("active branch-update claim must be valid JSON before completion");
  }
  const runner = createCommandRunner();
  runHerdrPreflight({ run: (command: string, commandArgs: string[]) => runner.runText([command, ...commandArgs]) });
  const location = canonicalAttemptLocation(args);
  const record = readAttemptRecord(location.runDir);
  assertAttemptProjectBinding(record, args);
  if (record.role !== "branch-update") throw new Error("branch-update completion requires a branch-update attempt");
  const reviewClaim = savedReviewClaimContract(location.attemptRecord, suppliedReviewClaim, {
    stateDir: String(args.stateDir),
    githubRepo: String(args.githubRepo),
    projectId: String(args.projectId),
    targetNumber: Number(args.pr),
  });
  for (const field of ["inProgressLabel", "blockedLabel"] as const) {
    if (String(reviewClaim[field] || "") !== String(args[field] || "")) {
      throw new Error(`${field} does not exactly match the saved branch-update claim contract`);
    }
  }
  if (!(reviewClaim.binding?.activeState?.managedLabels || []).includes(String(args.reviewLabel || ""))) {
    throw new Error("reviewLabel is not managed by the saved branch-update claim contract");
  }
  const revision = pushedRevision(String(args.promise));
  if (!revision) throw new Error("the branch-update report does not prove a pushed head");
  if (revision === String(args.expectedHead).toLowerCase()) {
    throw new Error("the branch-update report claims a push that did not change the head");
  }

  return withEnabledDriverLock({
    repoPath: String(args.projectRepo),
    githubRepo: String(args.githubRepo),
    stateDir: String(args.stateDir),
    enabledAt: Number(args.enabledAt),
  }, (enabled: JsonObject, recheck: () => void) => {
    const enabledLogin = String(enabled.automationLogin || "").trim().toLowerCase();
    const observation = createGithubOperations(runner);
    const observe = (): JsonObject => {
      const current = observation.getPr(String(args.githubRepo), String(args.pr));
      return {
        pr: current,
        events: observation.listPrTimelineEvents(String(args.githubRepo), String(args.pr)),
        comments: observation.listPrComments(String(args.githubRepo), String(args.pr)),
        labels: labelsOf(current),
      };
    };
    const before = observe();
    // The review request may already exist when a retry re-enters after the label move landed.
    if (before.labels.includes(String(args.reviewLabel)) && !before.labels.includes(String(args.inProgressLabel))) {
      return driverResult("done", `PR #${args.pr} already carries its post-update review request`, {
        driverAction: "branch_update_review_already_requested",
      });
    }
    const reauthorize = (): void => {
      recheck();
      const login = runner.runText(["gh", "api", "user", "--jq", ".login"]).trim().toLowerCase();
      if (!login || login !== enabledLogin) throw new Error("authenticated identity lost branch-update completion authority");
      assertCurrentReviewClaimAuthority(reviewClaim, String(args.stateDir), enabled, login);
      const current = observe();
      const authority = classifyPushedHeadAuthorityTransition(
        current.pr, current.events, current.comments,
        readGithubRestResponseHeaders(runner, String(args.githubRepo)),
        reviewClaim,
        { repositoryId: String(enabled.githubRepositoryId), repository: String(args.githubRepo), targetNumber: Number(args.pr) },
        { originalHeadOid: String(args.expectedHead), headOid: revision },
      );
      if (authority.kind !== "authorized") {
        throw new Error("active branch-update claim could not be reauthorized before the review request");
      }
    };
    reauthorize();
    const github = createGithubOperations(runner, () => { recheck(); reauthorize(); });
    github.movePrLabels(String(args.githubRepo), String(args.pr), {
      remove: String(args.inProgressLabel), add: String(args.reviewLabel),
    });
    return driverResult("done", `PR #${args.pr} branch update pushed ${revision}; requested a new review`, {
      driverAction: "branch_update_review_requested", outputRevision: revision,
    });
  });
}

function main(): void {
  try {
    process.stdout.write(`${JSON.stringify(completion(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "exception" }))}\n`,
    );
  }
}

if (require.main === module) main();

module.exports = { completion, labelsOf, parseArgs, pushedRevision };
