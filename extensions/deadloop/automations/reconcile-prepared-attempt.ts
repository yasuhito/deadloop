#!/usr/bin/env node
// Reconcile the non-atomic GitHub request-consumption / local-journal boundary without replaying it.
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
    "attemptRecord", "projectId", "projectRepo", "githubRepo", "stateDir", "enabledAt", "readyLabel", "exploreLabel",
    "implementLabel", "inProgressLabel", "reviewLabel", "updateBranchLabel", "blockedLabel",
  ]) {
    if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return values;
}

function labelNames(item: JsonObject): Set<string> {
  return new Set((item.labels || []).map((label: JsonObject | string) =>
    typeof label === "string" ? label : String(label?.name || "")));
}

function hasExactRequestConsumption(record: JsonObject, item: JsonObject, args: JsonObject, events: JsonObject[] = []): boolean {
  const labels = labelNames(item);
  if (record.role === "worker") {
    return String(item.state || "").toUpperCase() === "OPEN"
      && (record.agentRequest || labels.has(String(args.readyLabel)))
      && labels.has(String(args.inProgressLabel))
      && !labels.has(String(args.implementLabel))
      && !labels.has(String(args.blockedLabel));
  }
  const requestBound = record.role === "reviewer" || record.role === "branch-update";
  const exactPullRequest = String(item.state || "").toUpperCase() === "OPEN"
    && String(item.headRefName || "") === String(record.branch)
    && String(item.headRefOid || "").toLowerCase() === String(record.inputRevision.head).toLowerCase()
    && labels.has(String(args.inProgressLabel))
    && !labels.has(String(args.blockedLabel))
    && (!requestBound || (
      !labels.has(String(args.implementLabel))
      && !labels.has(String(args.reviewLabel))
      && !labels.has(String(args.updateBranchLabel))
    ));
  if (!exactPullRequest) return false;
  if (requestBound
    && !events.some((event) => String(event.id || event.node_id || "") === String(record.requestEventId || ""))) return false;
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
      automationLogins: [...new Set([
        ...String(args.automationLogins || "").split(",").map((value: string) => value.trim().toLowerCase()),
        String(enabled.automationLogin || "").trim().toLowerCase(),
      ].filter(Boolean))],
      requestLabels: [String(args.exploreLabel), String(args.implementLabel)],
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
  // A prepared Issue attempt whose bound request label is still live consumed nothing. The only
  // GitHub write that can precede consumption is the idempotent recovery-block removal, and the
  // active state is created after the request is gone, so nothing depends on this journal. Releasing
  // exactly this phase is what lets the next cycle move: the Issue becomes selectable again with its
  // request intact, instead of a workspace-less prepared record that stops all scheduling. An active
  // state beside a live request is not this attempt's, and a workspace means the attempt got further,
  // so both of those stay retained.
  if ((record.role === "worker" || record.role === "explorer") && record.agentRequest
    && !record.workspaceId && !labels.has(String(args.inProgressLabel))) {
    releasePersistedAttemptAuthority(runDir, new Date().toISOString(), String(record.agentRequest.eventId), "never_launched");
    return driverResult("done", "prepared Issue attempt released because its Agent request is still waiting", {
      driverAction: "prepared_request_released",
    });
  }
  if (record.role === "explorer") {
    return driverResult("done", "prepared exploration retained while its request still awaits consumption", {
      driverAction: "prepared_request_waiting",
    });
  }
  const events = record.role === "worker" ? [] : runner.runJson([
    "gh", "api", "--paginate", "--slurp", `repos/${record.repository}/issues/${record.target.number}/events`,
  ]).flat();
  if (!hasExactRequestConsumption(record, item, args, events)) {
    return driverResult("done", "prepared attempt retained because the exact GitHub request consumption is absent or changed", {
      driverAction: "prepared_request_consumption_blocked",
    });
  }
  if (record.role === "reviewer" || record.role === "branch-update") {
    return driverResult("done", "prepared request-bound attempt retained because the confirmed HTTP 200 result was not durably phase-advanced", {
      driverAction: "prepared_request_consumption_blocked",
    });
  }
  const consumed = transitionPersistedAttempt(runDir, "github_claimed");
  return driverResult("done", "prepared attempt GitHub request consumption reconciled", {
    driverAction: "prepared_request_consumption_reconciled", record: consumed,
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
module.exports = { hasExactRequestConsumption, parseArgs, reconcile, reconcileLocked };
