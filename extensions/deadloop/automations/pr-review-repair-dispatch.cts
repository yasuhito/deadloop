#!/usr/bin/env node
// Turn a completed reviewer promise into an approved handoff, bounded retry,
// human block, or one agent:implement repair request (ADR 0032). This
// dispatcher never launches the repair worker; the PR driver does.

const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");
const { validatePromise } = require("./extract-worker-promise.cts");
const {
  decideTechnicalReviewFailure,
  renderTechnicalFailureMarker,
  reviewOutcomeFingerprint,
  selectRepairAttempt,
} = require("./pr-review-repair-state.cts");
const { publicText,
  renderApprovedReviewComment,
  renderChangesRequestedComment,
  renderHumanRequiredComment,
  reviewCommentExists,
} = require("./pr-review-comments.cts");
const { resolveReviewResultCheckpoint } = require("./pr-review-result-checkpoint.cts");
const { blockedPrLabelMove } = require("../../../src/pr-request-selection.cts");
const { decideReviewTransition } = require("../../../src/reviewer-outcome-contract.cts");
const { agentWorkflowLabels, humanHandoffLabelMove } = require("../../../src/human-handoff.cts");
const {
  isPrRequiredVerificationStopComment,
  planPrRequiredVerificationStop,
  requiredVerificationStopDiagnosis,
} = require("../../../src/issue-required-verification-stop.cts");
const {
  createCommandRunner,
  driverResult,
  shellQuote,
} = require("../../../src/automation-driver-kit.cts");
const { createGithubOperations } = require("../../../src/github-operations.cts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { runHerdrPreflight } = require("../../../src/herdr-preflight.cjs");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { parseAttemptPersistenceMarkers, renderAttemptPersistenceMarker } = require("../../../src/attempt-persistence-marker.cjs");
const { StaleLaunchError, assertSameLaunchTarget, isStaleLaunchError, labelNames } = require("../../../src/launch-revalidation.cts");
const {
  isRequiredVerificationPolicyBlock,
  reauthorizeReviewWrite,
} = require("../../../src/worker-required-verification-runtime.cjs");
const { assertLocallyEnabled } = require("../../../src/enabled-operation.cjs");
const {
  advancePrHistoryAfterDeterministicComment,
  comparePrHistoryObservations,
  observePrHistory,
  readPrHistoryObservation,
  writePrHistoryObservation,
} = require("../../../src/pr-review-history.cts");

import type { DriverResult, JsonObject } from "../../../src/automation-driver-kit-types";

type PrHistoryObservation = ReturnType<typeof readPrHistoryObservation>;

const commandRunner = createCommandRunner();

function configValue(args: JsonObject, name: string, environmentValue: string | undefined, fallback: string): string {
  const argumentValue = args[name];
  return typeof argumentValue === "string" ? argumentValue : environmentValue || fallback;
}

function envConfig(args: JsonObject = {}) {
  return {
    projectId: configValue(args, "projectId", process.env.DEADLOOP_PROJECT_ID, "project"),
    repoPath: configValue(args, "repoPath", process.env.DEADLOOP_REPO_PATH, "."),
    githubRepo: configValue(args, "githubRepo", process.env.DEADLOOP_GITHUB_REPO, ""),
    requiredVerification: args.requiredVerification
      ? typeof args.requiredVerification === "string" ? JSON.parse(args.requiredVerification) : args.requiredVerification
      : process.env.DEADLOOP_REQUIRED_VERIFICATION ? JSON.parse(process.env.DEADLOOP_REQUIRED_VERIFICATION) : undefined,
    enabledAt: Number(configValue(args, "enabledAt", process.env.DEADLOOP_ENABLED_AT, "")),
    stateDir: configValue(
      args,
      "stateDir",
      process.env.DEADLOOP_STATE_DIR,
      path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "deadloop"),
    ),
    reviewLabel: configValue(args, "reviewLabel", process.env.DEADLOOP_REVIEW_LABEL, "agent:review"),
    blockedLabel: configValue(args, "blockedLabel", process.env.DEADLOOP_BLOCKED_LABEL, "agent:blocked"),
    implementLabel: configValue(args, "implementLabel", process.env.DEADLOOP_IMPLEMENT_LABEL, "agent:implement"),
    updateBranchLabel: configValue(args, "updateBranchLabel", process.env.DEADLOOP_UPDATE_BRANCH_LABEL, "agent:update-branch"),
    inProgressLabel: configValue(args, "inProgressLabel", process.env.DEADLOOP_IN_PROGRESS_LABEL, "agent:in-progress"),
    humanLabel: configValue(args, "humanLabel", process.env.DEADLOOP_HUMAN_LABEL, "ready-for-human"),
    // Every guarded write of this dispatch re-reads the bound reviewer attempt from here, so the
    // attempt's fixed required-verification contract can be re-authenticated against the current
    // trusted policy immediately before the write.
    attemptRecordFile: configValue(args, "attemptRecord", undefined, ""),
  };
}

function parseArgs(argv: string[]): JsonObject {
  const values: JsonObject = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const name of ["promise", "pr", "expectedHead", "branch", "requestEventId"]) {
    if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return values;
}

