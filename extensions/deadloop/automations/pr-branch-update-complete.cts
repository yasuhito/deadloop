#!/usr/bin/env node
// Turn one successful branch update into the next GitHub Agent request. The updater consumed the
// `agent:update-branch` request when it claimed the pull request, so the updated head becomes
// reachable again only after this handler replaces the active workflow state with a new review request.
// This handler never pushes, comments, or launches work.

const path = require("node:path") as typeof import("node:path");
const { provenPushedHeadTransition } = require("./pushed-head-proof.cts");
const { createCommandRunner, driverResult } = require("../../../src/automation-driver-kit.cts");
const { createGithubOperations } = require("../../../src/github-operations.cts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { runHerdrPreflight } = require("../../../src/herdr-preflight.cjs");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { assertAttemptProjectBinding, canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");
const { labelNames } = require("../../../src/launch-revalidation.cts");

import type { DriverResult, JsonObject } from "../../../src/automation-driver-kit-types";

const REQUIRED_ARGUMENTS = [
  "promise", "attemptRecord", "projectId", "projectRepo", "githubRepo", "stateDir", "enabledAt",
  "pr", "expectedHead", "reviewLabel", "implementLabel", "updateBranchLabel", "inProgressLabel", "blockedLabel",
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

type CompletionObservation = {
  pr: JsonObject;
  labels: string[];
  revision: string;
  authenticatedLogin: string;
  enabledLogin: string;
  reviewLabel: string;
  implementLabel: string;
  updateBranchLabel: string;
  inProgressLabel: string;
  blockedLabel: string;
  mode: "pending" | "already-applied";
  branch: string;
};

type RepositoryIdentity = {
  id?: unknown;
  nameWithOwner?: unknown;
};

type EnabledRepositoryIdentity = {
  githubRepositoryId?: unknown;
  githubRepo?: unknown;
};

function assertBranchUpdateAttemptBinding(record: JsonObject, args: JsonObject): void {
  if (record.project !== String(args.projectId)
    || record.repository !== String(args.githubRepo)
    || record.role !== "branch-update"
    || record.target?.kind !== "pull-request"
    || Number(record.target?.number) !== Number(args.pr)
    || String(record.inputRevision?.head || "").toLowerCase() !== String(args.expectedHead).toLowerCase()) {
    throw new Error("branch-update attempt does not match the completion target");
  }
}

function assertBranchUpdateRepositoryIdentity(
  identity: RepositoryIdentity,
  enabled: EnabledRepositoryIdentity,
): void {
  if (String(identity.id || "") !== String(enabled.githubRepositoryId || "")
    || String(identity.nameWithOwner || "") !== String(enabled.githubRepo || "")) {
    throw new Error("live repository identity changed before branch-update completion");
  }
}

function assertBranchUpdateCompletionObservation(input: CompletionObservation): void {
  if (!input.authenticatedLogin || input.authenticatedLogin !== input.enabledLogin) {
    throw new Error("authenticated identity lost branch-update completion authority");
  }
  if (String(input.pr.state || "").toUpperCase() !== "OPEN"
    || String(input.pr.headRefName || "") !== input.branch
    || String(input.pr.headRefOid || "").toLowerCase() !== input.revision.toLowerCase()) {
    throw new Error("branch-update completion target changed before the review request");
  }
  const labels = new Set(input.labels);
  const exactManagedState = input.mode === "already-applied"
    ? labels.has(input.reviewLabel) && !labels.has(input.inProgressLabel)
    : labels.has(input.inProgressLabel) && !labels.has(input.reviewLabel);
  if (!exactManagedState
    || labels.has(input.implementLabel)
    || labels.has(input.updateBranchLabel)
    || labels.has(input.blockedLabel)) {
    throw new Error("branch-update completion managed state is incompatible with the proven update");
  }
}

type PrObservation = {
  pr: JsonObject;
  labels: string[];
};

function branchUpdatePrObservation(pr: JsonObject): PrObservation {
  return { pr, labels: labelNames(pr.labels) };
}

function waitForPushedHeadVisibility(input: {
  observe: () => PrObservation;
  pause: () => void;
  branch: string;
  originalHead: string;
  pushedHead: string;
  attempts?: number;
}): PrObservation {
  const originalHead = input.originalHead.toLowerCase();
  const pushedHead = input.pushedHead.toLowerCase();
  const attempts = input.attempts ?? 10;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = input.observe();
    const state = String(current.pr.state || "").toUpperCase();
    const branch = String(current.pr.headRefName || "");
    const head = String(current.pr.headRefOid || "").toLowerCase();
    if (state !== "OPEN" || branch !== input.branch) {
      throw new Error("branch-update completion target changed before the pushed head became visible");
    }
    if (head === pushedHead) return current;
    if (head !== originalHead) {
      throw new Error("branch-update completion target changed before the pushed head became visible");
    }
    if (attempt + 1 < attempts) input.pause();
  }
  throw new Error("branch-update pushed head is not yet visible on the pull request");
}

