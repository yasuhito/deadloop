#!/usr/bin/env node
// Gate one automatic merge on CI checks and CI fallback verification (ADR 0030).
//
// GitHub checks are one health signal. Absence is non-failure, pending waits, unknown stops, and a
// terminal failure is replaced only by fresh CI-equivalent verification of the prospective merge
// tree, bound to exact head, base, tree, command, and policy source. A fallback failure triggers the
// base diagnosis; base blocking suppresses new launches until base or contract changes; base success
// allows exactly one existing-path review repair per episode.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { randomUUID } = require("node:crypto");

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
const { withEnabledDriverLaunch, withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
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

function readLiveManagedPr(env: ReturnType<typeof envConfig>, prNumber: string): JsonObject {
  const pr = commandRunner.runJson([
    "gh", "pr", "view", prNumber, "-R", env.githubRepo,
    "--json", "number,state,isDraft,headRefName,headRefOid,isCrossRepository,labels,comments",
  ]);
  const labels = (pr.labels || []).map((label: JsonObject) => label?.name).filter(Boolean);
  if (String(pr.state || "").toUpperCase() !== "OPEN"
    || !labels.includes(env.inProgressLabel)
    || labels.includes(env.blockedLabel)) {
    throw new Error(`PR #${prNumber} no longer has the active review claim state`);
  }
  return pr;
}

/**
 * Revalidate the managed pull request immediately before each launch stage: same head, active
 * claim, and the attempt's fixed required-verification contract still current.
 */
function revalidateRepairTarget(
  env: ReturnType<typeof envConfig>,
  prNumber: number,
  expectedHead: string,
  enabled: { automationLogin?: string; githubRepositoryId?: string; githubRepo?: string },
): void {
  const authenticated = commandRunner.runText(["gh", "api", "user", "--jq", ".login"]).trim().toLowerCase();
  const enabledLogin = String(enabled?.automationLogin || "").trim().toLowerCase();
  if (!authenticated || !enabledLogin || authenticated !== enabledLogin) {
    throw new Error(`PR #${prNumber} authenticated identity no longer matches enablement authority`);
  }
  const repository = commandRunner.runJson(["gh", "repo", "view", env.githubRepo, "--json", "id,nameWithOwner"]);
  if (String(repository.id || "") !== String(enabled.githubRepositoryId || "")
    || String(repository.nameWithOwner || "") !== String(enabled.githubRepo || "")) {
    throw new Error(`PR #${prNumber} repository identity changed before CI fallback repair`);
  }
  const livePr = readLiveManagedPr(env, String(prNumber));
  if (String(livePr.headRefOid || "").toLowerCase() !== expectedHead.toLowerCase()) {
    throw new Error(`PR #${prNumber} head changed before CI fallback repair launch`);
  }
  if (!env.attemptRecordFile) throw new Error("bound reviewer attempt is missing before CI fallback repair mutation");
  reauthorizeReviewWrite(readAttemptRecord(path.dirname(env.attemptRecordFile)), {
    projectRepo: env.repoPath,
    localConfigPath: process.env.DEADLOOP_CONFIG || path.join(env.stateDir, "projects.json"),
    repositoryId: enabled.githubRepositoryId,
  });
}

function launchCiFallbackRepair(
  env: ReturnType<typeof envConfig>,
  input: { prNumber: number; branch: string; expectedHead: string; findings: JsonObject[]; attemptKey: string },
): JsonObject {
  const dispatch = repairDispatchModule();
  const uuid = randomUUID();
  return withEnabledDriverLaunch(
    env,
    () => {},
    (recheck: () => void) =>
      dispatch.launchRepair(input.prNumber, input.branch, input.expectedHead, input.findings, input.attemptKey, env, recheck, uuid),
    {
      prepareAttempt: () =>
        dispatch.launchRepair(input.prNumber, input.branch, input.expectedHead, input.findings, input.attemptKey, env, undefined, uuid, true),
      recordGithubMutation: () =>
        dispatch.recordRepairLaunchGithubClaim(input.prNumber, input.branch, input.expectedHead, input.findings, input.attemptKey, env, uuid),
      revalidate: (enabled: { automationLogin?: string; githubRepositoryId?: string; githubRepo?: string }) =>
        revalidateRepairTarget(env, input.prNumber, input.expectedHead, enabled),
    },
  );
}

function blockOnLaunchFailure(
  env: ReturnType<typeof envConfig>,
  prNumber: number,
  error: unknown,
): JsonObject {
  const reason = `the automatic CI fallback repair could not be launched: ${error instanceof Error ? error.message : String(error)}`;
  withEnabledDriverLock(env, () => {
    const guardedGithub = createGithubOperations(commandRunner);
    guardedGithub.commentPr(env.githubRepo, prNumber, `## What happened\n- ${reason}.\n- The PR keeps its current head and claim; a person should inspect the CI fallback failure before adding a new Agent request.\n\n## Recovery steps\n1. Run the repository's CI-equivalent check locally against the merged tree.\n2. Fix or update the branch, then add ${env.reviewLabel}.`);
    guardedGithub.movePrLabels(env.githubRepo, prNumber, repairDispatchModule().blockedClaimMove(env));
  });
  return { action: "stop", reason: "ci_fallback_repair_launch_failed" };
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

  // Base healthy: exactly one existing-path review repair per fallback episode.
  const episodeKey = store.episodeKeyFor(env.githubRepo, prNumber, policyBaseRevision, contract.command);
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

  // The episode consumes its one repair even if the launch fails, so repeated failures cannot loop.
  store.writeRepairEpisode(env.stateDir, env.projectId, { ...episode, repairsUsed: 1 });

  if (env.attemptRecordFile && fs.existsSync(path.dirname(String(env.attemptRecordFile)))) {
    closeReviewerWorkspace(env);
  }
  try {
    const launch = launchCiFallbackRepair(env, {
      prNumber,
      branch: String(args.branch),
      expectedHead,
      findings: ciFallbackRepairFindings(verification, contract.command),
      attemptKey: episodeKey,
    });
    const monitorInput = {
      prNumber,
      expectedHeadOid: expectedHead,
      branch: String(args.branch),
      automationDir: env.automationDir,
      promiseFile: launch.promiseFile,
      attemptRecordFile: launch.attemptRecordFile || path.join(path.dirname(String(launch.promiseFile)), "attempt.json"),
      actorName: "review-repair worker",
      projectId: env.projectId,
      repoPath: env.repoPath,
      githubRepo: env.githubRepo,
      stateDir: env.stateDir,
      enabledAt: env.enabledAt,
      reviewLabel: env.reviewLabel,
      implementLabel: env.implementLabel,
      updateBranchLabel: env.updateBranchLabel,
      inProgressLabel: env.inProgressLabel,
      blockedLabel: env.blockedLabel,
      attemptKey: episodeKey,
      maxActiveMilliseconds: env.reviewerMaxRuntimeSeconds * 1000,
    };
    return driverResult("monitor", `Launched CI fallback repair worker for PR #${prNumber}`, {
      driverAction: "ci_fallback_repair_monitor_request",
      monitorHandoff: { kind: "repair", input: monitorInput },
    }) as unknown as JsonObject;
  } catch (error) {
    return blockOnLaunchFailure(env, prNumber, error);
  }
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