function readLivePr(repo: string, prNumber: string, runner = commandRunner): JsonObject {
  const pr = runner.runJson([
    "gh",
    "pr",
    "view",
    prNumber,
    "-R",
    repo,
    "--json",
    "number,state,isDraft,headRefName,headRefOid,isCrossRepository,labels,comments",
  ]);
  if (!Array.isArray(pr.comments) || pr.comments.length < 100) return pr;
  const pages = runner.runJson([
    "gh",
    "api",
    "--paginate",
    "--slurp",
    `repos/${repo}/issues/${prNumber}/comments`,
  ]);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`PR #${prNumber} comments pagination returned an invalid response`);
  }
  return {
    ...pr,
    comments: pages.flat().map((comment) => ({ ...comment, author: comment.author || comment.user })),
  };
}

function recoveryComment(prNumber: string, env: ReturnType<typeof envConfig>, reason: string, summary: string, marker = ""): string {
  return `## What happened
- Automatic review repair for PR #${prNumber} requires human intervention: ${publicText(reason, "the bounded automatic path could not safely continue")}.
- ${publicText(summary, "The bounded automatic path could not safely continue.")}

## Recovery steps
1. Inspect the current head, review findings, checks, and deadloop attempt markers.
   \`\`\`bash
gh pr view ${prNumber} -R ${shellQuote(env.githubRepo)} --comments --json number,state,headRefName,headRefOid,labels,statusCheckRollup
   \`\`\`
2. Correct the branch or resolve the required decision without rewriting history.
3. Push a new commit, then add ${env.reviewLabel}; the changed head starts a new review cycle and ${env.blockedLabel} clears with it.${marker ? `\n\n${marker}` : ""}`;
}

/**
 * One operator-readable grounding of the live PR state at a stale repair request: the PR state,
 * whether the head still matches the reviewed one, and the labels the dispatcher observed. The
 * silent early return of the repair-request transition must stay diagnosable from the result (#404).
 */
function claimGrounding(livePr: JsonObject, expectedHead: string): string {
  return [
    `state=${String(livePr.state || "unknown").toUpperCase()}`,
    `head=${String(livePr.headRefOid || "").toLowerCase() === expectedHead.toLowerCase() ? "unchanged" : "changed"}`,
    `labels=${labelNames(livePr.labels).join(",") || "none"}`,
  ].join(" ");
}

function requireManagedPr(pr: JsonObject, env: ReturnType<typeof envConfig>): void {
  const labels = labelNames(pr.labels);
  if (!labels.includes(env.inProgressLabel) || labels.includes(env.blockedLabel)) {
    throw new Error("active in-progress state is required before review repair mutation");
  }
}

/**
 * Re-authenticate the bound reviewer attempt's fixed required-verification contract against the
 * current trusted policy.
 *
 * A failing review result is reportable without any verification record, so this requires no
 * success record. It requires only currency: whatever contract the attempt fixed must still be the
 * current trusted policy, so a policy change during the attempt produces no GitHub write and no
 * repair launch. The attempt is re-read from disk because this runs immediately before a write,
 * after every external observation.
 */
function assertAttemptContractCurrent(
  env: { attemptRecordFile: string; repoPath: string; stateDir: string },
  enabled: { githubRepositoryId?: string },
): void {
  if (!env.attemptRecordFile) throw new Error("bound reviewer attempt is missing before review repair mutation");
  reauthorizeReviewWrite(readAttemptRecord(path.dirname(env.attemptRecordFile)), {
    projectRepo: env.repoPath,
    localConfigPath: process.env.DEADLOOP_CONFIG || path.join(env.stateDir, "projects.json"),
    repositoryId: enabled.githubRepositoryId,
  });
}

function revalidateManagedPr(
  prNumber: string,
  env: ReturnType<typeof envConfig>,
  enabled: { automationLogin?: string; githubRepositoryId?: string; githubRepo?: string },
  expectedHead: string,
): void {
  const authenticated = commandRunner.runText(["gh", "api", "user", "--jq", ".login"]).trim().toLowerCase();
  const enabledLogin = String(enabled?.automationLogin || "").trim().toLowerCase();
  if (!authenticated || !enabledLogin || authenticated !== enabledLogin) {
    throw new StaleLaunchError(`PR #${prNumber} authenticated identity no longer matches enablement authority`);
  }
  const repository = commandRunner.runJson(["gh", "repo", "view", env.githubRepo, "--json", "id,nameWithOwner"]);
  if (String(repository.id || "") !== String(enabled.githubRepositoryId || "")
    || String(repository.nameWithOwner || "") !== String(enabled.githubRepo || "")) {
    throw new StaleLaunchError(`PR #${prNumber} repository identity changed before mutation`);
  }
  const livePr = readLivePr(env.githubRepo, prNumber);
  if (String(livePr.state || "").toUpperCase() !== "OPEN"
    || String(livePr.headRefOid || "").toLowerCase() !== expectedHead.toLowerCase()) {
    throw new StaleLaunchError(`PR #${prNumber} review repair target changed before mutation`);
  }
  requireManagedPr(livePr, env);
  // The last gate is local, so no external observation stands between it and the write it guards.
  assertAttemptContractCurrent(env, enabled);
}

function withRevalidatedPrMutation(
  prNumber: string,
  env: ReturnType<typeof envConfig>,
  expectedPr: JsonObject,
  mutation: (guardedGithub: ReturnType<typeof createGithubOperations>, livePr: JsonObject) => void,
  expectedHistory?: PrHistoryObservation,
): JsonObject | undefined {
  let staleComparison: JsonObject | undefined;
  withEnabledDriverLock(env, (enabled: { automationLogin?: string }, recheck: () => void) => {
    const livePr = readLivePr(env.githubRepo, prNumber);
    assertSameLaunchTarget(expectedPr, livePr, "pr");
    requireManagedPr(livePr, env);
    const revalidate = () => revalidateManagedPr(prNumber, env, enabled, String(expectedPr.headRefOid || ""));
    revalidate();
    const guardedGithub = createGithubOperations(commandRunner, () => { recheck(); revalidate(); });
    if (expectedHistory) {
      const currentHistory = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
      const comparison = comparePrHistoryObservations(expectedHistory, currentHistory);
      if (comparison.kind !== "unchanged") {
        staleComparison = comparison;
        guardedGithub.movePrLabels(env.githubRepo, prNumber, { remove: [env.inProgressLabel], add: env.reviewLabel });
        return;
      }
    }
    mutation(guardedGithub, livePr);
  });
  return staleComparison;
}

