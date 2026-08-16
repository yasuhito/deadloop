#!/usr/bin/env node
const path = require("node:path") as typeof import("node:path");
const { hasUncommittedWork, UNCOMMITTED_WORK_STATUS_ARGS } = require("../../../src/agent-scratch-area.cjs");
const { createCommandRunner, createHerdrRunnerFromCommandRunner } = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { readAttemptRecord, recordPersistedCompletionReport, transitionPersistedAttempt } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { validatePromise } = require("./extract-worker-promise.ts");
const {
  activeIssueRequest,
  changedIssueRequestLabels,
  compareIssueEvents,
  issueLabelState,
  issueRequestVersions,
  observeIssueRequestLabels,
  selectIssueClaimWinner,
} = require("./issue-request-claim.ts");

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

function trustedExplorationResultComment(comments: JsonObject[], claim: JsonObject, expectedBody: string): JsonObject | null {
  const authorized = new Set((claim.authorizedLogins || []).map((login: unknown) => String(login).toLowerCase()));
  return comments.find((comment) => {
    const login = String(comment.author?.login || comment.user?.login || "").toLowerCase();
    const created = String(comment.createdAt || comment.created_at || "");
    const updated = String(comment.updatedAt || comment.updated_at || "");
    return Boolean(login) && authorized.has(login) && Boolean(created) && created === updated
      && String(comment.body || "") === expectedBody;
  }) || null;
}

function eventTime(event: JsonObject | null | undefined): number {
  return Date.parse(String(event?.created_at || event?.createdAt || ""));
}

function failedRequestStateIsRecoverable(observation: { labels: Set<string>; events: JsonObject[] }, requestLabels: string[], blockedLabel: string): boolean {
  const blocks = observation.events.filter((event) => String(event.event || "").toLowerCase() === "labeled"
    && String(event.label?.name || "") === blockedLabel).sort((left, right) => eventTime(left) - eventTime(right));
  const latestBlock = blocks.at(-1);
  if (!latestBlock) return false;
  return requestLabels.filter((label) => observation.labels.has(label)).every((label) => {
    const request = activeIssueRequest(observation.events, label);
    return Boolean(request) && compareIssueEvents(request, latestBlock) > 0;
  });
}

function hasExplorationPersistenceProof(
  observation: { labels: Set<string>; events: JsonObject[]; comments: JsonObject[] },
  claim: JsonObject,
  expectedBody: string,
  failed: boolean,
  labels: { inProgress: string; blocked: string; requests?: string[] },
): boolean {
  const boundRequest = observation.events.find((event) => String(event.id || event.node_id || "") === String(claim.binding?.requestEventId || ""));
  const latestRequest = activeIssueRequest(observation.events, claim.requestLabel);
  const requestLabels = labels.requests || [];
  const requestStateMatches = requestLabels.every((label) => observation.labels.has(label) === issueLabelState(observation.events, label).active);
  return Boolean(boundRequest) && eventTime(latestRequest) >= eventTime(boundRequest)
    && !observation.labels.has(labels.inProgress)
    && observation.labels.has(labels.blocked) === failed
    && requestStateMatches
    && (!failed || failedRequestStateIsRecoverable(observation, requestLabels, labels.blocked))
    && Boolean(trustedExplorationResultComment(observation.comments, claim, expectedBody));
}

function closeExplorationWorkspace(record: JsonObject, runner: JsonObject): void {
  if (!record.workspaceId) throw new Error("exploration workspace identity is missing");
  const workspaces = runner.listWorkspaces();
  const exact = workspaces.find((workspace: JsonObject) => String(workspace.workspaceId) === String(record.workspaceId));
  if (exact && path.resolve(String(exact.worktreePath || "")) !== path.resolve(record.worktreePath)) {
    throw new Error("exploration workspace identity points to another checkout");
  }
  if (exact) runner.closeWorkspace(record.workspaceId);
  const remaining = runner.listWorkspaces();
  if (remaining.some((workspace: JsonObject) => String(workspace.workspaceId) === String(record.workspaceId)
    || (workspace.worktreePath && path.resolve(workspace.worktreePath) === path.resolve(record.worktreePath)))) {
    throw new Error("exploration workspace closure could not be confirmed");
  }
  const occupied = runner.listAgents().some((agent: JsonObject) => {
    const cwd = typeof agent.cwd === "string" ? path.resolve(agent.cwd) : "";
    const relative = cwd ? path.relative(path.resolve(record.worktreePath), cwd) : "";
    return agent.name === record.agentName || agent.workspaceId === record.workspaceId || agent.workspace_id === record.workspaceId
      || (Boolean(cwd) && (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))));
  });
  if (occupied) throw new Error("exploration workspace is absent but its agent still occupies the checkout");
}