function completion(args: JsonObject): DriverResult {
  const runner = createCommandRunner();
  runHerdrPreflight({ run: (command: string, commandArgs: string[]) => runner.runText([command, ...commandArgs]) });
  const location = canonicalAttemptLocation(args);
  const record = readAttemptRecord(location.runDir);
  assertAttemptProjectBinding(record, args);
  assertBranchUpdateAttemptBinding(record, args);
  if (path.resolve(String(args.promise)) !== path.resolve(String(record.promiseFile))) {
    throw new Error("promise does not match the attempt journal's completion report path");
  }
  const transition = provenPushedHeadTransition(location.runDir, record);
  if (!transition) throw new Error("the branch-update evidence does not prove a pushed head");
  if (transition.originalHeadOid !== String(args.expectedHead).toLowerCase()) {
    throw new Error("the proven branch-update push did not start from the expected head");
  }
  const revision = transition.headOid;

  return withEnabledDriverLock({
    repoPath: String(args.projectRepo),
    githubRepo: String(args.githubRepo),
    stateDir: String(args.stateDir),
    enabledAt: Number(args.enabledAt),
  }, (enabled: JsonObject, recheck: () => void) => {
    const enabledLogin = String(enabled.automationLogin || "").trim().toLowerCase();
    if (String(enabled.githubRepo || "") !== String(args.githubRepo)
      || !String(enabled.githubRepositoryId || "")) throw new Error("enablement repository identity changed before branch-update completion");
    const observation = createGithubOperations(runner);
    const observe = (): PrObservation => {
      const current = observation.getPr(String(args.githubRepo), String(args.pr));
      return branchUpdatePrObservation(current);
    };
    const observePushedHead = (): PrObservation => waitForPushedHeadVisibility({
      observe,
      pause: () => { runner.runText(["sleep", "1"]); },
      branch: String(record.branch),
      originalHead: transition.originalHeadOid,
      pushedHead: revision,
    });
    assertBranchUpdateRepositoryIdentity(observation.getRepositoryIdentity(String(args.githubRepo)), enabled);
    const authenticatedLogin = (): string => runner.runText([
      "gh", "api", "user", "--jq", ".login",
    ]).trim().toLowerCase();
    const assertCurrent = (mode: CompletionObservation["mode"]): void => {
      const login = authenticatedLogin();
      const current = observePushedHead();
      assertBranchUpdateRepositoryIdentity(observation.getRepositoryIdentity(String(args.githubRepo)), enabled);
      assertBranchUpdateCompletionObservation({
        ...current,
        revision,
        branch: String(record.branch),
        authenticatedLogin: login,
        enabledLogin,
        reviewLabel: String(args.reviewLabel),
        implementLabel: String(args.implementLabel),
        updateBranchLabel: String(args.updateBranchLabel),
        inProgressLabel: String(args.inProgressLabel),
        blockedLabel: String(args.blockedLabel),
        mode,
      });
    };
    const before = observePushedHead();
    // The review request may already exist when a retry re-enters after the label move landed, but
    // it is idempotent only for this exact proven head, identity, and managed state.
    if (before.labels.includes(String(args.reviewLabel)) && !before.labels.includes(String(args.inProgressLabel))) {
      recheck();
      assertCurrent("already-applied");
      return driverResult("done", `PR #${args.pr} already carries its post-update review request`, {
        driverAction: "branch_update_review_already_requested",
      });
    }
    const reauthorize = (): void => {
      recheck();
      assertCurrent("pending");
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

module.exports = {
  branchUpdatePrObservation,
  assertBranchUpdateAttemptBinding,
  assertBranchUpdateCompletionObservation,
  assertBranchUpdateRepositoryIdentity,
  completion,
  waitForPushedHeadVisibility,
  parseArgs,
};
