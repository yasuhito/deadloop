#!/usr/bin/env node
// Reconcile the non-atomic GitHub-claim / local-journal boundary without replaying a claim.
const path = require("node:path") as typeof import("node:path");
const { createCommandRunner, driverResult } = require("../../../src/automation-driver-kit.ts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { runHerdrPreflight } = require("../../../src/herdr-preflight.cjs");
const { consumeIssueRequest } = require("../../../src/issue-request-transition.ts");
const { readAttemptRecord, releasePersistedAttemptAuthority, transitionPersistedAttempt } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { assertAttemptProjectBinding, canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");

type JsonObject = Record<string, any>;

function parseArgs(argv: string[]): JsonObject {
  const values: JsonObject = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const name of [
    "attemptRecord", "projectId", "projectRepo", "githubRepo", "stateDir", "enabledAt", "readyLabel", "implementLabel",
    "inProgressLabel", "reviewLabel", "blockedLabel",
  ]) {
    if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return values;
}

function labelNames(item: JsonObject): Set<string> {
  return new Set((item.labels || []).map((label: JsonObject | string) =>
    typeof label === "string" ? label : String(label?.name || "")));
}

function hasExactClaim(record: JsonObject, item: JsonObject, args: JsonObject): boolean {
  const labels = labelNames(item);
  if (record.role === "worker") {
    return String(item.state || "").toUpperCase() === "OPEN"
      && (record.agentRequest || labels.has(String(args.readyLabel)))
      && labels.has(String(args.inProgressLabel))
      && !labels.has(String(args.implementLabel))
      && !labels.has(String(args.blockedLabel));
  }
  const exactPullRequest = String(item.state || "").toUpperCase() === "OPEN"
    && String(item.headRefName || "") === String(record.branch)
    && String(item.headRefOid || "").toLowerCase() === String(record.inputRevision.head).toLowerCase()
    && labels.has(String(args.reviewLabel))
    && labels.has(String(args.inProgressLabel))
    && !labels.has(String(args.blockedLabel));
  if (!exactPullRequest) return false;
  const comments = (item.comments || []).map((comment: JsonObject) => String(comment?.body || ""));
  if (record.role === "branch-update") {
    return comments.some((body: string) => body.includes(
      `head=${String(record.inputRevision.head).toLowerCase()} base=${String(record.inputRevision.base || "").toLowerCase()}`,
    ));
  }
  if (record.role === "review-repair") {
    return comments.some((body: string) => body.includes(
      `deadloop:review-repair-attempt key=${String(record.attemptId).toLowerCase()} head=${String(record.inputRevision.head).toLowerCase()}`,
    ));
  }
  return record.role === "reviewer";
}

function reconcileLocked(
  args: JsonObject,
  runner: ReturnType<typeof createCommandRunner>,
  enabled: { automationLogin?: string } = {},
  recheck: () => void = () => {},
  requestGithub?: ReturnType<typeof createGithubOperations>,
): JsonObject {
  const { runDir } = canonicalAttemptLocation(args);
  const record = readAttemptRecord(runDir);
  assertAttemptProjectBinding(record, args);
  if (record.phase !== "prepared") {
    return driverResult("done", `attempt is already ${record.phase}`, { driverAction: "claim_already_reconciled" });
  }
  const item = record.role === "worker" || record.role === "explorer"
    ? runner.runJson(["gh", "issue", "view", String(record.target.number), "-R", record.repository, "--json", "number,state,labels"])
    : runner.runJson(["gh", "pr", "view", String(record.target.number), "-R", record.repository,
      "--json", "number,state,headRefName,headRefOid,labels,comments"]);
  const labels = labelNames(item);
  if ((record.role === "worker" || record.role === "explorer") && record.agentRequest && !labels.has(String(record.agentRequest.label))) {
    const github = requestGithub || createGithubOperations(runner, recheck);
    const outcome = consumeIssueRequest({
      github,
      repository: String(record.repository),
      issueNumber: Number(record.target.number),
      requestLabel: String(record.agentRequest.label),
      requestEventId: String(record.agentRequest.eventId),
      inProgressLabel: String(args.inProgressLabel),
      blockedLabel: String(args.blockedLabel),
      automationLogin: String(enabled.automationLogin || ""),
      attemptId: String(record.attemptId),
      persistConsumed: () => { throw new Error("prepared attempt has no durable consumption receipt"); },
    });
    releasePersistedAttemptAuthority(runDir, new Date().toISOString(), String(record.agentRequest.eventId), "never_launched");
    return driverResult("done", `prepared Issue request consumption was ${outcome.kind}`, {
      driverAction: outcome.kind === "ambiguous_blocked"
        ? "prepared_request_consumption_ambiguous"
        : `prepared_request_${outcome.kind}`,
    });
  }
  if (record.role === "explorer") {
    return driverResult("done", "prepared exploration retained while its request still awaits consumption", {
      driverAction: "prepared_request_waiting",
    });
  }
  if (!hasExactClaim(record, item, args)) {
    return driverResult("done", "prepared attempt retained because the exact GitHub claim is absent or changed", {
      driverAction: "prepared_claim_blocked",
    });
  }
  const claimed = transitionPersistedAttempt(runDir, "github_claimed");
  return driverResult("done", "prepared attempt GitHub claim reconciled", {
    driverAction: "prepared_claim_reconciled", record: claimed,
  });
}

function reconcile(args: JsonObject): JsonObject {
  const runner = createCommandRunner();
  runHerdrPreflight({ run: (command: string, commandArgs: string[]) => runner.runText([command, ...commandArgs]) });
  const project = {
    id: String(args.projectId), repoPath: path.resolve(String(args.projectRepo)), githubRepo: String(args.githubRepo),
    stateDir: path.resolve(String(args.stateDir)), enabledAt: Number(args.enabledAt),
  };
  return withEnabledDriverLock(project, (enabled: { automationLogin?: string }, recheck: () => void) =>
    reconcileLocked(args, runner, enabled, recheck));
}

function main(): void {
  try { process.stdout.write(`${JSON.stringify(reconcile(parseArgs(process.argv.slice(2))))}\n`); }
  catch (error) {
    process.stdout.write(`${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "exception" }))}\n`);
  }
}
if (require.main === module) main();
module.exports = { hasExactClaim, parseArgs, reconcile, reconcileLocked };