function removeExplorationWorktree(record: JsonObject, repoPath: string, runner: JsonObject): void {
  const worktrees = runner.listWorktrees(repoPath);
  const expectedPath = path.resolve(record.worktreePath);
  const branchMatches = worktrees.filter((worktree: JsonObject) => String(worktree.branch || "") === String(record.branch));
  const pathMatches = worktrees.filter((worktree: JsonObject) => typeof worktree.path === "string" && path.resolve(worktree.path) === expectedPath);
  if (!branchMatches.length && !pathMatches.length) return;
  const exact = worktrees.filter((worktree: JsonObject) => String(worktree.branch || "") === String(record.branch)
    && typeof worktree.path === "string" && path.resolve(worktree.path) === expectedPath);
  if (exact.length !== 1 || branchMatches.length !== 1 || pathMatches.length !== 1) {
    throw new Error("exploration worktree identity is ambiguous");
  }
  runner.removeWorktree({ repoPath, branch: record.branch, worktreePath: record.worktreePath });
  const remaining = runner.listWorktrees(repoPath);
  if (remaining.some((worktree: JsonObject) => String(worktree.branch || "") === String(record.branch)
    || (typeof worktree.path === "string" && path.resolve(worktree.path) === expectedPath))) {
    throw new Error("exploration worktree removal could not be confirmed");
  }
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
    if (!claim?.binding?.requestEventId || !claim.requestLabel) throw new Error("exploration claim contract is missing");
    const observe = () => ({
      ...observeIssueRequestLabels(github, args.githubRepo, record.target.number),
      comments: github.listIssueComments(args.githubRepo, record.target.number),
    });
    const authorize = (observation = observe()) => {
      if (!observation.labels.has(args.inProgressLabel) || observation.labels.has(args.blockedLabel)) throw new Error("exploration claim is no longer in progress");
      const request = activeIssueRequest(observation.events, claim.requestLabel);
      if (String(request?.id || request?.node_id || "") !== String(claim.binding.requestEventId)) throw new Error("exploration request generation changed");
      const own = observation.comments.find((comment: JsonObject) => String(comment.id || comment.databaseId || "") === String(claim.commentId || ""));
      const header = github.readRestResponseHeaders(args.githubRepo);
      const date = [...String(header).matchAll(/^date:\s*(.+)$/gim)].at(-1)?.[1]?.trim();
      const now = new Date(date || "");
      if (!own || Number.isNaN(now.getTime())) throw new Error("exploration claim evidence is unverifiable");
      const winner = selectIssueClaimWinner(observation.comments, claim.binding, claim.authorizedLogins || [], now);
      if (String(winner?.id || winner?.databaseId || "") !== String(claim.commentId || "")) throw new Error("exploration claim is no longer the winner");
      return observation;
    };
    const runner = createHerdrRunnerFromCommandRunner(command);
    let failed = report.status === "blocked";
    if (record.phase === "agent_started" || record.phase === "report_received") {
      if (record.phase === "agent_started") {
        authorize();
        closeExplorationWorkspace(record, runner);
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
      let observation = observe();
      const requestLabels = [args.exploreLabel, args.implementLabel];
      const proofLabels = { inProgress: args.inProgressLabel, blocked: args.blockedLabel, requests: requestLabels };
      if (!hasExplorationPersistenceProof(observation, claim, body, failed, proofLabels)) {
        authorize(observation);
        if (!trustedExplorationResultComment(observation.comments, claim, body)) {
          github.createIssueComment(args.githubRepo, record.target.number, body);
        }
        observation = authorize();
        const versionsBefore = issueRequestVersions(observation.events, requestLabels);
        const current = [...observation.labels].filter((label) => label !== args.inProgressLabel && label !== args.blockedLabel
          && (!failed || !requestLabels.includes(label)));
        if (failed) current.push(args.blockedLabel);
        github.replaceIssueLabels(args.githubRepo, record.target.number, current);
        observation = observe();
        const changedRequests = changedIssueRequestLabels(versionsBefore, observation.events);
        if (changedRequests.length) {
          const activeChanged = changedRequests.filter((label) => issueLabelState(observation.events, label).active);
          const cancelledChanged = changedRequests.filter((label) => !issueLabelState(observation.events, label).active);
          github.moveIssueLabels(args.githubRepo, record.target.number, {
            remove: cancelledChanged.filter((label) => observation.labels.has(label)),
            add: activeChanged.filter((label) => !observation.labels.has(label)),
          });
          observation = observe();
        }
        if (changedRequests.some((label) => observation.labels.has(label) !== issueLabelState(observation.events, label).active)) {
          throw new Error("exploration raced request reconciliation could not be proven");
        }
        if (!hasExplorationPersistenceProof(observation, claim, body, failed, proofLabels)) {
          throw new Error("exploration GitHub persistence could not be proven");
        }
      }
      transitionPersistedAttempt(runDir, "github_persisted");
    }
    const latest = readAttemptRecord(runDir);
    if (latest.phase === "github_persisted") transitionPersistedAttempt(runDir, "workspace_closed");
    removeExplorationWorktree(record, args.projectRepo, runner);
    return { action: failed ? "exploration_blocked" : "exploration_persisted", issueNumber: record.target.number };
  });
}

if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(main())}\n`); }
  catch (error) { process.stderr.write(`complete-issue-exploration.ts: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}

module.exports = {
  closeExplorationWorkspace,
  hasExplorationPersistenceProof,
  main,
  removeExplorationWorktree,
  renderResult,
  trustedExplorationResultComment,
};
