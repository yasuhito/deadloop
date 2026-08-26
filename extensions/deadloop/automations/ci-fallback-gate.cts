#!/usr/bin/env node
// Gate one automatic merge on CI checks and CI fallback verification (ADR 0030).
//
// GitHub checks are one health signal. Absence is non-failure, pending waits, unknown stops, and a
// terminal failure is replaced only by fresh CI-equivalent verification of the prospective merge
// tree, bound to exact head, base, tree, command, and policy source. A fallback failure triggers the
// base diagnosis; base blocking suppresses new launches until base or contract changes; base success
// allows exactly one existing-path review repair per episode.

const path = require("node:path") as typeof import("node:path");

const {
  classifyCheckObservations,
  decideCiFallbackRepair,
} = require("../../../src/ci-review-policy.cts");
const { observeTrustedBaseContract } = require("../../../src/ci-equivalent-contract.cts") as {
  observeTrustedBaseContract: (input: { projectRepo: string; baseRevision: string }) => any;
};
const store = require("../../../src/ci-fallback-store.cjs");
const {
  createCommandRunner,
  driverResult,
} = require("../../../src/automation-driver-kit.cts");
const { createGithubOperations } = require("../../../src/github-operations.cts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { reauthorizeReviewWrite } = require("../../../src/worker-required-verification-runtime.cjs");
import type { JsonObject } from "../../../src/automation-driver-kit-types";

// The repair dispatch module owns the shared environment shape for review-path automations.
const { envConfig } = require("./pr-review-repair-dispatch.cts");

function repairDispatchModule() {
  return require("./pr-review-repair-dispatch.cts");
}

const commandRunner = createCommandRunner();

function parseGateArgs(argv: string[]): JsonObject {
  const args: JsonObject = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    args[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  return args;
}

/** One live PR observation: check rollup plus the exact head GitHub currently reports. */
function observeChecks(githubRepo: string, prNumber: number): { checks: unknown[]; liveHeadOid: string } {
  const pr = commandRunner.runJson([
    "gh", "pr", "view", String(prNumber), "-R", githubRepo,
    "--json", "statusCheckRollup,headRefOid",
  ]);
  return {
    checks: Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [],
    liveHeadOid: String(pr.headRefOid || ""),
  };
}

function observedBaseRevision(env: ReturnType<typeof envConfig>): string {
  const remoteRef = env.baseBranch.startsWith("refs/remotes/") ? env.baseBranch.slice("refs/remotes/".length) : env.baseBranch;
  const separator = remoteRef.indexOf("/");
  if (separator > 0) commandRunner.runText(["git", "-C", env.repoPath, "fetch", "--quiet", remoteRef.slice(0, separator), remoteRef.slice(separator + 1)]);
  return commandRunner.runText(["git", "-C", env.repoPath, "rev-parse", "--verify", `${env.baseBranch}^{commit}`]).trim();
}

function runVerifier(args: string[]): JsonObject {
  return commandRunner.runJson(["node", path.join(__dirname, "run-ci-equivalent-verification.cts"), ...args]);
}

function verifierArgs(
  env: ReturnType<typeof envConfig>,
  input: { prNumber: number; headOid: string; baseOid: string; policyBaseRevision: string },
): string[] {
  return [
    "--repo-path", env.repoPath,
    "--project-id", env.projectId,
    "--github-repo", env.githubRepo,
    "--state-dir", env.stateDir,
    "--pr", String(input.prNumber),
    "--head", input.headOid,
    "--base", input.baseOid,
    "--policy-base-revision", input.policyBaseRevision,
  ];
}

/** A human Agent request after the episode started starts a new repair episode. */
function humanRequestAfterEpisode(env: ReturnType<typeof envConfig>, prNumber: number, startedAt: string | undefined): boolean {
  if (!startedAt) return false;
  const automationLogin = String(env.automationLogin || "").toLowerCase();
  if (!automationLogin) return false;
  const events = createGithubOperations(commandRunner).listPrTimelineEvents(env.githubRepo, Number(prNumber)) as JsonObject[];
  return events.some((event) => String(event.event || "").toLowerCase() === "labeled"
    && String(event.label?.name || "") === env.reviewLabel
    && actorLogin(event) !== automationLogin
    && String(event.created_at || "") > String(startedAt));
}

function actorLogin(event: JsonObject): string {
  const actor = event.actor as JsonObject | string | undefined;
  if (actor && typeof actor === "object") return String(actor.login || "").toLowerCase();
  return String(actor || "").toLowerCase();
}

function closeReviewerWorkspace(env: ReturnType<typeof envConfig>): void {
  const closed = commandRunner.runJson([
    "node", path.join(env.automationDir, "complete-attempt-workspace.cts"),
    "--attempt-record", String(env.attemptRecordFile),
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
  if (closed?.driverAction !== "workspace_closed") throw new Error("reviewer workspace was not closed before CI fallback repair launch");
}

function ciFallbackRepairFindings(failure: JsonObject, contractCommand: string): JsonObject[] {
  const evidence = failure.record || {};
  const conflictFiles = evidence.terminationEvidence?.files;
  return [{
    title: "CI fallback verification failed for the prospective merge tree",
    body: [
      `The repository's complete CI-equivalent command failed on the integration of PR head ${String(evidence.headOid || "")} with base ${String(evidence.baseOid || "")}.`,
      `Command: ${contractCommand}`,
      `Exit status: ${String(evidence.exitCode ?? "unknown")}; the execution log is recorded beside the verification record (${path.basename(String(evidence.logPath || ""))}).`,
      ...(Array.isArray(conflictFiles) && conflictFiles.length ? [`Conflicted files: ${conflictFiles.join(", ")}`] : []),
      "Fix the defect so this command passes on the merged tree; do not widen the change.",
    ].join("\n"),
    severity: "blocker",
  }];
}

/**
 * Publish the typed CI fallback failure with its required-findings repair marker, idempotently for
 * the exact head and failure fingerprint (ADR 0032): the driver reads the contract from this marker.
 */
function postCiFallbackFailure(
  env: ReturnType<typeof envConfig>,
  prNumber: number,
  expectedHead: string,
  findings: JsonObject[],
): void {
  const { reviewResultFingerprint, renderRepairMarker } = require("./pr-review-repair-state.cts");
  const reviewFingerprint = reviewResultFingerprint(findings);
  const marker = renderRepairMarker(expectedHead, reviewFingerprint, { findings });
  const body = [
    "## What happened",
    `- CI fallback verification failed for the prospective merge tree of head \`${expectedHead}\`.`,
    "",
    ...findings.map((finding) => [`### ${finding.title}`, String(finding.body)].join("\n")),
    "",
    marker,
  ].join("\n");

  withEnabledDriverLock(env, () => {
    const livePr = commandRunner.runJson([
      "gh", "pr", "view", String(prNumber), "-R", env.githubRepo,
      "--json", "state,headRefOid,labels,comments",
    ]);
    if (String(livePr.state || "").toUpperCase() !== "OPEN"
      || String(livePr.headRefOid || "").toLowerCase() !== expectedHead.toLowerCase()) {
      throw new Error(`PR #${prNumber} changed before its CI fallback repair request comment`);
    }
    const alreadyPosted = ((livePr.comments || []) as JsonObject[]).some((comment) => String(comment.body || "").includes(marker));
    if (!alreadyPosted) {
      createGithubOperations(commandRunner).commentPr(env.githubRepo, prNumber, body);
    }
  });
}

function gate(args: JsonObject): JsonObject {
  const env = repairDispatchModule().envConfig(args);
  if (!env.githubRepo) return driverResult("error", "DEADLOOP_GITHUB_REPO is required", { driverAction: "configuration_error" }) as unknown as JsonObject;
  const prNumber = Number(args.pr);
  const expectedHead = String(args.expectedHead || "").toLowerCase();
  const observation = observeChecks(env.githubRepo, prNumber);
  if (observation.liveHeadOid.toLowerCase() !== expectedHead) {
    return { action: "stop", reason: "stale_head" };
  }

  const classification = classifyCheckObservations(observation.checks);
  if (classification === "absent" || classification === "all_success") {
    return { action: "proceed_merge", basis: classification === "absent" ? "no_checks" : "ci_success" };
  }
  if (classification === "pending") return { action: "wait", reason: "checks_pending" };
  if (classification === "unknown") return { action: "stop", reason: "unknown_check_state" };

  // Terminal failure: replace it with CI-equivalent verification of the exact prospective tree.
  const baseOid = observedBaseRevision(env);
  const policyBaseRevision = String(
    args.policyBaseRevision
    || (env.requiredVerification && env.requiredVerification.baseRevision)
    || baseOid,
  );
  const contract = observeTrustedBaseContract({ projectRepo: env.repoPath, baseRevision: policyBaseRevision });
  if (contract.status !== "resolved") {
    return { action: "stop", reason: "ci_fallback_contract_unavailable", detail: String(contract.reason) };
  }

  const verification = runVerifier(verifierArgs(env, { prNumber, headOid: expectedHead, baseOid, policyBaseRevision }));
  if (!verification.ok) return { action: "stop", reason: "verification_runner_error", detail: String(verification.error || "") };
  if (verification.action === "verified" && verification.outcome === "passed") {
    return { action: "proceed_merge", basis: "ci_fallback", recordPath: verification.recordPath };
  }
  if (verification.action !== "verified") {
    return { action: "stop", reason: "ci_fallback_contract_unavailable", detail: String(verification.reason || "") };
  }

  // Fallback failed: diagnose the fixed trusted base with the identical contract before any repair.
  const diagnosis = runVerifier(verifierArgs(env, { prNumber, headOid: policyBaseRevision, baseOid: policyBaseRevision, policyBaseRevision }));
  if (!diagnosis.ok) return { action: "stop", reason: "verification_runner_error", detail: String(diagnosis.error || "") };
  if (diagnosis.action !== "verified" || diagnosis.outcome !== "passed") {
    store.writeBaseBlocking(env.stateDir, env.projectId, {
      baseRevision: policyBaseRevision,
      command: contract.command,
      prNumber,
      reason: "base_verification_failed",
    });
    return { action: "stop", reason: "base_verification_blocked", baseRevision: policyBaseRevision, command: contract.command };
  }

  // Base healthy: exactly one repair per fallback episode, queued through the existing
  // agent:implement request path so the PR reviewer driver launches it with its own revalidation.
  const episodeKey = store.episodeKeyFor(env.githubRepo, prNumber, policyBaseRevision, contract.command);
  const findings = ciFallbackRepairFindings(verification, contract.command);
  let episode = store.readRepairEpisode(env.stateDir, env.projectId, prNumber);
  const directive = decideCiFallbackRepair({
    episode,
    humanRequestAfterEpisode: humanRequestAfterEpisode(env, prNumber, episode?.startedAt),
    expectedEpisodeKey: episodeKey,
  });
  if (directive.action === "repair_allowed" && directive.episodeReset) {
    episode = store.writeRepairEpisode(env.stateDir, env.projectId, {
      repository: env.githubRepo,
      prNumber,
      episodeKey,
      startedAt: new Date().toISOString(),
      repairsUsed: 0,
    });
  }
  if (directive.action === "repair_blocked") {
    return { action: "stop", reason: "ci_fallback_repair_exhausted", episodeKey };
  }

  // The attempt's fixed required-verification contract must still be current before any mutation;
  // the reviewer workspace then closes exactly like the review-repair request path expects.
  withEnabledDriverLock(env, (enabled: { automationLogin?: string; githubRepositoryId?: string; githubRepo?: string }, recheck: () => void) => {
    void enabled; void recheck;
    if (!env.attemptRecordFile) throw new Error("bound reviewer attempt is missing before the CI fallback repair request");
    reauthorizeReviewWrite(readAttemptRecord(path.dirname(String(env.attemptRecordFile))), {
      projectRepo: env.repoPath,
      localConfigPath: process.env.DEADLOOP_CONFIG || path.join(env.stateDir, "projects.json"),
    });
    closeReviewerWorkspace(env);
  });

  // Post the typed CI fallback failure carrying the required-findings repair marker, then replace
  // the active claim with an agent:implement request. Both steps are idempotent for this exact
  // head and failure fingerprint, so an interrupted dispatch completes its own transition.
  postCiFallbackFailure(env, prNumber, expectedHead, findings);
  const requested = repairDispatchModule().queueRepairRequest(String(prNumber), env, expectedHead);
  if (!requested.applied) {
    return { action: "stop", reason: "ci_fallback_repair_request_stale" };
  }
  // The queue transition is the episode's one repair: repeated failures cannot loop it again.
  store.writeRepairEpisode(env.stateDir, env.projectId, { ...episode, repairsUsed: 1 });
  return driverResult("done", `PR #${prNumber} CI fallback failure queued an agent:implement repair request`, {
    driverAction: "ci_fallback_repair_requested",
  }) as unknown as JsonObject;
}

function main(): void {
  try {
    process.stdout.write(`${JSON.stringify(gate(parseGateArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    // A typed stop keeps the completion workspace for the next cycle; it is not a process failure.
    process.stdout.write(`${JSON.stringify({ action: "stop", reason: "gate_error", detail: error instanceof Error ? error.message : String(error) })}\n`);
  }
}

if (require.main === module) main();

module.exports = { gate };
