#!/usr/bin/env node
// Deterministic issue-coordinator driver. CommonJS-shaped so it can run directly
// under this package's `type: commonjs`, matching launch-agent.ts.

const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");
const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
const { decisionForIssues, planIssueCoordinatorAction } = require("./issue-coordinator-flow.ts");
const { hasUncommittedWork, UNCOMMITTED_WORK_STATUS_ARGS } = require("../../../src/agent-scratch-area.cjs");
const { withDispatchLock } = require("../../../src/dispatch-lock.cjs");
const { issueDecisionDeadline } = require("./issue-coordinator-decisions.ts");
const { renderIssueExplorerPrompt, renderIssuePlanningComment, renderIssueWorkerPrompt } = require("../../../src/issue-coordinator-renderers.ts");
const {
  applyIssueRequiredVerificationStop,
  planIssueRequiredVerificationStop,
} = require("../../../src/issue-required-verification-stop.ts");
const {
  activeIssueRequest,
  changedIssueRequestLabels,
  claimedIssueRequestGenerationIsCurrent,
  compareIssueEvents,
  issueLabelState,
  issueRequestRevision,
  issueRequestVersions,
  observeIssueRequestLabels,
  renderIssueClaimComment,
  selectIssueClaimWinner,
} = require("./issue-request-claim.ts");
const { launchAgentFlow, prepareAgentLaunchFlow, recordAgentLaunchGithubClaimed } = require("../../../src/agent-launch-flow.ts");
const { renderProjectCheckCommand } = require("../../../src/project-check.ts");
const { renderIssueMonitorPrompt } = require("../../../src/monitor-prompts.ts");
const {
  createCommandRunner,
  createHerdrRunnerFromCommandRunner,
  driverResult,
  loadFixture,
  parseFixtureArg,
} = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { withEnabledDriverLaunch, withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { runHerdrPreflight } = require("../../../src/herdr-preflight.cjs");
const { StaleLaunchError, assertSameLaunchTarget, isStaleLaunchError } = require("../../../src/launch-revalidation.ts");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { assertCurrentWorkerContract, requiredVerificationBinding } = require("../../../src/worker-required-verification-runtime.cjs");

import type { DriverResult, JsonObject } from "../../../src/automation-driver-kit";

const SCRIPT_DIR = __dirname;
const CLEANUP_SCRIPT = path.join(SCRIPT_DIR, "cleanup-completed-worker-worktrees.ts");
const commandRunner = createCommandRunner();
const { runText, runJson } = commandRunner;

function herdrRunner() {
  return createHerdrRunnerFromCommandRunner(commandRunner);
}

function githubOperations(beforeMutation?: () => void) {
  return createGithubOperations(commandRunner, beforeMutation);
}

function cleanupPlan(fixture: JsonObject | null): JsonObject {
  if (fixture) return { ...(fixture.cleanup || { candidates: [] }) };
  return runJson(["node", CLEANUP_SCRIPT, "--plan", "--json"]);
}

function applyCleanup(plan: JsonObject, fixture: JsonObject | null): JsonObject {
  if (fixture) return { ...plan, appliedFromFixture: true };
  return runJson(["node", CLEANUP_SCRIPT, "--apply", "--json"]);
}

function issueList(fixture: JsonObject | null, repo: string): JsonObject[] {
  if (fixture) return (fixture.issues || []).filter((issue: unknown) => issue && typeof issue === "object");
  return githubOperations().listOpenIssues(repo);
}

function gateMissingContractComment(issue: JsonObject): string {
  return [
    "deadloop skipped automated implementation because the issue is missing an implementation contract.",
    "",
    "Missing:",
    "- `## Agent Brief` or `## What to build`",
    "- `## Acceptance criteria`",
    "",
    `Update the issue body, then add \`agent:implement\` again. Target: #${issue.number}`,
  ].join("\n");
}

function applyIssueTransition(
  issue: JsonObject,
  expectedKind: "contract_missing" | "planning_blocked" | "worker_required",
  env: ReturnType<typeof envConfig>,
  fixture: JsonObject | null,
  mutate: (github: ReturnType<typeof githubOperations>, live: JsonObject) => void,
): boolean {
  if (fixture) return true;
  try {
    return withEnabledDriverLock(env, (_enabled: unknown, recheck: () => void) => {
      const github = githubOperations(recheck);
      const live = github.getIssue(env.githubRepo, issue.number);
      if (String(live.state || "").toUpperCase() !== "OPEN") throw new StaleLaunchError(`Issue #${issue.number} is no longer open`);
      assertSameLaunchTarget(issue, live, "issue");
      const livePlan = planIssueCoordinatorAction(
        [live],
        decisionForIssues(undefined, [live], env.githubRepo, env),
      );
      if (livePlan.kind !== expectedKind || Number(livePlan.issue.number) !== Number(issue.number)) {
        throw new StaleLaunchError(`Issue #${issue.number} transition changed`);
      }
      claimIssueRequest(github, live, env, "worker", _enabled as { automationLogin?: string; githubRepositoryId?: string });
      mutate(github, github.getIssue(env.githubRepo, issue.number));
      return true;
    });
  } catch (error) {
    if (isStaleLaunchError(error)) return false;
    throw error;
  }
}

function applyContractMissing(issue: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null): boolean {
  return applyIssueTransition(issue, "contract_missing", env, fixture, (github, live) => {
    const number = String(live.number);
    github.moveIssueLabels(env.githubRepo, number, { remove: env.inProgressLabel, add: env.blockedLabel });
    github.commentIssue(env.githubRepo, number, gateMissingContractComment(live));
  });
}

function blockedComment(_issue: JsonObject, env: ReturnType<typeof envConfig>): string {
  return renderIssuePlanningComment({
    githubRepo: env.githubRepo,
    blockedLabel: env.blockedLabel,
    readyLabel: env.readyLabel,
    implementLabel: env.implementLabel,
  });
}

function applyBlocked(issue: JsonObject, env: ReturnType<typeof envConfig>, comment: string, fixture: JsonObject | null): boolean {
  return applyIssueTransition(issue, "planning_blocked", env, fixture, (github, live) => {
    const number = String(live.number);
    github.moveIssueLabels(env.githubRepo, number, { remove: env.inProgressLabel, add: env.blockedLabel });
    github.commentIssue(env.githubRepo, number, comment);
  });
}

function issueLabelNames(issue: JsonObject): string[] {
  return (issue.labels || []).map((label: JsonObject | string) => typeof label === "string" ? label : String(label.name || "")).filter(Boolean);
}

function issueRecoverySelectionView(
  issues: JsonObject[], env: Pick<ReturnType<typeof envConfig>, "blockedLabel" | "exploreLabel" | "implementLabel">,
  readEvents: (number: number) => JsonObject[],
): JsonObject[] {
  return issues.map((issue) => {
    const labels = issueLabelNames(issue);
    const requests = [env.exploreLabel, env.implementLabel].filter((label) => labels.includes(label));
    if (!labels.includes(env.blockedLabel) || !requests.length) return issue;
    const events = readEvents(Number(issue.number));
    const blocks = events.filter((event) => String(event.event || "").toLowerCase() === "labeled"
      && String(event.label?.name || "") === env.blockedLabel).sort(compareIssueEvents);
    const block = blocks.at(-1);
    const valid = new Set(requests.filter((label) => {
      const state = issueLabelState(events, label);
      return Boolean(block && state.active && state.event && compareIssueEvents(state.event, block) > 0);
    }));
    return { ...issue, labels: (issue.labels || []).filter((label: JsonObject | string) => {
      const name = typeof label === "string" ? label : String(label.name || "");
      return !requests.includes(name) || valid.has(name);
    }) };
  });
}

function claimIssueRequest(
  github: ReturnType<typeof githubOperations>, issue: JsonObject, env: ReturnType<typeof envConfig>,
  role: "explorer" | "worker", enabledIdentity: { automationLogin?: string; githubRepositoryId?: string } = {},
): JsonObject {
  const number = Number(issue.number);
  const requestLabel = role === "explorer" ? env.exploreLabel : env.implementLabel;
  const repositoryId = enabledIdentity.githubRepositoryId || env.githubRepositoryId;
  const automationLogin = String(enabledIdentity.automationLogin || env.automationLogin).trim().toLowerCase();
  const authorizedLogins = [...new Set([...env.authorizedAutomationLogins, automationLogin].filter(Boolean))];
  const repository = github.getRepositoryIdentity(env.githubRepo);
  if (!repositoryId || String(repository.id) !== repositoryId) throw new Error("Issue claim repository identity is unavailable or changed");
  const events = github.listIssueTimelineEvents(env.githubRepo, number);
  const request = activeIssueRequest(events, requestLabel);
  if (!request) throw new StaleLaunchError(`Issue #${number} has no ${requestLabel} request event`);
  const labelsBeforeClaim = new Set(issueLabelNames(issue));
  if (labelsBeforeClaim.has(env.blockedLabel)) {
    const blocks = events.filter((event: JsonObject) => String(event.event || "").toLowerCase() === "labeled"
      && String(event.label?.name || "") === env.blockedLabel);
    blocks.sort(compareIssueEvents);
    const latestBlock = blocks.at(-1);
    if (!latestBlock || compareIssueEvents(request, latestBlock) <= 0) {
      throw new StaleLaunchError(`Issue #${number} request does not follow the latest block`);
    }
  }
  const authenticated = runText(["gh", "api", "user", "--jq", ".login"]).trim().toLowerCase();
  if (!authenticated || authenticated !== automationLogin || !authorizedLogins.includes(authenticated)) {
    throw new Error("authenticated GitHub identity is not authorized to claim Issue requests");
  }
  const authoritySeconds = env.requestMaxRuntimeSeconds + env.claimCleanupGraceSeconds;
  const managedLabels = [env.exploreLabel, env.implementLabel, env.inProgressLabel, env.blockedLabel];
  const binding = {
    repositoryId, repository: env.githubRepo, targetNumber: number,
    requestEventId: String(request.id || request.node_id), role,
    revision: issueRequestRevision(request), owner: env.claimOwner,
    authority: { durationSeconds: authoritySeconds },
    activeState: { managedLabels, requestLabel, requiredLabels: [env.inProgressLabel] },
  };
  const posted = github.createIssueComment(env.githubRepo, number, renderIssueClaimComment(binding));
  const comments = github.listIssueComments(env.githubRepo, number);
  const own = comments.find((comment: JsonObject) => String(comment.id || comment.databaseId) === String(posted.id || posted.databaseId));
  const dateHeader = github.readRestResponseHeaders(env.githubRepo);
  const dateValue = [...String(dateHeader).matchAll(/^date:\s*(.+)$/gim)].at(-1)?.[1]?.trim();
  const serverNow = new Date(dateValue || "");
  if (!own || Number.isNaN(serverNow.getTime())) throw new Error("Issue claim GitHub evidence is unverifiable");
  const winner = selectIssueClaimWinner(comments, binding, authorizedLogins, serverNow);
  if (String(winner?.id || winner?.databaseId || "") !== String(posted.id || posted.databaseId || "")) {
    throw new Error(`Issue #${number} ${requestLabel} request was claimed by another Automation host`);
  }
  const before = github.getIssue(env.githubRepo, number);
  assertSameLaunchTarget(issue, before, "issue");
  const requestLabels = [env.exploreLabel, env.implementLabel];
  const mutationObservation = observeIssueRequestLabels(github, env.githubRepo, number);
  const versionsBefore = issueRequestVersions(mutationObservation.events, requestLabels);
  if (!claimedIssueRequestGenerationIsCurrent(mutationObservation, requestLabel, binding.requestEventId)) {
    throw new StaleLaunchError(`Issue #${number} received a newer ${requestLabel} request before claim mutation`);
  }
  const labels = [...mutationObservation.labels];
  const next = labels.filter((label) => label !== requestLabel && label !== env.blockedLabel && label !== env.inProgressLabel);
  next.push(env.inProgressLabel);
  github.replaceIssueLabels(env.githubRepo, number, next);
  let after = github.getIssue(env.githubRepo, number);
  let afterLabels = new Set(issueLabelNames(after));
  let eventsAfter = github.listIssueTimelineEvents(env.githubRepo, number);
  const changedRequests = changedIssueRequestLabels(versionsBefore, eventsAfter);
  if (changedRequests.length) {
    const activeChanged = changedRequests.filter((label) => issueLabelState(eventsAfter, label).active);
    const cancelledChanged = changedRequests.filter((label) => !issueLabelState(eventsAfter, label).active);
    github.moveIssueLabels(env.githubRepo, number, {
      remove: [afterLabels.has(env.inProgressLabel) ? env.inProgressLabel : "", ...cancelledChanged].filter(Boolean),
      add: activeChanged.filter((label) => !afterLabels.has(label)),
    });
    after = github.getIssue(env.githubRepo, number);
    afterLabels = new Set(issueLabelNames(after));
    eventsAfter = github.listIssueTimelineEvents(env.githubRepo, number);
    const unresolved = changedRequests.filter((label) => afterLabels.has(label) !== issueLabelState(eventsAfter, label).active);
    if (afterLabels.has(env.inProgressLabel) || unresolved.length) throw new Error(`Issue #${number} raced request release could not be proven`);
    throw new StaleLaunchError(`Issue #${number} Agent request changed during claim`);
  }
  const latestRequest = activeIssueRequest(eventsAfter, requestLabel);
  if (String(latestRequest?.id || latestRequest?.node_id || "") !== binding.requestEventId
    || !afterLabels.has(env.inProgressLabel) || afterLabels.has(requestLabel)) {
    throw new StaleLaunchError(`Issue #${number} request claim did not persist exactly`);
  }
  return {
    binding, commentId: String(posted.id || posted.databaseId), authorizedLogins,
    automationLogin, authoritySeconds, requestLabel,
    inProgressLabel: env.inProgressLabel, blockedLabel: env.blockedLabel,
  };
}

function parsedRequiredVerificationResolution(env: ReturnType<typeof envConfig>): JsonObject | null {
  if (!env.requiredVerificationResolution) return null;
  let resolution: JsonObject;
  try { resolution = JSON.parse(env.requiredVerificationResolution); }
  catch { throw new Error("DEADLOOP_REQUIRED_VERIFICATION_RESOLUTION must be valid JSON"); }
  if (resolution.status !== "resolved" && resolution.status !== "blocked") {
    throw new Error("DEADLOOP_REQUIRED_VERIFICATION_RESOLUTION has an invalid status");
  }
  return resolution;
}

function applyRequiredVerificationStop(
  issue: JsonObject,
  env: ReturnType<typeof envConfig>,
  resolution: JsonObject,
  fixture: JsonObject | null,
): { applied: boolean; comment?: string; fingerprint?: string } {
  let result: { applied: boolean; comment?: string; fingerprint?: string } = { applied: false };
  const applied = applyIssueTransition(issue, "worker_required", env, fixture, (github, live) => {
    const plan = planIssueRequiredVerificationStop({
      issue: live,
      resolution,
      phase: "before_launch",
      labels: { implement: env.implementLabel, inProgress: env.inProgressLabel, blocked: env.blockedLabel },
    });
    applyIssueRequiredVerificationStop(github, env.githubRepo, live.number, plan);
    result = { applied: true, ...(plan.comment ? { comment: plan.comment } : {}), fingerprint: plan.fingerprint };
  });
  if (fixture && applied) {
    const plan = planIssueRequiredVerificationStop({
      issue,
      resolution,
      phase: "before_launch",
      labels: { implement: env.implementLabel, inProgress: env.inProgressLabel, blocked: env.blockedLabel },
    });
    result = { applied: true, ...(plan.comment ? { comment: plan.comment } : {}), fingerprint: plan.fingerprint };
  }
  return applied ? result : { applied: false };
}

function requiredVerificationStopFingerprint(issue: JsonObject): string | undefined {
  const issueNumber = Number(issue.number);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) return undefined;
  const marker = new RegExp(`<!-- deadloop:required-verification-blocked:v1 target=issue-${issueNumber} fingerprint=([0-9a-f]{64}) -->`);
  for (const comment of issue.comments || []) {
    const match = marker.exec(String(comment?.body || ""));
    if (match) return match[1];
  }
  return undefined;
}