function claimedPrStillReleasable(livePr: JsonObject, env: ReturnType<typeof envConfig>, expectedHead: string): boolean {
  const labels = labelNames(livePr.labels);
  return String(livePr.state || "").toUpperCase() === "OPEN"
    && String(livePr.headRefOid || "").toLowerCase() === expectedHead.toLowerCase()
    && labels.includes(env.inProgressLabel)
    && !labels.includes(env.blockedLabel);
}

function releaseObservedStaleReviewHistory(
  prNumber: string,
  env: ReturnType<typeof envConfig>,
  comparison: JsonObject,
  expectedHead: string,
): { stale: true; comparison: JsonObject } {
  withEnabledDriverLock(env, (_enabled: unknown, recheck: () => void) => {
    const livePr = readLivePr(env.githubRepo, prNumber);
    if (!claimedPrStillReleasable(livePr, env, expectedHead)) return;
    const guardedGithub = createGithubOperations(commandRunner, recheck);
    guardedGithub.movePrLabels(env.githubRepo, prNumber, { remove: [env.inProgressLabel], add: env.reviewLabel });
  });
  return { stale: true, comparison };
}

function blockedClaimMove(env: ReturnType<typeof envConfig>) {
  return blockedPrLabelMove(
    { updateBranch: env.updateBranchLabel, implement: env.implementLabel, review: env.reviewLabel },
    env.inProgressLabel,
    env.blockedLabel,
  );
}

function applyHumanBlock(
  prNumber: string,
  env: ReturnType<typeof envConfig>,
  expectedPr: JsonObject,
  reason: string,
  summary: string,
  marker = "",
  expectedHistory?: PrHistoryObservation,
): { comment: string; staleComparison?: JsonObject } {
  const comment = recoveryComment(prNumber, env, reason, summary, marker);
  const staleComparison = withRevalidatedPrMutation(prNumber, env, expectedPr, (guardedGithub) => {
    guardedGithub.commentPr(env.githubRepo, prNumber, comment);
    guardedGithub.movePrLabels(env.githubRepo, prNumber, blockedClaimMove(env));
  }, expectedHistory);
  return { comment, ...(staleComparison ? { staleComparison } : {}) };
}

function staleHistoryResult(prNumber: string, comparison: JsonObject, context: string): DriverResult {
  return driverResult("done", `PR #${prNumber} review history changed ${context}; released the active claim`, {
    driverAction: "review_stale_history",
    historyComparison: comparison,
  });
}

