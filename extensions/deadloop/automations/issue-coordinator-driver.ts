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
const { renderIssuePlanningComment, renderIssueWorkerPrompt } = require("../../../src/issue-coordinator-renderers.ts");
const {
  applyIssueRequiredVerificationStop,
  planIssueRequiredVerificationStop,
} = require("../../../src/issue-required-verification-stop.ts");
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
      mutate(github, live);
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
    github.moveIssueLabels(env.githubRepo, number, { remove: env.implementLabel, add: env.needsTriageLabel });
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
    github.moveIssueLabels(env.githubRepo, number, { remove: env.implementLabel, add: env.blockedLabel });
    github.commentIssue(env.githubRepo, number, comment);
  });
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
      assertPreparedWorkerContractCurrent(plan.input, env, enabled.githubRepositoryId);
      githubOperations(recheck).moveIssueLabels(env.githubRepo, number, { remove: env.implementLabel, add: env.inProgressLabel });
    },
    (recheck: () => void) => launchAgentFlow(
      plan.input,
      { mkdirSync: fs.mkdirSync, runner, runText, writeFileSync: fs.writeFileSync, beforeAgentStart: recheck },
    ),
    {
      prepareAttempt: () => prepareAgentLaunchFlow(
        plan.input,
        { mkdirSync: fs.mkdirSync, runner, runText, writeFileSync: fs.writeFileSync },
      ),
      recordClaim: () => recordAgentLaunchGithubClaimed(plan.input),
      revalidate: () => {
        const deadline = issueDecisionDeadline();
        const liveIssue = githubOperations().getIssue(env.githubRepo, number);
        const livePlan = planIssueCoordinatorAction(
          [liveIssue],
          decisionForIssues(undefined, [liveIssue], env.githubRepo, env, deadline),
        );
        if (livePlan.kind !== "worker_required") throw new StaleLaunchError("selected issue is no longer eligible");
        assertSameLaunchTarget(issue, livePlan.issue, "issue");
        assertWorkerLaunchBaseCurrent(env, currentBaseHead, runText);
        if (recovery) assertRecoverableWorkerCheckout(recovery, env, { runner, runText });
      },
    },
  );
  return { workerName, branch, ...launch };
}

function envConfig(source: NodeJS.ProcessEnv = process.env) {
  return {
    projectId: source.DEADLOOP_PROJECT_ID || "project",
    repoPath: source.DEADLOOP_REPO_PATH || ".",
    githubRepo: source.DEADLOOP_GITHUB_REPO || "",
    githubRepositoryId: source.DEADLOOP_GITHUB_REPOSITORY_ID || "",
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

  const issues = issueList(fixture, env.githubRepo);
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

  if (issuePlan.kind === "contract_missing") {
    if (!applyContractMissing(issue, env, fixture)) {
      return driverResult("skip", `Issue #${issue.number} changed before the contract gate; no workflow state was mutated`, {
        driverAction: "contract_missing_stale", issueNumber: issue.number,
      });
    }
    return driverResult("done", `Issue #${issue.number} is missing its contract; moved it to needs-triage`, {
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

module.exports = { assertPreparedWorkerContractCurrent, assertRecoverableWorkerCheckout, assertWorkerLaunchBaseCurrent, envConfig, issueWorkerLaunchPlan, launchIssueWorkerFlow };