function isExactDurableRequiredVerificationStop(
  issue: JsonObject,
  env: ReturnType<typeof envConfig>,
): boolean {
  const names = new Set((issue.labels || []).map((label: JsonObject | string) => typeof label === "string" ? label : String(label?.name || "")));
  return String(issue.state || "").toUpperCase() === "OPEN"
    && names.has(env.readyLabel)
    && names.has(env.blockedLabel)
    && !names.has(env.implementLabel)
    && !names.has(env.inProgressLabel)
    && requiredVerificationStopFingerprint(issue) !== undefined;
}

function resumeRequiredVerificationStop(
  issue: JsonObject,
  env: ReturnType<typeof envConfig>,
  fingerprint: string,
): { fingerprint: string } {
  return withEnabledDriverLock(env, (_enabled: unknown, recheck: () => void) => {
    const github = githubOperations(recheck);
    const live = github.getIssue(env.githubRepo, issue.number);
    if (String(live.state || "").toUpperCase() !== "OPEN" || requiredVerificationStopFingerprint(live) !== fingerprint) {
      throw new StaleLaunchError(`Issue #${issue.number} required-verification stop changed`);
    }
    const names = new Set((live.labels || []).map((label: JsonObject | string) => typeof label === "string" ? label : String(label?.name || "")));
    applyIssueRequiredVerificationStop(github, env.githubRepo, live.number, {
      removeLabels: [env.implementLabel, env.inProgressLabel].filter((label) => names.has(label)),
      addLabels: names.has(env.blockedLabel) ? [] : [env.blockedLabel],
      fingerprint,
    });
    return { fingerprint };
  });
}

