#!/usr/bin/env node
const path = require("node:path") as typeof import("node:path");
const { hasUncommittedWork, UNCOMMITTED_WORK_STATUS_ARGS } = require("../../../src/agent-scratch-area.cjs");
const { createCommandRunner, createHerdrRunnerFromCommandRunner } = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { readAttemptRecord, recordPersistedCompletionReport, transitionPersistedAttempt } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { validatePromise } = require("./extract-worker-promise.ts");
const { activeIssueRequest, selectIssueClaimWinner } = require("./issue-request-claim.ts");

type JsonObject = Record<string, any>;

function parseArgs(argv: string[]): JsonObject {
  const result: JsonObject = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index].replace(/^--/, "").replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = argv[index + 1];
  return result;
}

function lines(title: string, values: unknown): string[] {
  const list = Array.isArray(values) ? values.map(String).filter(Boolean) : [];
  return [`### ${title}`, ...(list.length ? list.map((value) => `- ${value}`) : ["- None."])];
}

function explorationResultMarker(claim: JsonObject): string {
  return `<!-- deadloop:issue-exploration-result request=${String(claim.binding?.requestEventId || "")} -->`;
}

function renderResult(report: JsonObject, claim?: JsonObject): string {
  const result = report.result || {};
  return [
    "## deadloop exploration", "", report.summary, "", `**Difficulty:** ${result.difficulty}`,
    "", ...lines("Relevant files", result.relevantFiles), "", ...lines("Verified claims", result.verifiedClaims),
    "", ...lines("Disproved claims", result.disprovedClaims), "", ...lines("Open questions", result.openQuestions),
    ...(result.approach ? ["", "### Possible approach", result.approach] : []),
    ...(claim ? ["", explorationResultMarker(claim)] : []),
  ].join("\n");
}

function main(argv = process.argv.slice(2)): JsonObject {
  const args = parseArgs(argv);
  const runDir = path.dirname(String(args.attemptRecord));
  const record = readAttemptRecord(runDir);
  if (record.role !== "explorer" || record.target.kind !== "issue") throw new Error("attempt is not an Issue exploration");
  const validation = validatePromise(record.promiseFile, args.attemptRecord);
  if (!['complete', 'blocked'].includes(validation.status) || validation.evidenceStrength !== "strong") throw new Error(`explorer promise is ${validation.status}`);
  const report = validation.promise;
  const command = createCommandRunner();
  const env = {
    projectId: args.projectId, repoPath: args.projectRepo, githubRepo: args.githubRepo,
    stateDir: args.stateDir, enabledAt: Number(args.enabledAt),
  };
  return withEnabledDriverLock(env, (_enabled: unknown, recheck: () => void) => {
    const github = createGithubOperations(command, recheck);
    const claim = record.reviewClaim;
    const authorize = () => {
      const live = github.getIssue(args.githubRepo, record.target.number);
      const labels = new Set((live.labels || []).map((label: JsonObject | string) => typeof label === "string" ? label : String(label.name || "")));
      if (!labels.has(args.inProgressLabel) || labels.has(args.blockedLabel)) throw new Error("exploration claim is no longer in progress");
      const request = activeIssueRequest(github.listIssueTimelineEvents(args.githubRepo, record.target.number), claim.requestLabel);
      if (String(request?.id || request?.node_id || "") !== String(claim.binding?.requestEventId || "")) throw new Error("exploration request generation changed");
      const comments = github.listIssueComments(args.githubRepo, record.target.number);
      const own = comments.find((comment: JsonObject) => String(comment.id || comment.databaseId || "") === String(claim.commentId || ""));
      const header = github.readRestResponseHeaders(args.githubRepo);
      const date = [...String(header).matchAll(/^date:\s*(.+)$/gim)].at(-1)?.[1]?.trim();
      const now = new Date(date || "");
      if (!own || Number.isNaN(now.getTime())) throw new Error("exploration claim evidence is unverifiable");
      const winner = selectIssueClaimWinner(comments, claim.binding, claim.authorizedLogins || [], now);
      if (String(winner?.id || winner?.databaseId || "") !== String(claim.commentId || "")) throw new Error("exploration claim is no longer the winner");
      return { labels, comments };
    };
    const initial = authorize();
    const runner = createHerdrRunnerFromCommandRunner(command);
    let failed = report.status === "blocked";
    if (record.phase === "agent_started" || record.phase === "report_received") {
      if (record.phase === "agent_started") {
        if (!record.workspaceId) throw new Error("exploration workspace identity is missing");
        runner.closeWorkspace(record.workspaceId);
        if (runner.listWorkspaces().some((workspace: JsonObject) => String(workspace.workspaceId) === record.workspaceId)) throw new Error("exploration workspace closure could not be confirmed");
      }
      const head = command.runText(["git", "-C", record.worktreePath, "rev-parse", "--verify", "HEAD^{commit}"]).trim();
      const status = command.runText(["git", "-C", record.worktreePath, ...UNCOMMITTED_WORK_STATUS_ARGS]);
      const repositoryChanged = head.toLowerCase() !== record.inputRevision.head.toLowerCase() || hasUncommittedWork(status);
      if (record.phase === "agent_started") recordPersistedCompletionReport(runDir, report);
      failed = report.status === "blocked" || repositoryChanged;
      const marker = explorationResultMarker(claim);
      const body = failed
        ? `## deadloop exploration stopped\n\n${repositoryChanged ? "The explorer changed repository files or HEAD, so its result was rejected." : report.result.explanation}\n\nRetry by adding \`${args.exploreLabel}\` again after resolving the cause.\n\n${marker}`
        : renderResult(report, claim);
      if (!initial.comments.some((comment: JsonObject) => String(comment.body || "").includes(marker))) github.createIssueComment(args.githubRepo, record.target.number, body);
      const currentObservation = authorize();
      const current = [...currentObservation.labels].filter((label) => label !== args.inProgressLabel && label !== args.blockedLabel);
      if (failed) current.push(args.blockedLabel);
      github.replaceIssueLabels(args.githubRepo, record.target.number, current);
      transitionPersistedAttempt(runDir, "github_persisted");
    }
    const latest = readAttemptRecord(runDir);
    if (latest.phase === "github_persisted") transitionPersistedAttempt(runDir, "workspace_closed");
    runner.removeWorktree({ repoPath: args.projectRepo, branch: record.branch, worktreePath: record.worktreePath });
    return { action: failed ? "exploration_blocked" : "exploration_persisted", issueNumber: record.target.number };
  });
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main())}\n`); }
  catch (error) { process.stderr.write(`complete-issue-exploration.ts: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}

module.exports = { main, renderResult };
