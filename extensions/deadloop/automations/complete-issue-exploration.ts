#!/usr/bin/env node
const path = require("node:path") as typeof import("node:path");
const { createCommandRunner, createHerdrRunnerFromCommandRunner } = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { readAttemptRecord, recordPersistedCompletionReport, transitionPersistedAttempt } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { validatePromise } = require("./extract-worker-promise.ts");
const { activeIssueRequest } = require("./issue-request-claim.ts");

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

function renderResult(report: JsonObject): string {
  const result = report.result || {};
  return [
    "## deadloop exploration", "", report.summary, "", `**Difficulty:** ${result.difficulty}`,
    "", ...lines("Relevant files", result.relevantFiles), "", ...lines("Verified claims", result.verifiedClaims),
    "", ...lines("Disproved claims", result.disprovedClaims), "", ...lines("Open questions", result.openQuestions),
    ...(result.approach ? ["", "### Possible approach", result.approach] : []),
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
  const head = command.runText(["git", "-C", record.worktreePath, "rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const dirty = command.runText(["git", "-C", record.worktreePath, "status", "--porcelain"]).trim();
  const repositoryChanged = head.toLowerCase() !== record.inputRevision.head.toLowerCase() || Boolean(dirty);
  const env = {
    projectId: args.projectId, repoPath: args.projectRepo, githubRepo: args.githubRepo,
    stateDir: args.stateDir, enabledAt: Number(args.enabledAt),
  };
  return withEnabledDriverLock(env, (_enabled: unknown, recheck: () => void) => {
    const github = createGithubOperations(command, recheck);
    const live = github.getIssue(args.githubRepo, record.target.number);
    const labels = new Set((live.labels || []).map((label: JsonObject | string) => typeof label === "string" ? label : String(label.name || "")));
    if (!labels.has(args.inProgressLabel)) throw new Error("exploration claim is no longer in progress");
    const claim = record.reviewClaim;
    const request = activeIssueRequest(github.listIssueTimelineEvents(args.githubRepo, record.target.number), claim.requestLabel);
    if (String(request?.id || request?.node_id || "") !== String(claim.binding?.requestEventId || "")) throw new Error("exploration request generation changed");
    recordPersistedCompletionReport(runDir, report);
    const failed = report.status === "blocked" || repositoryChanged;
    const body = failed
      ? `## deadloop exploration stopped\n\n${repositoryChanged ? "The explorer changed repository files or HEAD, so its result was rejected." : report.result.explanation}\n\nRetry by adding \`${args.exploreLabel}\` again after resolving the cause.`
      : renderResult(report);
    github.createIssueComment(args.githubRepo, record.target.number, body);
    const current = [...labels].filter((label) => label !== args.inProgressLabel && label !== args.blockedLabel);
    if (failed) current.push(args.blockedLabel);
    github.replaceIssueLabels(args.githubRepo, record.target.number, current);
    transitionPersistedAttempt(runDir, "github_persisted");
    const runner = createHerdrRunnerFromCommandRunner(command);
    if (!record.workspaceId) throw new Error("exploration workspace identity is missing");
    runner.closeWorkspace(record.workspaceId);
    if (runner.listWorkspaces().some((workspace: JsonObject) => String(workspace.workspaceId) === record.workspaceId)) {
      throw new Error("exploration workspace closure could not be confirmed");
    }
    transitionPersistedAttempt(runDir, "workspace_closed");
    runner.removeWorktree({ repoPath: args.projectRepo, branch: record.branch, worktreePath: record.worktreePath });
    return { action: failed ? "exploration_blocked" : "exploration_persisted", issueNumber: record.target.number, repositoryChanged };
  });
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main())}\n`); }
  catch (error) { process.stderr.write(`complete-issue-exploration.ts: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}

module.exports = { main, renderResult };