function slugForBranch(value: unknown): string {
  const slug = String(value || "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "task";
}

function shouldSimulateLaunch(fixture: JsonObject | null): boolean {
  return Boolean(fixture);
}

type AbandonedWorkerCheckout = {
  branch: string;
  worktreePath: string;
  inputHead: string;
  abandonedAt: string;
  workspaceId: string;
  agentName: string;
};

function abandonedWorkerCheckout(issueNumber: number, env: ReturnType<typeof envConfig>): AbandonedWorkerCheckout | null {
  const runsRoot = path.join(env.stateDir, "runs");
  let entries: string[];
  try { entries = fs.readdirSync(runsRoot); } catch { return null; }
  const candidates: AbandonedWorkerCheckout[] = [];
  for (const entry of entries) {
    const runDir = path.join(runsRoot, entry);
    if (!fs.existsSync(path.join(runDir, "attempt.json"))) continue;
    const record = readAttemptRecord(runDir);
    if (record.project !== env.projectId || record.repository !== env.githubRepo || record.role !== "worker"
      || record.target?.kind !== "issue" || record.target.number !== issueNumber || record.phase !== "abandoned") continue;
    candidates.push({
      branch: record.branch,
      worktreePath: record.worktreePath,
      inputHead: record.inputRevision.head,
      abandonedAt: record.abandonment.abandonedAt,
      workspaceId: record.workspaceId,
      agentName: record.agentName,
    });
  }
  if (!candidates.length) return null;
  const identities = new Set(candidates.map((candidate) =>
    `${candidate.branch}\0${path.resolve(candidate.worktreePath)}\0${candidate.inputHead.toLowerCase()}`));
  if (identities.size !== 1) throw new Error(`Issue #${issueNumber} has conflicting abandoned Worker checkouts`);
  return candidates.sort((left, right) => Date.parse(right.abandonedAt) - Date.parse(left.abandonedAt))[0];
}

function assertRecoverableWorkerCheckout(
  checkout: AbandonedWorkerCheckout,
  env: ReturnType<typeof envConfig>,
  ops: { runner: ReturnType<typeof herdrRunner>; runText: (args: string[]) => string },
): void {
  const expectedPath = path.resolve(checkout.worktreePath);
  const matches = ops.runner.listWorktrees(env.repoPath).filter((worktree: JsonObject) =>
    worktree.branch === checkout.branch && typeof worktree.path === "string" && path.resolve(worktree.path) === expectedPath);
  if (matches.length !== 1 || matches[0].workspaceId) throw new Error("abandoned Worker checkout is not one closed linked worktree");
  if (ops.runner.listWorkspaces().some((workspace: JsonObject) => workspace.worktreePath
    && path.resolve(workspace.worktreePath) === expectedPath)) throw new Error("abandoned Worker checkout still has an open workspace");
  if (ops.runner.listAgents().some((agent: JsonObject) => {
    const cwd = typeof agent.cwd === "string" ? path.resolve(agent.cwd) : "";
    const relative = cwd ? path.relative(expectedPath, cwd) : "";
    const cwdInside = Boolean(cwd) && (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)));
    return cwdInside || agent.name === checkout.agentName
      || agent.workspaceId === checkout.workspaceId || agent.workspace_id === checkout.workspaceId;
  })) throw new Error("abandoned Worker checkout is still occupied by an agent");
  const head = ops.runText(["git", "-C", checkout.worktreePath, "rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (head.toLowerCase() !== checkout.inputHead.toLowerCase()) throw new Error("abandoned Worker checkout HEAD changed");
  if (hasUncommittedWork(ops.runText(["git", "-C", checkout.worktreePath, ...UNCOMMITTED_WORK_STATUS_ARGS]))) {
    throw new Error("abandoned Worker checkout contains changes");
  }
}

function requiredVerificationContract(env: ReturnType<typeof envConfig>, baseHead: string) {
  if (env.requiredVerification) {
    let contract: JsonObject;
    try { contract = JSON.parse(env.requiredVerification); }
    catch { throw new Error("DEADLOOP_REQUIRED_VERIFICATION must be valid JSON"); }
    // Validate every persisted contract field, then bind it to this exact launch.
    requiredVerificationBinding(contract, baseHead);
    if (contract.repository !== env.githubRepo) {
      throw new Error("required verification contract repository does not match the launch repository");
    }
    if (String(contract.baseRevision).toLowerCase() !== baseHead.toLowerCase()) {
      throw new Error("required verification contract base revision does not match the selected base commit");
    }
    return contract;
  }
  // Fixture and direct-flow adapters provide only the historical command environment.
  // Production automationEnvironment always supplies the resolved contract.
  if (process.env.NODE_ENV === "test" || env.fixtureMode) {
    return {
      repository: env.githubRepo,
      command: env.checkCommand,
      source: { kind: "local", location: "fixture" },
      baseRevision: baseHead,
    };
  }
  throw new Error("DEADLOOP_REQUIRED_VERIFICATION is required before Worker launch");
}

function issueWorkerLaunchPlan(
  issue: JsonObject,
  env: ReturnType<typeof envConfig>,
  uuid: string,
  baseHead: string,
  recovery: AbandonedWorkerCheckout | null = null,
  verificationBaseHead: string = baseHead,
  issueClaim?: JsonObject,
) {
  const number = Number(issue.number || 0);
  const workerName = `${env.projectId}-issue-${number}-worker`;
  const branch = recovery?.branch || `agent/issue-${number}-${slugForBranch(issue.title)}`;
  const intendedWorktreePath = recovery?.worktreePath || path.join(env.worktreeRoot, branch.replace(/\//g, "-"));
  return {
    workerName,
    branch,
    input: {
      worktree: recovery
        ? { mode: "open" as const, branch, baseBranch: env.baseBranch }
        : { mode: "create" as const, branch, baseBranch: env.baseBranch },
      repoPath: env.repoPath,
      automationDir: env.automationDir,
      stateDir: env.stateDir,
      workspaceLabel: workerName,
      agent: env.workerAgent,
      model: env.workerModel,
      level: "medium",
      uuid,
      promptFilePrefix: "worker-prompt",
      project: env.projectId,
      repository: env.githubRepo,
      role: "worker" as const,
      target: { kind: "issue" as const, number },
      inputRevision: { head: baseHead },
      requiredVerification: requiredVerificationContract(env, verificationBaseHead),
      ...(issueClaim ? { reviewClaim: issueClaim } : {}),
      intendedWorktreePath,
      resolveWorktreeHead: true,
      renderPrompt: ({ promiseFile, worktreePath, worktreeHead }: { promiseFile: string; worktreePath: string; worktreeHead?: string }) => {
        if (!worktreeHead) throw new Error("Worker prompt requires the exact created worktree HEAD");
        return renderIssueWorkerPrompt({
          launchReason: "The issue is ready for implementation.",
          issueNumber: number,
          issueTitle: String(issue.title || "task"),
          issueUrl: String(issue.url || `https://github.com/${env.githubRepo}/issues/${number}`),
          githubRepo: env.githubRepo,
          automationDir: env.automationDir,
          workerInstructions: env.workerInstructions,
          checkCommand: env.checkCommand,
          validationCommand: renderProjectCheckCommand({
            automationDir: env.automationDir,
            stateDir: env.stateDir,
            cwd: worktreePath,
            command: env.checkCommand,
          }),
          promiseFile,
          reportIdentity: { attemptId: uuid, inputRevision: { head: worktreeHead } },
        });
      },
    },
  };
}

function assertWorkerLaunchBaseCurrent(
  env: Pick<ReturnType<typeof envConfig>, "repoPath" | "baseBranch">,
  baseHead: string,
  run: (args: string[]) => string,
): void {
  const current = run(["git", "-C", env.repoPath, "rev-parse", "--verify", `${env.baseBranch}^{commit}`]).trim();
  if (current.toLowerCase() !== baseHead.toLowerCase()) {
    throw new StaleLaunchError("selected Worker base commit changed before launch");
  }
}

function assertPreparedWorkerContractCurrent(planInput: Record<string, any>, env: ReturnType<typeof envConfig>, repositoryId?: string): void {
  const runDir = path.join(env.stateDir, "runs", path.basename(String(planInput.uuid)));
  const attempt = readAttemptRecord(runDir);
  try {
    assertCurrentWorkerContract(attempt, env.repoPath, env.configPath || path.join(env.stateDir, "projects.json"), repositoryId);
  } catch (error) {
    throw new StaleLaunchError(error instanceof Error ? error.message : String(error));
  }
}

function launchIssueWorkerFlow(
  issue: JsonObject,
  env: ReturnType<typeof envConfig>,
  ops: { runText: (args: string[]) => string; [key: string]: any },
): JsonObject {
  const recovery = abandonedWorkerCheckout(Number(issue.number || 0), env);
  const currentBaseHead = ops.runText(["git", "-C", env.repoPath, "rev-parse", "--verify", `${env.baseBranch}^{commit}`]).trim();
  const baseHead = recovery?.inputHead || currentBaseHead;
  const plan = issueWorkerLaunchPlan(issue, env, randomUUID(), baseHead, recovery, currentBaseHead);
  if (recovery) assertRecoverableWorkerCheckout(recovery, env, ops as { runner: ReturnType<typeof herdrRunner>; runText: (args: string[]) => string });
  prepareAgentLaunchFlow(plan.input, ops);
  recordAgentLaunchGithubClaimed(plan.input);
  const launch = launchAgentFlow(plan.input, ops);
  return { workerName: plan.workerName, branch: plan.branch, ...launch };
}

function launchIssueWorker(issue: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null): JsonObject {
  const number = Number(issue.number || 0);
  const uuid = shouldSimulateLaunch(fixture) ? "fixture-worker-uuid" : randomUUID();
  const recovery = shouldSimulateLaunch(fixture) ? null : abandonedWorkerCheckout(number, env);
  const currentBaseHead = shouldSimulateLaunch(fixture)
    ? "f".repeat(40)
    : runText(["git", "-C", env.repoPath, "rev-parse", "--verify", `${env.baseBranch}^{commit}`]).trim();
  const baseHead = recovery?.inputHead || currentBaseHead;
  const plan = issueWorkerLaunchPlan(issue, env, uuid, baseHead, recovery, currentBaseHead);
  let claim: JsonObject | undefined;
  const { workerName, branch } = plan;
  const simulatedWorktreePath = `/worktrees/${env.projectId}/${branch.replace(/\//g, "-")}`;

  if (shouldSimulateLaunch(fixture)) {
    const promiseFile = `${env.stateDir}/runs/${uuid}/promise.json`;
    return {
      workerName,
      branch,
      workspaceId: "fixture-workspace-worker",
      tabId: "fixture-tab-worker",
      rootPaneId: "fixture-pane-worker",
      worktreePath: simulatedWorktreePath,
      promptFile: `${env.stateDir}/runs/${uuid}/worker-prompt.md`,
      promiseFile,
      attemptRecordFile: `${env.stateDir}/runs/${uuid}/attempt.json`,
      instructions: plan.input.renderPrompt({ promiseFile, worktreePath: simulatedWorktreePath, worktreeHead: baseHead }),
      simulated: true,
    };
  }

  const runner = herdrRunner();
  const launch = withEnabledDriverLaunch(
    env,
    (recheck: () => void, enabled: { githubRepositoryId?: string }) => {
      if (!claim) {
        claim = claimIssueRequest(githubOperations(recheck), issue, env, "worker", enabled);
        plan.input.reviewClaim = claim;
        return;
      }
      assertPreparedWorkerContractCurrent(plan.input, env, enabled.githubRepositoryId);
      const live = githubOperations(recheck).getIssue(env.githubRepo, number);
      if (!issueLabelNames(live).includes(env.inProgressLabel)) throw new StaleLaunchError("Issue implementation claim is no longer active");
    },
    (recheck: () => void) => launchAgentFlow(
      plan.input,
      { mkdirSync: fs.mkdirSync, runner, runText, writeFileSync: fs.writeFileSync, beforeAgentStart: recheck },
    ),
    {
      prepareAttempt: () => {
        prepareAgentLaunchFlow(plan.input, { mkdirSync: fs.mkdirSync, runner, runText, writeFileSync: fs.writeFileSync });
        assertPreparedWorkerContractCurrent(plan.input, env);
      },
      recordClaim: () => recordAgentLaunchGithubClaimed(plan.input),
      claimBeforePrepare: true,
      revalidate: () => {
        const liveIssue = githubOperations().getIssue(env.githubRepo, number);
        if (claim) {
          if (!issueLabelNames(liveIssue).includes(env.inProgressLabel)) throw new StaleLaunchError("selected issue claim is no longer active");
        } else {
          const deadline = issueDecisionDeadline();
          const livePlan = planIssueCoordinatorAction([liveIssue], decisionForIssues(undefined, [liveIssue], env.githubRepo, env, deadline));
          if (livePlan.kind !== "worker_required") throw new StaleLaunchError("selected issue is no longer eligible");
        }
        assertSameLaunchTarget(issue, liveIssue, "issue");
        assertWorkerLaunchBaseCurrent(env, currentBaseHead, runText);
        if (recovery) assertRecoverableWorkerCheckout(recovery, env, { runner, runText });
      },
    },
  );
  return { workerName, branch, ...launch };
}

function launchIssueExplorer(issue: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null): JsonObject {
  const number = Number(issue.number);
  const uuid = fixture ? "fixture-explorer-uuid" : randomUUID();
  const baseHead = fixture ? "e".repeat(40) : runText(["git", "-C", env.repoPath, "rev-parse", "--verify", `${env.baseBranch}^{commit}`]).trim();
  const branch = `agent/explore-${number}-${uuid.slice(0, 8)}`;
  const intendedWorktreePath = path.join(env.worktreeRoot, branch.replace(/\//g, "-"));
  let claim: JsonObject | undefined = fixture
    ? { binding: { requestEventId: `fixture-explore-${number}` }, requestLabel: env.exploreLabel }
    : undefined;
  const input = {
    worktree: { mode: "create" as const, branch, baseBranch: env.baseBranch }, repoPath: env.repoPath,
    automationDir: env.automationDir, stateDir: env.stateDir, workspaceLabel: `${env.projectId}-issue-${number}-explorer`,
    agent: env.workerAgent, model: env.workerModel, level: "medium", uuid, promptFilePrefix: "explorer-prompt",
    project: env.projectId, repository: env.githubRepo, role: "explorer" as const,
    target: { kind: "issue" as const, number }, inputRevision: { head: baseHead }, intendedWorktreePath,
    resolveWorktreeHead: true, ...(claim ? { reviewClaim: claim } : {}),
    renderPrompt: ({ promiseFile, worktreeHead }: { promiseFile: string; worktreePath: string; worktreeHead?: string }) => renderIssueExplorerPrompt({
      issueNumber: number, issueTitle: String(issue.title || ""), issueUrl: String(issue.url || ""), githubRepo: env.githubRepo,
      workerInstructions: env.workerInstructions, promiseFile,
      reportIdentity: { attemptId: uuid, inputRevision: { head: String(worktreeHead || baseHead) } },
    }),
  };
  if (fixture) {
    const promiseFile = `${env.stateDir}/runs/${uuid}/promise.json`;
    return { branch, worktreePath: intendedWorktreePath, promiseFile, attemptRecordFile: `${env.stateDir}/runs/${uuid}/attempt.json`,
      instructions: input.renderPrompt({ promiseFile, worktreePath: intendedWorktreePath, worktreeHead: baseHead }), simulated: true, reviewClaim: claim };
  }
  const runner = herdrRunner();
  const launch = withEnabledDriverLaunch(
    env,
    (recheck: () => void, enabled: { automationLogin?: string; githubRepositoryId?: string }) => {
      claim = claimIssueRequest(githubOperations(recheck), issue, env, "explorer", enabled);
      input.reviewClaim = claim;
    },
    (recheck: () => void) => launchAgentFlow(input, {
      mkdirSync: fs.mkdirSync, runner, runText, writeFileSync: fs.writeFileSync, beforeAgentStart: recheck,
    }),
    {
      claimBeforePrepare: true,
      revalidate: () => {
        const live = githubOperations().getIssue(env.githubRepo, number);
        if (claim) {
          if (!issueLabelNames(live).includes(env.inProgressLabel)) throw new StaleLaunchError("exploration claim is no longer active");
        } else {
          const deadline = issueDecisionDeadline();
          const plan = planIssueCoordinatorAction([live], decisionForIssues(undefined, [live], env.githubRepo, env, deadline));
          if (plan.kind !== "explorer_required") throw new StaleLaunchError("Issue is no longer eligible for exploration");
        }
        assertSameLaunchTarget(issue, live, "issue");
      },
      prepareAttempt: () => prepareAgentLaunchFlow(input, { mkdirSync: fs.mkdirSync, runner, runText, writeFileSync: fs.writeFileSync }),
      recordClaim: () => recordAgentLaunchGithubClaimed(input),
    },
  );
  return { branch, reviewClaim: claim, ...launch };
}

function renderExplorerMonitorPrompt(issue: JsonObject, launch: JsonObject, env: ReturnType<typeof envConfig>): string {
  const command = `node ${path.join(env.automationDir, "complete-issue-exploration.ts")} --attempt-record ${launch.attemptRecordFile} --project-id ${env.projectId} --project-repo ${env.repoPath} --github-repo ${env.githubRepo} --state-dir ${env.stateDir} --enabled-at ${env.enabledAt} --explore-label ${env.exploreLabel} --implement-label ${env.implementLabel} --in-progress-label ${env.inProgressLabel} --blocked-label ${env.blockedLabel}`;
  return `Deterministic driver launched a read-only explorer for Issue #${issue.number}. Do not launch another agent or mutate GitHub directly.\n\nMonitor only ${launch.promiseFile} with extract-worker-promise.ts. Break immediately on complete or blocked. Then run this deterministic host completion command exactly once:\n\`${command}\`\n\nThe completion host rejects any changed repository HEAD or dirty file, posts one human-readable result on success, and moves failures to ${env.blockedLabel}.`;
}

function envConfig(source: NodeJS.ProcessEnv = process.env) {
  return {
    projectId: source.DEADLOOP_PROJECT_ID || "project",
    repoPath: source.DEADLOOP_REPO_PATH || ".",
    githubRepo: source.DEADLOOP_GITHUB_REPO || "",
    githubRepositoryId: source.DEADLOOP_GITHUB_REPOSITORY_ID || "",
    automationLogin: (source.DEADLOOP_AUTOMATION_LOGIN || "").trim().toLowerCase(),
    authorizedAutomationLogins: (source.DEADLOOP_AUTHORIZED_AUTOMATION_LOGINS || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
    claimOwner: source.DEADLOOP_CLAIM_OWNER || `${os.hostname()}:${process.pid}`,
    requestMaxRuntimeSeconds: Number(source.DEADLOOP_REQUEST_MAX_RUNTIME_SECONDS || 86_400),
    claimCleanupGraceSeconds: Number(source.DEADLOOP_CLAIM_CLEANUP_GRACE_SECONDS || 300),
    enabledAt: Number(source.DEADLOOP_ENABLED_AT),
    baseBranch: source.DEADLOOP_BASE_BRANCH || "origin/main",
    worktreeRoot: source.DEADLOOP_WORKTREE_ROOT || path.join(os.homedir(), ".herdr", "worktrees", source.DEADLOOP_PROJECT_ID || "project"),
    automationDir: SCRIPT_DIR,
    stateDir:
      source.DEADLOOP_STATE_DIR ||
      path.join(source.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "deadloop"),
    checkCommand: source.DEADLOOP_CHECK_COMMAND || "git diff --check",
    requiredVerification: source.DEADLOOP_REQUIRED_VERIFICATION || "",
    requiredVerificationResolution: source.DEADLOOP_REQUIRED_VERIFICATION_RESOLUTION || "",
    configPath: source.DEADLOOP_CONFIG || "",
    fixtureMode: source.DEADLOOP_FIXTURE_MODE === "1",
    workerInstructions: source.DEADLOOP_WORKER_INSTRUCTIONS || "Read AGENTS.md and follow the issue contract.",
    workerAgent: source.DEADLOOP_WORKER_AGENT || "pi",
    workerModel: source.DEADLOOP_WORKER_MODEL || "",
    readyLabel: source.DEADLOOP_READY_LABEL || "ready-for-agent",
    exploreLabel: source.DEADLOOP_EXPLORE_LABEL || "agent:explore",
    implementLabel: source.DEADLOOP_IMPLEMENT_LABEL || "agent:implement",
    inProgressLabel: source.DEADLOOP_IN_PROGRESS_LABEL || "agent:in-progress",
    blockedLabel: source.DEADLOOP_BLOCKED_LABEL || "agent:blocked",
    reviewLabel: source.DEADLOOP_REVIEW_LABEL || "agent:review",
    humanLabel: source.DEADLOOP_HUMAN_LABEL || "ready-for-human",
    needsInfoLabel: source.DEADLOOP_NEEDS_INFO_LABEL || "needs-info",
    wontfixLabel: source.DEADLOOP_WONTFIX_LABEL || "wontfix",
    needsTriageLabel: source.DEADLOOP_NEEDS_TRIAGE_LABEL || "needs-triage",
  };
}

function drive(fixturePath: string | undefined): DriverResult {
  if (!fixturePath) {
    runHerdrPreflight({ run: (command: string, commandArgs: string[]) => runText([command, ...commandArgs]) });
  }
  const fixture = loadFixture(fixturePath);
  const env = envConfig(fixturePath ? { ...process.env, DEADLOOP_FIXTURE_MODE: "1" } : process.env);
  if (!env.githubRepo && !fixture) return driverResult("error", "DEADLOOP_GITHUB_REPO is required", { driverAction: "configuration_error" });

  const cleanup = cleanupPlan(fixture);
  const candidates = cleanup.candidates || [];
  if (candidates.length) {
    const appliedCleanup = applyCleanup(cleanup, fixture);
    return driverResult("done", `completed worker cleanup: ${candidates.length} candidate(s)`, {
      driverAction: "cleanup_applied",
      cleanup: appliedCleanup,
    });
  }

  const observedIssues = issueList(fixture, env.githubRepo);
  const issues = fixture ? observedIssues : issueRecoverySelectionView(
    observedIssues,
    env,
    (number) => githubOperations().listIssueTimelineEvents(env.githubRepo, number),
  );
  const verificationResolution = parsedRequiredVerificationResolution(env);
  const resumableStop = verificationResolution?.status === "blocked"
    ? issues.find((candidate) => {
      const existingFingerprint = requiredVerificationStopFingerprint(candidate);
      if (!existingFingerprint || isExactDurableRequiredVerificationStop(candidate, env)) return false;
      const currentFingerprint = planIssueRequiredVerificationStop({
        issue: candidate,
        resolution: verificationResolution,
        phase: "before_launch",
        labels: { implement: env.implementLabel, inProgress: env.inProgressLabel, blocked: env.blockedLabel },
      }).fingerprint;
      return existingFingerprint === currentFingerprint;
    })
    : undefined;
  if (resumableStop) {
    const fingerprint = requiredVerificationStopFingerprint(resumableStop) as string;
    const stopped = fixture ? { fingerprint } : resumeRequiredVerificationStop(resumableStop, env, fingerprint);
    return driverResult("done", `Issue #${resumableStop.number} required-verification stop was resumed`, {
      driverAction: "required_verification_blocked", issueNumber: resumableStop.number,
      ...(verificationResolution?.reason ? { reason: verificationResolution.reason } : {}), fingerprint: stopped.fingerprint,
    });
  }
  const decision = decisionForIssues(fixturePath, issues, env.githubRepo, env);
  const issuePlan = planIssueCoordinatorAction(issues, decision);
  if (issuePlan.kind === "skip_no_candidate") return driverResult("skip", "No target issue", { driverAction: "no_candidate", decision });

  const issue = issuePlan.issue;
  // Locking a target needs the repository it belongs to. The identity is immutable and rendered
  // into every automation's environment, so its absence is a configuration fault, not a target to
  // dispatch without exclusion.
  const repositoryId = env.githubRepositoryId
    || (fixture ? String(fixture.githubRepositoryId || "fixture-repository-id") : "");
  if (!repositoryId) {
    return driverResult("error", "immutable GitHub repository identity is unavailable", { driverAction: "configuration_error" });
  }

  // The dispatch decision for one target runs while this process holds that target's lock. Unlike
  // the pull-request driver, a refused lock ends the tick rather than selecting again: issue
  // selection resolves dependencies against GitHub, so re-selecting per held target would repeat
  // those round trips. The next tick selects again anyway.
  const decided = withDispatchLock({
    stateDir: env.stateDir,
    repositoryId,
    target: { kind: "issue", number: Number(issue.number) },
  }, () => driveSelectedIssue(issuePlan, issue, env, fixture, verificationResolution));
  if (decided === null) {
    return driverResult("skip", `Issue #${issue.number} is held by another dispatch decision`, {
      driverAction: "target_dispatch_locked", issueNumber: issue.number,
    });
  }
  return decided;
}

/** One issue's dispatch decision, run under that issue's lock. */
function driveSelectedIssue(
  issuePlan: JsonObject,
  issue: JsonObject,
  env: ReturnType<typeof envConfig>,
  fixture: JsonObject | null,
  verificationResolution: JsonObject | null,
): DriverResult {
  if (issuePlan.kind === "explorer_required") {
    let launch: JsonObject;
    try { launch = launchIssueExplorer(issue, env, fixture); }
    catch (error) {
      if (isStaleLaunchError(error)) return driverResult("skip", `Issue #${issue.number} changed before exploration launch`, { driverAction: "explorer_launch_stale" });
      throw error;
    }
    return driverResult("needs_llm", `Launched read-only explorer for Issue #${issue.number}`, {
      driverAction: "explorer_monitor_request", issueNumber: issue.number, launch,
      prompt: renderExplorerMonitorPrompt(issue, launch, env),
    });
  }

  if (issuePlan.kind === "contract_missing") {
    if (!applyContractMissing(issue, env, fixture)) {
      return driverResult("skip", `Issue #${issue.number} changed before the contract gate; no workflow state was mutated`, {
        driverAction: "contract_missing_stale", issueNumber: issue.number,
      });
    }
    return driverResult("done", `Issue #${issue.number} is missing its contract; marked it blocked`, {
      driverAction: "contract_missing",
      issueNumber: issue.number,
      comment: gateMissingContractComment(issue),
    });
  }

  if (issuePlan.kind === "planning_blocked") {
    const comment = blockedComment(issue, env);
    if (!applyBlocked(issue, env, comment, fixture)) {
      return driverResult("skip", `Issue #${issue.number} changed before the planning gate; no workflow state was mutated`, {
        driverAction: "planning_blocked_stale", issueNumber: issue.number,
      });
    }
    return driverResult("done", `Issue #${issue.number} is not an implementable unit; marked it blocked`, {
      driverAction: "blocked_comment",
      issueNumber: issue.number,
      comment,
    });
  }

  if (verificationResolution?.status === "blocked") {
    const stopped = applyRequiredVerificationStop(issue, env, verificationResolution, fixture);
    if (!stopped.applied) {
      return driverResult("skip", `Issue #${issue.number} changed before the required-verification stop; no workflow state was mutated`, {
        driverAction: "required_verification_blocked_stale", issueNumber: issue.number,
      });
    }
    return driverResult("done", `Issue #${issue.number} was stopped before Worker launch because required verification is blocked`, {
      driverAction: "required_verification_blocked",
      issueNumber: issue.number,
      reason: verificationResolution.reason,
      ...(stopped.comment ? { comment: stopped.comment } : {}),
      fingerprint: stopped.fingerprint,
    });
  }

  let launch: JsonObject;
  try {
    launch = launchIssueWorker(issue, env, fixture);
  } catch (error) {
    if (isStaleLaunchError(error)) {
      return driverResult("skip", `Issue #${issue.number} changed before launch; no workflow state was mutated`, {
        driverAction: "worker_launch_stale",
        issueNumber: issue.number,
      });
    }
    throw error;
  }
  const monitorInput = {
    issueNumber: Number(issue.number || 0),
    issueTitle: String(issue.title || ""),
    issueBody: String(issue.body || ""),
    automationDir: env.automationDir,
    promiseFile: String(launch.promiseFile || ""),
    attemptRecordFile: String(launch.attemptRecordFile || ""),
    actorName: "Worker",
    projectId: env.projectId,
    repoPath: env.repoPath,
    githubRepo: env.githubRepo,
    stateDir: env.stateDir,
    enabledAt: env.enabledAt,
    worktreePath: String(launch.worktreePath || ""),
    branch: String(launch.branch || ""),
    checkCommand: renderProjectCheckCommand({
      automationDir: env.automationDir,
      stateDir: env.stateDir,
      cwd: String(launch.worktreePath || ""),
      command: env.checkCommand,
    }),
    readyLabel: env.readyLabel,
    implementLabel: env.implementLabel,
    reviewLabel: env.reviewLabel,
    inProgressLabel: env.inProgressLabel,
    blockedLabel: env.blockedLabel,
    humanLabel: env.humanLabel,
    needsInfoLabel: env.needsInfoLabel,
    wontfixLabel: env.wontfixLabel,
  };
  return driverResult("needs_llm", `Launched Worker for Issue #${issue.number}`, {
    driverAction: "worker_monitor_request",
    issueNumber: issue.number,
    launch,
    monitorHandoff: { kind: "issue", input: monitorInput },
    prompt: renderIssueMonitorPrompt(monitorInput),
  });
}

function main(): void {
  try {
    const args = parseFixtureArg(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(drive(args.fixture))}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "exception" }))}\n`,
    );
  }
}

if (require.main === module) main();

module.exports = { assertPreparedWorkerContractCurrent, assertRecoverableWorkerCheckout, assertWorkerLaunchBaseCurrent, envConfig, issueRecoverySelectionView, issueWorkerLaunchPlan, launchIssueWorkerFlow };