function createdCommentIdentity(output: string, author: string, body: string): { id: string; author: string; body: string } {
  const id = output.trim().match(/#issuecomment-(\d+)\/?$/)?.[1];
  if (!id || !author) throw new Error("persisted review comment identity is unavailable");
  return { id, author, body };
}

function persistAuthorizedApproval<T extends unknown[]>(
  withMutation: (callback: (...args: T) => void) => void,
  authorize: () => void,
  persist: (...args: T) => void,
): unknown {
  let authorizationError: unknown;
  withMutation((...callbackArgs) => {
    try {
      authorize();
    } catch (error) {
      authorizationError = error;
      return;
    }
    persist(...callbackArgs);
  });
  return authorizationError;
}

function persistedReviewBody(
  comments: JsonObject[],
  head: string,
  fingerprint: string,
  outcome: string,
  rendered: string,
  marker: string,
  attemptId?: string,
): string {
  const reviewExists = reviewCommentExists(comments, head, fingerprint, outcome);
  const markerExists = attemptId && parseAttemptPersistenceMarkers(comments).some((item: JsonObject) => item.attemptId === attemptId);
  if (!reviewExists) return `${rendered}${marker ? `\n${marker}` : ""}`;
  return marker && !markerExists ? marker : "";
}

function assertReviewerDispatchAttemptBinding(record: JsonObject, input: JsonObject): void {
  if (record.project !== String(input.projectId)
    || record.repository !== String(input.githubRepo)
    || record.role !== "reviewer"
    || record.target?.kind !== "pull-request"
    || Number(record.target?.number) !== Number(input.pr)
    || String(record.inputRevision?.head || "").toLowerCase() !== String(input.expectedHead).toLowerCase()
    || record.branch !== String(input.branch)
    || String(record.requestEventId || "") !== String(input.requestEventId || "")) {
    throw new Error("saved reviewer attempt does not match the repair dispatch target");
  }
}

function applyPrRequiredVerificationStop(args: JsonObject, error: unknown): DriverResult {
  const env = envConfig(args);
  const prNumber = String(args.pr);
  const attemptRecord = readAttemptRecord(path.dirname(String(args.attemptRecord)));
  const report = JSON.parse(fs.readFileSync(String(args.promise), "utf8"));
  const expectedHead = String(args.expectedHead || "").toLowerCase();
  const diagnosis = requiredVerificationStopDiagnosis(attemptRecord, error);
  let reviewComment = "";
  let stopComment = "Required-verification stop comment already exists.";

  withEnabledDriverLock(env, (enabled: { automationLogin?: string; githubRepositoryId?: string; githubRepo?: string }, recheck: () => void) => {
    const observe = (): JsonObject => {
      const authenticated = commandRunner.runText(["gh", "api", "user", "--jq", ".login"]).trim().toLowerCase();
      if (!authenticated || authenticated !== String(enabled.automationLogin || "").trim().toLowerCase()) {
        throw new StaleLaunchError(`PR #${prNumber} authenticated identity no longer matches enablement authority`);
      }
      const repository = commandRunner.runJson(["gh", "repo", "view", env.githubRepo, "--json", "id,nameWithOwner"]);
      if (String(repository.id || "") !== String(enabled.githubRepositoryId || "")
        || String(repository.nameWithOwner || "") !== String(enabled.githubRepo || "")) {
        throw new StaleLaunchError(`PR #${prNumber} repository identity changed before required-verification stop`);
      }
      const live = readLivePr(env.githubRepo, prNumber);
      if (String(live.state || "").toUpperCase() !== "OPEN"
        || String(live.headRefOid || "").toLowerCase() !== expectedHead
        || String(live.headRefName || "") !== String(args.branch || "")) {
        throw new StaleLaunchError(`PR #${prNumber} changed before required-verification stop`);
      }
      const labels = labelNames(live.labels);
      const resumable = labels.includes(env.blockedLabel)
        && (live.comments || []).some((comment: JsonObject) => isPrRequiredVerificationStopComment(comment.body));
      if (!labels.includes(env.inProgressLabel) && !resumable) {
        throw new StaleLaunchError(`PR #${prNumber} no longer has the review attempt claim`);
      }
      return live;
    };

    let livePr = observe();
    const beforeMutation = () => { recheck(); livePr = observe(); };
    const github = createGithubOperations(commandRunner, beforeMutation);
    const outcome = String(report.result?.outcome || "");
    if (outcome === "changes_requested") {
      const findings = Array.isArray(report.result?.findings) ? report.result.findings : [];
      const advisories = Array.isArray(report.result?.advisories) ? report.result.advisories : [];
      const fingerprint = reviewOutcomeFingerprint(outcome, "", report.summary || "", findings, advisories);
      if (!reviewCommentExists(livePr.comments || [], expectedHead, fingerprint, outcome)) {
        reviewComment = renderChangesRequestedComment({
          headOid: expectedHead,
          summary: report.summary || "",
          findings,
          advisories,
          priorRequiredFindings: report.result?.priorRequiredFindings,
          reviewFingerprint: fingerprint,
          repairBlocked: true,
        });
        github.commentPr(env.githubRepo, prNumber, reviewComment);
        livePr = observe();
      }
    }
    const plan = planPrRequiredVerificationStop({
      pr: livePr,
      resolution: diagnosis,
      labels: {
        review: env.reviewLabel,
        implement: env.implementLabel,
        updateBranch: env.updateBranchLabel,
        inProgress: env.inProgressLabel,
        blocked: env.blockedLabel,
        human: env.humanLabel,
      },
    });
    if (plan.comment) {
      stopComment = plan.comment;
      github.commentPr(env.githubRepo, prNumber, plan.comment);
    }
    if (plan.removeLabels.length || plan.addLabels.length) {
      github.movePrLabels(env.githubRepo, prNumber, { remove: plan.removeLabels, add: plan.addLabels });
    }
  });

  return driverResult("done", `PR #${prNumber} review stopped by required verification`, {
    driverAction: "review_verification_blocked",
    comment: stopComment,
    findingsRecorded: Boolean(reviewComment),
    labelsPreserved: [env.reviewLabel],
    labelsRemoved: [env.inProgressLabel],
  });
}

function dispatch(args: JsonObject): DriverResult {
  try {
    return dispatchReviewResult(args);
  } catch (error) {
    if (!isRequiredVerificationPolicyBlock(error)) throw error;
    return applyPrRequiredVerificationStop(args, error);
  }
}

function dispatchReviewResult(args: JsonObject): DriverResult {
  runHerdrPreflight({ run: (command: string, commandArgs: string[]) => commandRunner.runText([command, ...commandArgs]) });
  const env = envConfig(args);
  if (!env.githubRepo) return driverResult("error", "DEADLOOP_GITHUB_REPO is required", { driverAction: "configuration_error" });
  const prNumber = String(args.pr);
  const hasAttemptRecord = Boolean(args.attemptRecord && fs.existsSync(String(args.attemptRecord)));
  if (!hasAttemptRecord) throw new Error("saved reviewer attempt record is required before repair dispatch");
  const validation = validatePromise(String(args.promise), String(args.attemptRecord));
  if (validation.status === "none" || validation.status === "invalid") {
    return driverResult("error", `reviewer promise is ${validation.status}`, { driverAction: "invalid_promise", validation });
  }
  const promise = validation.promise as JsonObject;
  const rawReport = JSON.parse(fs.readFileSync(String(args.promise), "utf8"));
  const attemptRecord = readAttemptRecord(path.dirname(String(args.attemptRecord)));
  assertReviewerDispatchAttemptBinding(attemptRecord, {
    projectId: env.projectId,
    githubRepo: env.githubRepo,
    pr: prNumber,
    expectedHead: args.expectedHead,
    branch: args.branch,
    requestEventId: args.requestEventId,
  });
  const persistenceMarker = rawReport?.schemaVersion === 1
    ? renderAttemptPersistenceMarker(attemptRecord, rawReport, {
        findings: rawReport.role === "reviewer" ? rawReport.result?.findings || [] : [],
        boundedRepairAttemptMarked: rawReport.role === "reviewer"
          && decideReviewTransition(rawReport.result || {}).transition === "repair",
      })
    : "";
  const expectedHead = String(args.expectedHead).toLowerCase();
  const branch = String(args.branch);
  const pr = readLivePr(env.githubRepo, prNumber);
  // No early claim check here: every mutation below is guarded, and a replayed
  // dispatch legitimately observes the request already queued without in-progress.
  const historyFile = hasAttemptRecord
    ? path.join(path.dirname(String(args.attemptRecord)), "pr-review-history.json")
    : "";
  const acceptedHistoryFile = historyFile ? path.join(path.dirname(historyFile), "pr-review-history-accepted.json") : "";
  let baselineHistory: PrHistoryObservation | undefined;
  let checkpointOrigin: "original" | "accepted" | undefined;
  // Outcome inputs of the bound reviewer report, needed before the history checkpoint because a
  // saved result comment is proven against this exact outcome fingerprint.
  const outcome = String(promise.outcome || "approved");
  const findings = (promise.findings || []) as JsonObject[];
  const advisories = (promise.advisories || []) as JsonObject[];
  const priorRequiredFindings = promise.priorRequiredFindings;
  const reviewFingerprint = reviewOutcomeFingerprint(outcome, promise.reason || "", promise.summary || "", findings, advisories);
  const historyRequired = attemptRecord?.reviewHistoryRequired === true;
  if (historyRequired) {
    if (!fs.existsSync(historyFile)) {
      return driverResult("error", `PR #${prNumber} attempt history observation is missing`, {
        driverAction: "incomplete_review_history",
        reason: "missing_attempt_history_observation",
      });
    }
    try {
      readPrHistoryObservation(historyFile);
    } catch {
      return driverResult("error", `PR #${prNumber} attempt history observation is invalid`, {
        driverAction: "incomplete_review_history",
        reason: "invalid_attempt_history_observation",
      });
    }
  }
  if (historyFile && fs.existsSync(historyFile)) {
    // Resolve the retry baseline: the original launch-time history, unless the saved accepted result
    // checkpoint provably is that history advanced by exactly this attempt's one result comment and
    // the live GitHub history still matches it. Anything ambiguous keeps the original baseline, so
    // an unproven checkpoint can only ever repeat the old stale judgment, never skip one.
    let acceptedHistory: PrHistoryObservation | undefined;
    let acceptedUnreadable = false;
    if (fs.existsSync(acceptedHistoryFile)) {
      try {
        acceptedHistory = readPrHistoryObservation(acceptedHistoryFile);
      } catch {
        acceptedUnreadable = true;
      }
    }
    const resolved = resolveReviewResultCheckpoint({
      original: readPrHistoryObservation(historyFile),
      ...(acceptedHistory ? { accepted: acceptedHistory } : {}),
      acceptedUnreadable,
      live: observePrHistory(env.githubRepo, Number(prNumber), commandRunner),
      attemptId: String(attemptRecord.attemptId || ""),
      expectedHead,
      outcome,
      reviewFingerprint,
      automationLogin: commandRunner.runText(["gh", "api", "user", "--jq", ".login"]).trim(),
      liveComments: pr.comments || [],
    });
    baselineHistory = resolved.baseline;
    checkpointOrigin = resolved.origin;
    if (!resolved.liveMatchesBaseline) {
      const freshness = releaseObservedStaleReviewHistory(prNumber, env, resolved.comparison, expectedHead);
      return driverResult("done", `PR #${prNumber} review history changed; released the active claim for a fresh review`, {
        driverAction: "review_stale_history",
        historyComparison: freshness.comparison,
        labelsPreserved: [env.reviewLabel],
        labelsRemoved: [env.inProgressLabel],
      });
    }
  }
  const checkpointNote = checkpointOrigin === "accepted" ? { resultCheckpoint: "accepted_result_history" } : {};

  if (String(pr.state || "").toUpperCase() !== "OPEN" || Boolean(pr.isCrossRepository) || String(pr.headRefName || "") !== branch) {
    const block = applyHumanBlock(prNumber, env, pr, "the selected PR is no longer a safe same-repository branch target", promise.summary, "", baselineHistory);
    if (block.staleComparison) return staleHistoryResult(prNumber, block.staleComparison, "before human block");
    return driverResult("done", `PR #${prNumber} requires human intervention`, { driverAction: "review_human_blocked", comment: block.comment });
  }
  if (validation.status === "blocked") {
    if (String(pr.headRefOid || "").toLowerCase() !== expectedHead) {
      return driverResult("done", `PR #${prNumber} head changed; left labels untouched for re-evaluation`, { driverAction: "review_stale_head" });
    }
    const technicalDecision = decideTechnicalReviewFailure(pr.comments || [], expectedHead, promise);
    if (technicalDecision.action === "storage_exhaustion") {
      const block = applyHumanBlock(
        prNumber,
        env,
        pr,
        "the host ran out of storage during the review; free up storage on the automation host, then add a new Agent request",
        promise.summary,
        "",
        baselineHistory,
      );
      if (block.staleComparison) return staleHistoryResult(prNumber, block.staleComparison, "before storage-exhaustion stop");
      return driverResult("done", `PR #${prNumber} review stopped because the host ran out of storage`, {
        driverAction: "review_storage_exhaustion_blocked",
        comment: block.comment,
      });
    }
    if (technicalDecision.action === "retry") {
      const staleComparison = withRevalidatedPrMutation(prNumber, env, pr, (guardedGithub) => {
        guardedGithub.commentPr(
          env.githubRepo,
          prNumber,
          `Reviewer technical failure will be retried once for this head: ${publicText(promise.reason, "technical review failure")}\n\n${renderTechnicalFailureMarker(expectedHead)}`,
        );
        guardedGithub.movePrLabels(env.githubRepo, prNumber, {
          remove: [env.inProgressLabel], add: env.reviewLabel,
        });
      }, baselineHistory);
      if (staleComparison) return staleHistoryResult(prNumber, staleComparison, "before technical retry");
      return driverResult("done", `PR #${prNumber} reviewer technical failure requeued review once`, {
        driverAction: "review_technical_retry",
      });
    }
    const block = applyHumanBlock(prNumber, env, pr, "the reviewer failed technically twice on the same PR head", promise.summary, "", baselineHistory);
    if (block.staleComparison) return staleHistoryResult(prNumber, block.staleComparison, "before technical retry exhaustion");
    return driverResult("done", `PR #${prNumber} exhausted its technical review retry`, {
      driverAction: "review_technical_retry_exhausted",
      comment: block.comment,
    });
  }

  // The reviewer owns the semantic judgment; this picks the one allowed transition.
  const review = decideReviewTransition({ outcome, priorRequiredFindings });
  const commentInput = {
    headOid: expectedHead,
    reason: promise.reason || "",
    summary: promise.summary || "",
    findings,
    additionalValidations: Array.isArray(promise.checks) ? promise.checks : [],
    advisories,
    priorRequiredFindings,
    transitionReason: review.reason,
    reviewFingerprint,
    reviewLabel: env.reviewLabel,
  };

  if (review.transition === "approve") {
    if (String(pr.headRefOid || "").toLowerCase() !== expectedHead) {
      return driverResult("done", `PR #${prNumber} head changed; left labels untouched for re-evaluation`, { driverAction: "review_stale_head" });
    }
    let persistedBody = "";
    let createdComment: { id: string; author: string; body: string } | undefined;
    let observedStaleComparison: JsonObject | undefined;
    let authorizationError: unknown;
    let headChangedDuringAuthorization = false;
    try {
      authorizationError = persistAuthorizedApproval(
        (persist: (guardedGithub: ReturnType<typeof createGithubOperations>, refreshed: JsonObject, livePr: JsonObject) => void) => {
          withRevalidatedPrMutation(prNumber, env, pr, (guardedGithub, livePr) => {
            if (baselineHistory) {
              const currentHistory = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
              const comparison = comparePrHistoryObservations(baselineHistory, currentHistory);
              if (comparison.kind !== "unchanged") {
                observedStaleComparison = comparison;
                throw new StaleLaunchError(`PR #${prNumber} review history changed before result persistence`);
              }
            }
            const refreshed = readLivePr(env.githubRepo, prNumber);
            if (String(refreshed.state || "").toUpperCase() !== "OPEN"
              || String(refreshed.headRefOid || "").toLowerCase() !== expectedHead) {
              headChangedDuringAuthorization = true;
              return;
            }
            persist(guardedGithub, refreshed, livePr);
          });
        },
        // This runs after the last PR head observation and immediately before the comment, so the
        // fixed contract, the current trusted policy and the success record bound to this exact
        // head are all re-authenticated with nothing observable left to change.
        () => {
          if (!attemptRecord || !rawReport) throw new Error("bound reviewer attempt is missing");
          const enabled = assertLocallyEnabled({ repoPath: env.repoPath, githubRepo: env.githubRepo, stateDir: env.stateDir, enabledAt: env.enabledAt });
          reauthorizeReviewWrite(attemptRecord, {
            projectRepo: env.repoPath,
            localConfigPath: process.env.DEADLOOP_CONFIG || path.join(env.stateDir, "projects.json"),
            repositoryId: enabled.githubRepositoryId,
            report: rawReport,
            attemptRecordFile: String(args.attemptRecord),
          });
        },
        (guardedGithub, refreshed, livePr) => {
          persistedBody = persistedReviewBody(refreshed.comments || livePr.comments || [], expectedHead, reviewFingerprint, outcome,
            renderApprovedReviewComment(commentInput), persistenceMarker, attemptRecord?.attemptId);
          if (!persistedBody) return;
          const output = guardedGithub.commentPr(env.githubRepo, prNumber, persistedBody);
          if (baselineHistory) {
            const automationLogin = commandRunner.runText(["gh", "api", "user", "--jq", ".login"]).trim();
            createdComment = createdCommentIdentity(output, automationLogin, persistedBody);
          }
        },
      );
    } catch (error) {
      if (!isStaleLaunchError(error) || !observedStaleComparison) throw error;
      const freshness = releaseObservedStaleReviewHistory(prNumber, env, observedStaleComparison, expectedHead);
      return driverResult("done", `PR #${prNumber} review history changed before result persistence; released the active claim`, {
        driverAction: "review_stale_history", historyComparison: freshness.comparison,
      });
    }
    if (headChangedDuringAuthorization) {
      return driverResult("done", `PR #${prNumber} head changed during approval authorization; left labels untouched for re-evaluation`, { driverAction: "review_stale_head" });
    }
    if (authorizationError) return applyPrRequiredVerificationStop(args, authorizationError);
    if (baselineHistory) {
      const afterPersistence = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
      const advancement = advancePrHistoryAfterDeterministicComment(baselineHistory, afterPersistence, createdComment);
      if (advancement.kind !== "accepted") {
        const freshness = releaseObservedStaleReviewHistory(prNumber, env, advancement.comparison, expectedHead);
        return driverResult("done", `PR #${prNumber} review history changed during result persistence; released the active claim`, {
          driverAction: "review_stale_history",
          historyComparison: freshness.comparison,
        });
      }
      writePrHistoryObservation(acceptedHistoryFile, advancement.observation);
    }
    return driverResult("done", `PR #${prNumber} review completed without actionable findings`, {
      driverAction: "review_approved",
      ...checkpointNote,
    });
  }
  if (review.transition === "human_required") {
    if (String(pr.headRefOid || "").toLowerCase() !== expectedHead) {
      return driverResult("done", `PR #${prNumber} head changed; left labels untouched for re-evaluation`, { driverAction: "review_stale_head" });
    }
    let comment = "Review result comment already exists.";
    let createdComment: { id: string; author: string; body: string } | undefined;
    let observedStaleComparison: JsonObject | undefined;
    try {
      withRevalidatedPrMutation(prNumber, env, pr, (guardedGithub, livePr) => {
        if (baselineHistory) {
          const currentHistory = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
          const comparison = comparePrHistoryObservations(baselineHistory, currentHistory);
          if (comparison.kind !== "unchanged") {
            observedStaleComparison = comparison;
            throw new StaleLaunchError(`PR #${prNumber} review history changed before human handoff`);
          }
        }
        if (!reviewCommentExists(livePr.comments || [], expectedHead, reviewFingerprint, "human_required")) {
          comment = renderHumanRequiredComment(commentInput);
          if (persistenceMarker) comment = `${comment}\n${persistenceMarker}`;
          const output = guardedGithub.commentPr(env.githubRepo, prNumber, comment);
          if (baselineHistory) {
            const automationLogin = commandRunner.runText(["gh", "api", "user", "--jq", ".login"]).trim();
            createdComment = createdCommentIdentity(output, automationLogin, comment);
          }
        }
        if (baselineHistory) {
          const afterPersistence = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
          const advancement = advancePrHistoryAfterDeterministicComment(baselineHistory, afterPersistence, createdComment);
          if (advancement.kind !== "accepted") {
            observedStaleComparison = advancement.comparison;
            throw new StaleLaunchError(`PR #${prNumber} review history changed during human handoff`);
          }
          writePrHistoryObservation(acceptedHistoryFile, advancement.observation);
        }
        // The draft leaves first. A failed label removal then shows a ready pull request whose
        // requests are still visible, which the loop can retry; the reverse would strand a draft
        // nobody is waiting on.
        if (livePr.isDraft === true) guardedGithub.markPrReady(env.githubRepo, prNumber);
        const labels = labelNames(livePr.labels);
        if (agentWorkflowLabels(env).some((label) => labels.includes(label))) {
          guardedGithub.movePrLabels(env.githubRepo, prNumber, humanHandoffLabelMove(env));
        }
      });
    } catch (error) {
      if (!isStaleLaunchError(error) || !observedStaleComparison) throw error;
      const freshness = releaseObservedStaleReviewHistory(prNumber, env, observedStaleComparison, expectedHead);
      return driverResult("done", `PR #${prNumber} review history changed before human handoff; released the active claim`, {
        driverAction: "review_stale_history", historyComparison: freshness.comparison,
      });
    }
    return driverResult("done", `PR #${prNumber} review was handed to a human`, {
      driverAction: "review_human_handoff",
      reason: review.reason,
      comment,
      ...checkpointNote,
    });
  }

  const refreshedPr = readLivePr(env.githubRepo, prNumber);
  if (String(refreshedPr.state || "").toUpperCase() !== "OPEN" || Boolean(refreshedPr.isCrossRepository) || String(refreshedPr.headRefName || "") !== branch) {
    const block = applyHumanBlock(prNumber, env, refreshedPr, "the selected PR stopped being a safe same-repository branch target before repair request", promise.summary, "", baselineHistory);
    if (block.staleComparison) return staleHistoryResult(prNumber, block.staleComparison, "before repair request");
    return driverResult("done", `PR #${prNumber} requires human intervention`, { driverAction: "review_human_blocked", comment: block.comment });
  }
  if (String(refreshedPr.headRefOid || "").toLowerCase() !== expectedHead) {
    return driverResult("done", `PR #${prNumber} head changed before repair request; left GitHub state untouched`, { driverAction: "review_stale_head" });
  }

  const automationLogin = commandRunner.runText(["gh", "api", "user", "--jq", ".login"]).trim();
  if (!automationLogin) throw new Error("authenticated GitHub identity is unavailable");
  const selection = selectRepairAttempt(refreshedPr.comments || [], expectedHead, findings, automationLogin);
  if (selection.action === "already_attempted") {
    // The one repair for this exact review result was already requested. Complete whatever part of
    // the claim-to-request transition landed before an interruption, and start nothing new.
    const ensured = queueRepairRequest(prNumber, env, expectedHead);
    if (!ensured.applied) {
      return driverResult("skip", `PR #${prNumber} no longer holds the active review claim (${ensured.reason}); left workflow state untouched`, {
        driverAction: "review_repair_already_requested_stale",
        staleReason: ensured.reason,
      });
    }
    return driverResult("done", `PR #${prNumber} already requested its one automatic review repair`, {
      driverAction: "review_repair_already_requested", selection,
      ...checkpointNote,
    });
  }
  if (hasAttemptRecord) {
    let persistedBody = "";
    let createdComment: { id: string; author: string; body: string } | undefined;
    let observedStaleComparison: JsonObject | undefined;
    try {
      withRevalidatedPrMutation(prNumber, env, refreshedPr, (guardedGithub, livePr) => {
        if (baselineHistory) {
          const currentHistory = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
          const comparison = comparePrHistoryObservations(baselineHistory, currentHistory);
          if (comparison.kind !== "unchanged") {
            observedStaleComparison = comparison;
            throw new StaleLaunchError(`PR #${prNumber} review history changed before repair result persistence`);
          }
        }
        persistedBody = persistedReviewBody(livePr.comments || [], expectedHead, selection.reviewFingerprint, outcome,
          renderChangesRequestedComment({ ...commentInput, reviewFingerprint: selection.reviewFingerprint }),
          persistenceMarker, attemptRecord?.attemptId);
        if (persistedBody) {
          const output = guardedGithub.commentPr(env.githubRepo, prNumber, persistedBody);
          if (baselineHistory) {
            createdComment = createdCommentIdentity(output, automationLogin, persistedBody);
          }
        }
      });
    } catch (error) {
      if (!isStaleLaunchError(error) || !observedStaleComparison) throw error;
      const freshness = releaseObservedStaleReviewHistory(prNumber, env, observedStaleComparison, expectedHead);
      return driverResult("done", `PR #${prNumber} review history changed before repair result persistence; released the active claim`, {
        driverAction: "review_stale_history", historyComparison: freshness.comparison,
      });
    }
    if (baselineHistory) {
      const afterPersistence = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
      const advancement = advancePrHistoryAfterDeterministicComment(baselineHistory, afterPersistence, createdComment);
      if (advancement.kind !== "accepted") {
        const freshness = releaseObservedStaleReviewHistory(prNumber, env, advancement.comparison, expectedHead);
        return driverResult("done", `PR #${prNumber} review history changed during repair dispatch; released the active claim`, {
          driverAction: "review_stale_history", historyComparison: freshness.comparison,
        });
      }
      writePrHistoryObservation(acceptedHistoryFile, advancement.observation);
    }
    const closed = commandRunner.runJson([
      "node", path.join(__dirname, "complete-attempt-workspace.cts"),
      "--attempt-record", String(args.attemptRecord),
      "--project-id", env.projectId,
      "--project-repo", env.repoPath,
      "--github-repo", env.githubRepo,
      "--state-dir", env.stateDir,
      "--enabled-at", String(env.enabledAt),
      "--expected-label", env.inProgressLabel,
      "--managed-label", env.reviewLabel,
      "--managed-label", env.inProgressLabel,
      "--managed-label", env.blockedLabel,
      "--managed-label", env.implementLabel,
      "--managed-label", env.updateBranchLabel,
    ]);
    if (closed?.driverAction !== "workspace_closed") throw new Error("reviewer workspace was not closed before repair request");
  }

  const requested = queueRepairRequest(prNumber, env, expectedHead);
  if (!requested.applied) {
    return driverResult("skip", `PR #${prNumber} no longer holds the active review claim (${requested.reason}); left workflow state untouched`, {
      driverAction: "review_repair_request_stale",
      staleReason: requested.reason,
    });
  }
  return driverResult("done", `PR #${prNumber} review result queued an agent:implement repair request`, {
    driverAction: "review_repair_requested", selection,
    ...checkpointNote,
  });
}

/**
 * Replace the active review claim with an agent:implement repair request (ADR 0032).
 *
 * The request label goes on first: a crash window that leaves both labels visible still selects
 * for repair, while removing the claim first could leave a pull request carrying nothing at all.
 * Idempotent, so an interrupted dispatch completes the transition it started.
 */
function queueRepairRequest(prNumber: string, env: ReturnType<typeof envConfig>, expectedHead: string): { applied: boolean; reason?: string } {
  let applied = false;
  let reason: string | undefined;
  withEnabledDriverLock(env, (enabled: { automationLogin?: string; githubRepositoryId?: string; githubRepo?: string }, recheck: () => void) => {
    const livePr = readLivePr(env.githubRepo, prNumber);
    if (String(livePr.state || "").toUpperCase() !== "OPEN"
      || String(livePr.headRefOid || "").toLowerCase() !== expectedHead.toLowerCase()) {
      throw new StaleLaunchError(`PR #${prNumber} changed before its repair request`);
    }
    const labels = new Set(labelNames(livePr.labels));
    if (!labels.has(env.inProgressLabel) || labels.has(env.blockedLabel)) {
      reason = claimGrounding(livePr, expectedHead);
      return;
    }
    revalidateManagedPr(prNumber, env, enabled, expectedHead);
    const guardedGithub = createGithubOperations(commandRunner, () => { recheck(); revalidateManagedPr(prNumber, env, enabled, expectedHead); });
    if (!labels.has(env.implementLabel)) {
      guardedGithub.addPrLabel(env.githubRepo, prNumber, env.implementLabel);
    }
    guardedGithub.movePrLabels(env.githubRepo, prNumber, { remove: [env.inProgressLabel], add: [] });
    applied = true;
  });
  return applied ? { applied } : { applied, reason };
}

function main(): void {
  try {
    process.stdout.write(`${JSON.stringify(dispatch(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "exception" }))}\n`,
    );
  }
}

if (require.main === module) main();

module.exports = {
  assertReviewerDispatchAttemptBinding,
  blockedClaimMove,
  claimGrounding,
  dispatch,
  envConfig,
  parseArgs,
  persistAuthorizedApproval,
  queueRepairRequest,
  readLivePr,
  requireManagedPr,
};
