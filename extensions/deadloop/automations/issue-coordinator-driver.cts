#!/usr/bin/env node
// Deterministic issue-coordinator driver. CommonJS-shaped so it can run directly
// under this package's `type: commonjs`, matching launch-agent.cts.

const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");
const { createHash, randomUUID } = require("node:crypto") as typeof import("node:crypto");
const { decisionForIssues, planIssueCoordinatorAction } = require("./issue-coordinator-flow.cts");
const { hasUncommittedWork, UNCOMMITTED_WORK_STATUS_ARGS } = require("../../../src/agent-scratch-area.cjs");
const { withDispatchLock } = require("../../../src/dispatch-lock.cjs");
const { issueDecisionDeadline, issueRequestStopResult } = require("./issue-coordinator-decisions.cts");
const { renderIssueExplorerPrompt, renderIssuePlanningComment, renderIssueWorkerPrompt } = require("../../../src/issue-coordinator-renderers.cts");
const {
  applyIssueRequiredVerificationStop,
  planIssueRequiredVerificationStop,
} = require("../../../src/issue-required-verification-stop.cts");
const { launchAgentFlow, prepareAgentLaunchFlow, recordAgentLaunchGithubClaimed } = require("../../../src/agent-launch-flow.cts");
const { renderProjectCheckCommand } = require("../../../src/project-check.cts");
const {
  createCommandRunner,
  createHerdrRunnerFromCommandRunner,
  driverResult,
  loadFixture,
  parseFixtureArg,
} = require("../../../src/automation-driver-kit.cts");
const { createGithubOperations } = require("../../../src/github-operations.cts");
const {
  activeIssueRequestEvent,
  consumeIssueRequest,
  issueLabelIsActive,
  issueRecoveryBlockCanBeCleared,
} = require("../../../src/issue-request-transition.cts");
const { withEnabledDriverLaunch, withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { runHerdrPreflight } = require("../../../src/herdr-preflight.cjs");
const { StaleLaunchError, assertSameLaunchTarget, isStaleLaunchError } = require("../../../src/launch-revalidation.cts");
const { attemptRecordPath, readAttemptRecord, readAttemptRecordOrUnreadable, isUnreadableAttemptRecord, releasesAttemptOwnership, releasePersistedAttemptAuthority } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { evaluateProjectBaseBlocking } = require("../../../src/ci-base-blocking.cts");
const { assertCurrentWorkerContract, requiredVerificationBinding } = require("../../../src/worker-required-verification-runtime.cjs");
const { writeLaunchHandoffSidecar } = require("../../../src/launch-handoff-sidecar.cts");

import type { DriverResult, JsonObject } from "../../../src/automation-driver-kit-types";

const SCRIPT_DIR = __dirname;
const CLEANUP_SCRIPT = path.join(SCRIPT_DIR, "cleanup-completed-worker-worktrees.cts");
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

function reconcileAmbiguousPreparedWorkerConsumption(
  issues: JsonObject[],
  env: ReturnType<typeof envConfig>,
): { issueNumber: number; attemptId: string } | null {
  const runsRoot = path.join(env.stateDir, "runs");
  let entries: string[];
  try { entries = fs.readdirSync(runsRoot); } catch { return null; }
  for (const entry of entries.sort()) {
    const runDir = path.join(runsRoot, entry);
    let attempt: JsonObject;
    try { attempt = readAttemptRecord(runDir); } catch { continue; }
    if (attempt.project !== env.projectId || attempt.repository !== env.githubRepo
      || (attempt.role !== "worker" && attempt.role !== "explorer") || attempt.target?.kind !== "issue" || attempt.phase !== "prepared"
      || attempt.agentRequest?.role !== attempt.role) continue;
    const issue = issues.find((candidate) => Number(candidate.number) === Number(attempt.target.number));
    if (!issue) continue;
    const labels = new Set((issue.labels || []).map((label: JsonObject | string) => typeof label === "string" ? label : String(label.name || "")));
    if (labels.has(String(attempt.agentRequest.label))) continue;
    const outcome = withEnabledDriverLock(env, (enabled: { automationLogin?: string }, recheck: () => void) => {
      const transition = consumeIssueRequest({
        github: githubOperations(recheck),
        repository: env.githubRepo,
        issueNumber: Number(issue.number),
        requestLabels: [env.exploreLabel, env.implementLabel],
        requestLabel: String(attempt.agentRequest.label),
        requestEventId: String(attempt.agentRequest.eventId),
        inProgressLabel: env.inProgressLabel,
        blockedLabel: env.blockedLabel,
        automationLogin: String(enabled.automationLogin || ""),
        automationLogins: authorizedAutomationLogins(env, String(enabled.automationLogin || "")),
        attemptId: String(attempt.attemptId),
        persistConsumed: () => { throw new Error("prepared attempt has no durable consumption receipt"); },
      });
      releasePersistedAttemptAuthority(runDir, new Date().toISOString(), String(attempt.agentRequest.eventId), "never_launched");
      return transition;
    });
    if (outcome.kind === "ambiguous_blocked") {
      return { issueNumber: Number(issue.number), attemptId: String(attempt.attemptId) };
    }
  }
  return null;
}

function clearIssueRecoveryBlock(
  github: {
    deleteIssueLabel: (repository: string, issueNumber: number, label: string) => { status: number };
    listIssueLabels: (repository: string, issueNumber: number) => JsonObject[];
    listIssueTimelineEvents: (repository: string, issueNumber: number) => JsonObject[];
  },
  env: ReturnType<typeof envConfig>,
  issueNumber: number,
  request: { label: string; eventId: string },
): void {
  const labels = github.listIssueLabels(env.githubRepo, issueNumber);
  if (!labels.some((label) => String(label.name || "") === env.blockedLabel)) return;
  const events = github.listIssueTimelineEvents(env.githubRepo, issueNumber);
  if (!issueRecoveryBlockCanBeCleared(events, request.label, request.eventId, env.blockedLabel)) {
    throw new StaleLaunchError(`Issue #${issueNumber} recovery block is newer than the selected request`);
  }
  const deletion = github.deleteIssueLabel(env.githubRepo, issueNumber, env.blockedLabel);
  if (deletion.status !== 200 && deletion.status !== 404) {
    throw new Error(`Issue #${issueNumber} recovery block removal could not be proven`);
  }
  const afterLabels = github.listIssueLabels(env.githubRepo, issueNumber);
  const afterEvents = github.listIssueTimelineEvents(env.githubRepo, issueNumber);
  if (afterLabels.some((label) => String(label.name || "") === env.blockedLabel)
    || issueLabelIsActive(afterEvents, env.blockedLabel)) {
    throw new StaleLaunchError(`Issue #${issueNumber} was blocked again before request consumption`);
  }
}

// One repository may be served by a fleet of Automation hosts with different GitHub identities. The
// enabled project already carries that authorized set, and enablement overlays the host's own
// authenticated login onto it, so a single-host project resolves to exactly that one identity.
function authorizedAutomationLogins(env: ReturnType<typeof envConfig>, automationLogin: string): string[] {
  return [...new Set([...env.authorizedAutomationLogins, automationLogin.trim().toLowerCase()].filter(Boolean))];
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

// A dependency number whose live lookup returns no state is either a number that does not exist in
// this repository or a failed lookup. Unlike a plainly open dependency, it never resolves on its own,
// so deadloop reports the exact references on the issue once per reference set.
function isUnknownDependency(dep: JsonObject): boolean {
  return String(dep?.state || "").toUpperCase() === "UNKNOWN";
}

function unresolvedReferences(entry: JsonObject): string[] {
  return (entry.dependencies || [])
    .filter((dep: JsonObject) => isUnknownDependency(dep))
    .map((dep: JsonObject) => `#${dep.number}`)
    .sort();
}

function unresolvedDependencyEntryFingerprint(entry: JsonObject): string {
  return createHash("sha256").update(unresolvedReferences(entry).join(",")).digest("hex");
}

function unresolvedDependencyCommentPresent(issue: JsonObject, fingerprint: string): boolean {
  const marker = new RegExp(`<!-- deadloop:unresolved-dependency:v1 fingerprint=${fingerprint} -->`);
  return (issue.comments || []).some((comment: JsonObject) => marker.test(String(comment?.body || "")));
}

function renderUnresolvedDependencyComment(repository: string, entry: JsonObject, fingerprint: string): string {
  const references = unresolvedReferences(entry).join(", ");
  return [
    "deadloop did not select this issue because some dependency references could not be resolved.",
    "",
    `Unresolved references in ${repository}: ${references}`,
    "- The referenced number has no Issue in this repository, or the lookup failed.",
    "",
    "References that point at another repository are ignored; deadloop works per repository. Resolve or remove these references to make this issue selectable again.",
    "",
    `<!-- deadloop:unresolved-dependency:v1 fingerprint=${fingerprint} -->`,
  ].join("\n");
}

// Reports issues that lost selection because of unresolvable dependency references. The comment is
// fingerprinted so an unchanged reference set is reported once, not once per coordinator tick.
// Returns a summary of what was reported, or "" when nothing was unresolvable.
function reportUnresolvedDependencySkips(
  issues: JsonObject[],
  decision: JsonObject,
  env: ReturnType<typeof envConfig>,
  fixture: JsonObject | null,
): string {
  const affected = (decision.skipped || []).filter((entry: JsonObject) => entry.reason === "open_dependency"
    && (entry.dependencies || []).some((dep: JsonObject) => isUnknownDependency(dep)));
  const parts: string[] = [];
  for (const entry of affected) {
    const number = Number(entry.number);
    parts.push(`#${number} skipped for unresolvable dependency references (${unresolvedReferences(entry).join(", ")})`);
    const issue = issues.find((candidate) => Number(candidate.number) === number);
    if (!issue || fixture) continue;
    withEnabledDriverLock(env, (_enabled: unknown, recheck: () => void) => {
      const github = githubOperations(recheck);
      const fingerprint = unresolvedDependencyEntryFingerprint(entry);
      if (unresolvedDependencyCommentPresent(issue, fingerprint)) return;
      github.commentIssue(env.githubRepo, number, renderUnresolvedDependencyComment(env.githubRepo, entry, fingerprint));
    });
  }
  return parts.join("; ");
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
        decisionForIssues(
          undefined,
          [live],
          env.githubRepo,
          env,
          undefined,
          (candidate) => github.listIssueTimelineEvents(env.githubRepo, candidate.number),
        ),
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

/** A preserved checkout of a formally stopped Worker attempt that released its ownership. */
type StoppedWorkerCheckout = {
  branch: string;
  worktreePath: string;
  preservedHead: string;
  stoppedAt: string;
  workspaceId: string;
  agentName: string;
};

/** A journal can only vouch for a checkout it provably held: it must name the workspace evidence. */
function holdsStoppedAttemptWorkspace(record: Record<string, any>): boolean {
  return Boolean(record.workspaceId && record.tabId && record.rootPaneId);
}

/** Revisions this journal proves the checkout may sit at: its input, plus its recorded output. */
function provableCheckoutHeads(record: Record<string, any>): string[] {
  return [record.inputRevision.head, ...(record.outputRevision ? [record.outputRevision] : [])];
}

/** When this attempt stopped; only orders equivalent vouchers, never decides safety. */
function stoppedAttemptTimestamp(record: Record<string, any>, runDir: string): string {
  if (record.abandonment) return record.abandonment.abandonedAt;
  if (record.authorityRelease) return record.authorityRelease.releasedAt;
  // The workspace_closed transition was the journal's last write.
  try { return fs.statSync(attemptRecordPath(runDir)).mtime.toISOString(); }
  catch { return new Date(0).toISOString(); }
}

function stoppedWorkerCheckout(
  issueNumber: number,
  env: ReturnType<typeof envConfig>,
  ops: { runText: (args: string[]) => string },
): StoppedWorkerCheckout | null {
  const runsRoot = path.join(env.stateDir, "runs");
  let entries: string[];
  try { entries = fs.readdirSync(runsRoot); } catch { return null; }
  const candidates: Array<{ checkout: StoppedWorkerCheckout; heads: string[] }> = [];
  for (const entry of entries) {
    const runDir = path.join(runsRoot, entry);
    if (!fs.existsSync(path.join(runDir, "attempt.json"))) continue;
    const read = readAttemptRecordOrUnreadable(runDir);
    // A finished attempt's unreadable journal is evidence, not a checkout owner: skip it instead
    // of failing the whole launch scan.
    if (isUnreadableAttemptRecord(read)) continue;
    const record = read;
    if (record.project !== env.projectId || record.repository !== env.githubRepo || record.role !== "worker"
      || record.target?.kind !== "issue" || record.target.number !== issueNumber
      || !releasesAttemptOwnership(record.phase) || !holdsStoppedAttemptWorkspace(record)) continue;
    candidates.push({
      heads: provableCheckoutHeads(record),
      checkout: {
        branch: record.branch,
        worktreePath: record.worktreePath,
        preservedHead: record.inputRevision.head,
        stoppedAt: stoppedAttemptTimestamp(record, runDir),
        workspaceId: record.workspaceId,
        agentName: record.agentName,
      },
    });
  }
  if (!candidates.length) return null;
  // One Issue may hold one preserved checkout: journals naming different branches or paths leave
  // the resume target ambiguous, so they fail closed instead of silently picking one.
  const identities = new Set(candidates.map((candidate) =>
    `${candidate.checkout.branch}\0${path.resolve(candidate.checkout.worktreePath)}`));
  if (identities.size !== 1) throw new Error(`Issue #${issueNumber} has conflicting stopped Worker checkouts`);
  const checkout = candidates[0].checkout;
  let head: string;
  try {
    head = ops.runText(["git", "-C", checkout.worktreePath, "rev-parse", "--verify", "HEAD^{commit}"]).trim();
  } catch (error) {
    throw new Error(`Issue #${issueNumber} Worker checkout ${checkout.branch} at ${checkout.worktreePath}`
      + ` is gone while a stopped attempt still preserves it as evidence; restore it or remove the stale branch by hand`,
      { cause: error });
  }
  const vouchers = candidates.filter((candidate) =>
    candidate.heads.some((revision) => revision.toLowerCase() === head.toLowerCase()));
  if (!vouchers.length) {
    throw new Error(`Issue #${issueNumber} Worker checkout ${checkout.branch} is at ${head.slice(0, 12)},`
      + ` which no stopped attempt journal records; align it by hand instead of moving it silently`);
  }
  const chosen = vouchers.sort((left, right) => Date.parse(right.checkout.stoppedAt) - Date.parse(left.checkout.stoppedAt))[0].checkout;
  return { ...chosen, preservedHead: head };
}

function assertRecoverableWorkerCheckout(
  checkout: StoppedWorkerCheckout,
  env: ReturnType<typeof envConfig>,
  ops: { runner: ReturnType<typeof herdrRunner>; runText: (args: string[]) => string },
): void {
  const expectedPath = path.resolve(checkout.worktreePath);
  const matches = ops.runner.listWorktrees(env.repoPath).filter((worktree: JsonObject) =>
    worktree.branch === checkout.branch && typeof worktree.path === "string" && path.resolve(worktree.path) === expectedPath);
  if (matches.length !== 1 || matches[0].workspaceId) throw new Error("stopped Worker checkout is not one closed linked worktree");
  if (ops.runner.listWorkspaces().some((workspace: JsonObject) => workspace.worktreePath
    && path.resolve(workspace.worktreePath) === expectedPath)) throw new Error("stopped Worker checkout still has an open workspace");
  if (ops.runner.listAgents().some((agent: JsonObject) => {
    const cwd = typeof agent.cwd === "string" ? path.resolve(agent.cwd) : "";
    const relative = cwd ? path.relative(expectedPath, cwd) : "";
    const cwdInside = Boolean(cwd) && (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)));
    return cwdInside || agent.name === checkout.agentName
      || agent.workspaceId === checkout.workspaceId || agent.workspace_id === checkout.workspaceId;
  })) throw new Error("stopped Worker checkout is still occupied by an agent");
  const head = ops.runText(["git", "-C", checkout.worktreePath, "rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (head.toLowerCase() !== checkout.preservedHead.toLowerCase()) throw new Error("stopped Worker checkout HEAD changed");
  if (hasUncommittedWork(ops.runText(["git", "-C", checkout.worktreePath, ...UNCOMMITTED_WORK_STATUS_ARGS]))) {
    throw new Error("stopped Worker checkout contains changes");
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
  recovery: StoppedWorkerCheckout | null = null,
  verificationBaseHead: string = baseHead,
  agentRequest?: { role: "worker"; label: string; eventId: string },
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
      ...(agentRequest ? { agentRequest } : {}),
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
  const recovery = stoppedWorkerCheckout(Number(issue.number || 0), env, ops);
  const currentBaseHead = ops.runText(["git", "-C", env.repoPath, "rev-parse", "--verify", `${env.baseBranch}^{commit}`]).trim();
  const baseHead = recovery?.preservedHead || currentBaseHead;
  const plan = issueWorkerLaunchPlan(issue, env, randomUUID(), baseHead, recovery, currentBaseHead);
  if (recovery) assertRecoverableWorkerCheckout(recovery, env, ops as { runner: ReturnType<typeof herdrRunner>; runText: (args: string[]) => string });
  prepareAgentLaunchFlow(plan.input, ops);
  recordAgentLaunchGithubClaimed(plan.input);
  const launch = launchAgentFlow(plan.input, ops);
  return { workerName: plan.workerName, branch: plan.branch, ...launch };
}

function launchIssueWorker(issue: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null): JsonObject {
  const number = Number(issue.number || 0);
  const uuid = shouldSimulateLaunch(fixture) ? `fixture-worker-${slugForBranch(env.projectId)}-${number}` : randomUUID();
  const recovery = shouldSimulateLaunch(fixture) ? null : stoppedWorkerCheckout(number, env, { runText });
  const currentBaseHead = shouldSimulateLaunch(fixture)
    ? "f".repeat(40)
    : runText(["git", "-C", env.repoPath, "rev-parse", "--verify", `${env.baseBranch}^{commit}`]).trim();
  const baseHead = recovery?.preservedHead || currentBaseHead;
  const requestEvents = fixture
    ? (issue.timelineEvents || [{ id: "1", event: "labeled", created_at: "2026-08-16T00:00:00Z", actor: { login: "fixture-user" }, label: { name: env.implementLabel } }])
    : githubOperations().listIssueTimelineEvents(env.githubRepo, number);
  const requestEvent = activeIssueRequestEvent(requestEvents, env.implementLabel);
  if (!requestEvent) throw new StaleLaunchError(`Issue #${number} has no active ${env.implementLabel} request event`);
  const agentRequest = {
    role: "worker" as const,
    label: env.implementLabel,
    eventId: String(requestEvent.id || requestEvent.node_id || ""),
  };
  if (!agentRequest.eventId) throw new StaleLaunchError(`Issue #${number} request event has no immutable ID`);
  const plan = issueWorkerLaunchPlan(issue, env, uuid, baseHead, recovery, currentBaseHead, agentRequest);
  const { workerName, branch } = plan;
  const simulatedWorktreePath = `/worktrees/${env.projectId}/${branch.replace(/\//g, "-")}`;

  if (shouldSimulateLaunch(fixture)) {
    const prepared = prepareAgentLaunchFlow(plan.input, {
      mkdirSync: fs.mkdirSync,
      runText: () => "",
      writeFileSync: fs.writeFileSync,
    });
    const labels = new Set((issue.labels || []).map((label: JsonObject | string) => typeof label === "string" ? label : String(label.name || "")));
    const events = [...requestEvents];
    const comments: JsonObject[] = [];
    let nextEventId = events.length + 100;
    const emit = (event: "labeled" | "unlabeled", label: string) => events.push({
      id: String(nextEventId++), event, created_at: "2026-08-16T00:00:01Z",
      actor: { login: "fixture-automation" }, label: { name: label },
    });
    const fixtureGithub = {
      listIssueLabels: () => [...labels].map((name) => ({ name })),
      listIssueTimelineEvents: () => events,
      listIssueComments: () => comments,
      addIssueLabel: (_repository: string, _issueNumber: number, label: string) => {
        if (!labels.has(label)) { labels.add(label); emit("labeled", label); }
        return {};
      },
      deleteIssueLabel: (_repository: string, _issueNumber: number, label: string) => {
        if (!labels.delete(label)) return { status: 404 };
        emit("unlabeled", label);
        return { status: 200 };
      },
      commentIssue: (_repository: string, _issueNumber: number, body: string) => comments.push({ body }),
    };
    clearIssueRecoveryBlock(fixtureGithub, env, number, agentRequest);
    const requestTransition = consumeIssueRequest({
      github: fixtureGithub,
      repository: env.githubRepo,
      issueNumber: number,
      requestLabels: [env.exploreLabel, env.implementLabel],
      requestLabel: env.implementLabel,
      requestEventId: agentRequest.eventId,
      inProgressLabel: env.inProgressLabel,
      blockedLabel: env.blockedLabel,
      automationLogin: "fixture-automation",
      automationLogins: ["fixture-automation"],
      attemptId: uuid,
      persistConsumed: () => recordAgentLaunchGithubClaimed(plan.input),
    });
    if (requestTransition.kind !== "consumed") throw new StaleLaunchError(`fixture request was ${requestTransition.kind}`);
    const promiseFile = prepared.promiseFile;
    return {
      workerName,
      branch,
      workspaceId: "fixture-workspace-worker",
      tabId: "fixture-tab-worker",
      rootPaneId: "fixture-pane-worker",
      worktreePath: simulatedWorktreePath,
      promptFile: prepared.promptFile,
      promiseFile,
      attemptRecordFile: path.join(prepared.runDir, "attempt.json"),
      agentRequest,
      requestTransition,
      issueLabels: [...labels],
      timelineEvents: events,
      attemptPhase: readAttemptRecord(prepared.runDir).phase,
      instructions: plan.input.renderPrompt({ promiseFile, worktreePath: simulatedWorktreePath, worktreeHead: baseHead }),
      simulated: true,
    };
  }

  const runner = herdrRunner();
  const launch = withEnabledDriverLaunch(
    env,
    (recheck: () => void, enabled: { githubRepositoryId?: string; automationLogin?: string }) => {
      assertPreparedWorkerContractCurrent(plan.input, env, enabled.githubRepositoryId);
      const github = githubOperations(recheck);
      clearIssueRecoveryBlock(github, env, number, agentRequest);
      const outcome = consumeIssueRequest({
        github,
        repository: env.githubRepo,
        issueNumber: number,
        requestLabels: [env.exploreLabel, env.implementLabel],
        requestLabel: env.implementLabel,
        requestEventId: agentRequest.eventId,
        inProgressLabel: env.inProgressLabel,
        blockedLabel: env.blockedLabel,
        automationLogin: String(enabled.automationLogin || ""),
        automationLogins: authorizedAutomationLogins(env, String(enabled.automationLogin || "")),
        attemptId: uuid,
        persistConsumed: () => recordAgentLaunchGithubClaimed(plan.input),
      });
      if (outcome.kind !== "consumed") {
        const runDir = path.join(env.stateDir, "runs", path.basename(uuid));
        releasePersistedAttemptAuthority(runDir, new Date().toISOString(), agentRequest.eventId, "never_launched");
        const error = new StaleLaunchError(`Issue #${number} implementation request was ${outcome.kind}`) as Error & { requestTransition?: string };
        error.requestTransition = outcome.kind;
        throw error;
      }
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
      revalidate: () => {
        const deadline = issueDecisionDeadline();
        const liveIssue = githubOperations().getIssue(env.githubRepo, number);
        const livePlan = planIssueCoordinatorAction(
          [liveIssue],
          decisionForIssues(
            undefined,
            [liveIssue],
            env.githubRepo,
            env,
            deadline,
            (candidate) => githubOperations().listIssueTimelineEvents(env.githubRepo, candidate.number),
          ),
        );
        if (livePlan.kind !== "worker_required") throw new StaleLaunchError("selected issue is no longer eligible");
        assertSameLaunchTarget(issue, livePlan.issue, "issue");
        assertWorkerLaunchBaseCurrent(env, currentBaseHead, runText);
        if (recovery) assertRecoverableWorkerCheckout(recovery, env, { runner, runText });
      },
    },
  );
  return { workerName, branch, agentRequest, ...launch };
}

function launchIssueExplorer(issue: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null): JsonObject {
  const number = Number(issue.number || 0);
  const uuid = fixture ? `fixture-explorer-${slugForBranch(env.projectId)}-${number}` : randomUUID();
  const baseHead = fixture
    ? "e".repeat(40)
    : runText(["git", "-C", env.repoPath, "rev-parse", "--verify", `${env.baseBranch}^{commit}`]).trim();
  const branch = `agent/explore-${number}-${uuid.slice(-8)}`;
  const intendedWorktreePath = path.join(env.worktreeRoot, branch.replace(/\//g, "-"));
  const requestEvents = fixture
    ? (issue.timelineEvents || [{ id: "1", event: "labeled", created_at: "2026-08-16T00:00:00Z", actor: { login: "fixture-user" }, label: { name: env.exploreLabel } }])
    : githubOperations().listIssueTimelineEvents(env.githubRepo, number);
  const requestEvent = activeIssueRequestEvent(requestEvents, env.exploreLabel);
  if (!requestEvent) throw new StaleLaunchError(`Issue #${number} has no active ${env.exploreLabel} request event`);
  const agentRequest = {
    role: "explorer" as const,
    label: env.exploreLabel,
    eventId: String(requestEvent.id || requestEvent.node_id || ""),
  };
  if (!agentRequest.eventId) throw new StaleLaunchError(`Issue #${number} exploration request event has no immutable ID`);
  const input = {
    worktree: { mode: "create" as const, branch, baseBranch: env.baseBranch },
    repoPath: env.repoPath,
    automationDir: env.automationDir,
    stateDir: env.stateDir,
    workspaceLabel: `${env.projectId}-issue-${number}-explorer`,
    agent: env.workerAgent,
    model: env.explorerModel,
    level: "medium",
    uuid,
    promptFilePrefix: "explorer-prompt",
    project: env.projectId,
    repository: env.githubRepo,
    role: "explorer" as const,
    target: { kind: "issue" as const, number },
    inputRevision: { head: baseHead },
    agentRequest,
    intendedWorktreePath,
    resolveWorktreeHead: true,
    renderPrompt: ({ promiseFile, worktreeHead }: { promiseFile: string; worktreePath: string; worktreeHead?: string }) => {
      if (!worktreeHead) throw new Error("Explorer prompt requires the exact created worktree HEAD");
      return renderIssueExplorerPrompt({
        issueNumber: number,
        issueTitle: String(issue.title || ""),
        issueUrl: String(issue.url || `https://github.com/${env.githubRepo}/issues/${number}`),
        githubRepo: env.githubRepo,
        workerInstructions: env.workerInstructions,
        promiseFile,
        reportIdentity: { attemptId: uuid, inputRevision: { head: worktreeHead } },
      });
    },
  };

  if (fixture) {
    const prepared = prepareAgentLaunchFlow(input, {
      mkdirSync: fs.mkdirSync,
      runText: () => "",
      writeFileSync: fs.writeFileSync,
    });
    const labels = new Set((issue.labels || []).map((label: JsonObject | string) => typeof label === "string" ? label : String(label.name || "")));
    const events = [...requestEvents];
    const comments: JsonObject[] = [];
    let nextEventId = events.length + 100;
    const emit = (event: "labeled" | "unlabeled", label: string) => events.push({
      id: String(nextEventId++), event, created_at: "2026-08-16T00:00:02Z",
      actor: { login: "fixture-automation" }, label: { name: label },
    });
    const fixtureGithub = {
      listIssueLabels: () => [...labels].map((name) => ({ name })),
      listIssueTimelineEvents: () => events,
      listIssueComments: () => comments,
      addIssueLabel: (_repository: string, _issueNumber: number, label: string) => {
        if (!labels.has(label)) { labels.add(label); emit("labeled", label); }
        return {};
      },
      deleteIssueLabel: (_repository: string, _issueNumber: number, label: string) => {
        if (!labels.delete(label)) return { status: 404 };
        emit("unlabeled", label);
        return { status: 200 };
      },
      commentIssue: (_repository: string, _issueNumber: number, body: string) => comments.push({ body }),
    };
    clearIssueRecoveryBlock(fixtureGithub, env, number, agentRequest);
    const requestTransition = consumeIssueRequest({
      github: fixtureGithub,
      repository: env.githubRepo,
      issueNumber: number,
      requestLabels: [env.exploreLabel, env.implementLabel],
      requestLabel: env.exploreLabel,
      requestEventId: agentRequest.eventId,
      inProgressLabel: env.inProgressLabel,
      blockedLabel: env.blockedLabel,
      automationLogin: "fixture-automation",
      automationLogins: ["fixture-automation"],
      attemptId: uuid,
      persistConsumed: () => recordAgentLaunchGithubClaimed(input),
    });
    if (requestTransition.kind !== "consumed") throw new StaleLaunchError(`fixture exploration request was ${requestTransition.kind}`);
    return {
      branch,
      workspaceId: "fixture-workspace-explorer",
      tabId: "fixture-tab-explorer",
      rootPaneId: "fixture-pane-explorer",
      worktreePath: intendedWorktreePath,
      promptFile: prepared.promptFile,
      promiseFile: prepared.promiseFile,
      attemptRecordFile: path.join(prepared.runDir, "attempt.json"),
      agentRequest,
      requestTransition,
      issueLabels: [...labels],
      timelineEvents: events,
      comments,
      attemptPhase: readAttemptRecord(prepared.runDir).phase,
      instructions: input.renderPrompt({ promiseFile: prepared.promiseFile, worktreePath: intendedWorktreePath, worktreeHead: baseHead }),
      simulated: true,
    };
  }

  const runner = herdrRunner();
  const launch = withEnabledDriverLaunch(
    env,
    (recheck: () => void, enabled: { automationLogin?: string }) => {
      const github = githubOperations(recheck);
      clearIssueRecoveryBlock(github, env, number, agentRequest);
      const outcome = consumeIssueRequest({
        github,
        repository: env.githubRepo,
        issueNumber: number,
        requestLabels: [env.exploreLabel, env.implementLabel],
        requestLabel: env.exploreLabel,
        requestEventId: agentRequest.eventId,
        inProgressLabel: env.inProgressLabel,
        blockedLabel: env.blockedLabel,
        automationLogin: String(enabled.automationLogin || ""),
        automationLogins: authorizedAutomationLogins(env, String(enabled.automationLogin || "")),
        attemptId: uuid,
        persistConsumed: () => recordAgentLaunchGithubClaimed(input),
      });
      if (outcome.kind !== "consumed") {
        const runDir = path.join(env.stateDir, "runs", path.basename(uuid));
        releasePersistedAttemptAuthority(runDir, new Date().toISOString(), agentRequest.eventId, "never_launched");
        const error = new StaleLaunchError(`Issue #${number} exploration request was ${outcome.kind}`) as Error & { requestTransition?: string };
        error.requestTransition = outcome.kind;
        throw error;
      }
    },
    (recheck: () => void) => launchAgentFlow(
      input,
      { mkdirSync: fs.mkdirSync, runner, runText, writeFileSync: fs.writeFileSync, beforeAgentStart: recheck },
    ),
    {
      prepareAttempt: () => prepareAgentLaunchFlow(
        input,
        { mkdirSync: fs.mkdirSync, runner, runText, writeFileSync: fs.writeFileSync },
      ),
      revalidate: () => {
        const deadline = issueDecisionDeadline();
        const liveIssue = githubOperations().getIssue(env.githubRepo, number);
        const livePlan = planIssueCoordinatorAction(
          [liveIssue],
          decisionForIssues(
            undefined,
            [liveIssue],
            env.githubRepo,
            env,
            deadline,
            (candidate) => githubOperations().listIssueTimelineEvents(env.githubRepo, candidate.number),
          ),
        );
        if (livePlan.kind !== "explorer_required") throw new StaleLaunchError("selected issue is no longer eligible for exploration");
        assertSameLaunchTarget(issue, livePlan.issue, "issue");
        assertWorkerLaunchBaseCurrent(env, baseHead, runText);
      },
    },
  );
  return { branch, agentRequest, ...launch };
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
    explorerModel: source.DEADLOOP_EXPLORER_MODEL || "",
    readyLabel: source.DEADLOOP_READY_LABEL || "ready-for-agent",
    exploreLabel: source.DEADLOOP_EXPLORE_LABEL || "agent:explore",
    implementLabel: source.DEADLOOP_IMPLEMENT_LABEL || "agent:implement",
    inProgressLabel: source.DEADLOOP_IN_PROGRESS_LABEL || "agent:in-progress",
    blockedLabel: source.DEADLOOP_BLOCKED_LABEL || "agent:blocked",
    reviewLabel: source.DEADLOOP_REVIEW_LABEL || "agent:review",
    humanLabel: source.DEADLOOP_HUMAN_LABEL || "ready-for-human",
    needsInfoLabel: source.DEADLOOP_NEEDS_INFO_LABEL || "needs-info",
    wontfixLabel: source.DEADLOOP_WONTFIX_LABEL || "wontfix",
    authorizedAutomationLogins: String(source.DEADLOOP_AUTHORIZED_AUTOMATION_LOGINS || "")
      .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
    coordinatorMaxRuntimeSeconds: Number(source.DEADLOOP_COORDINATOR_MAX_RUNTIME_SECONDS) > 0
      ? Number(source.DEADLOOP_COORDINATOR_MAX_RUNTIME_SECONDS)
      : 86_400,
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

  // A failed trusted-base/contract pair suppresses every launch while it stands; waiting Agent
  // requests stay unconsumed so the loop resumes the moment base or contract changes.
  if (!fixture && env.repoPath) {
    const baseBlocking = evaluateProjectBaseBlocking({ stateDir: env.stateDir, projectId: env.projectId, repoPath: env.repoPath, baseBranch: env.baseBranch });
    if (baseBlocking.active) {
      return driverResult("skip", `Base verification blocked: ${baseBlocking.reason}; no Agent request was consumed`, {
        driverAction: "base_verification_blocked",
        reason: baseBlocking.reason,
      });
    }
  }

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
  const ambiguousPrepared = fixture ? null : reconcileAmbiguousPreparedWorkerConsumption(issues, env);
  if (ambiguousPrepared) {
    return driverResult("done", `Issue #${ambiguousPrepared.issueNumber} request consumption was ambiguous; blocked with recovery guidance`, {
      driverAction: "ambiguous_request_consumption_blocked",
      issueNumber: ambiguousPrepared.issueNumber,
      attemptId: ambiguousPrepared.attemptId,
    });
  }
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
  const decision = decisionForIssues(
    fixturePath,
    issues,
    env.githubRepo,
    env,
    undefined,
    (candidate) => githubOperations().listIssueTimelineEvents(env.githubRepo, candidate.number),
  );
  const issuePlan = planIssueCoordinatorAction(issues, decision);
  if (issuePlan.kind === "skip_no_candidate") {
    const summary = reportUnresolvedDependencySkips(issues, decision, env, fixture);
    return driverResult("skip", summary || "No target issue", { driverAction: "no_candidate", decision });
  }

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

  if (issuePlan.kind === "explorer_required") {
    let launch: JsonObject;
    try {
      launch = launchIssueExplorer(issue, env, fixture);
    } catch (error) {
      const transition = (error as Error & { requestTransition?: string }).requestTransition;
      const stop = issueRequestStopResult(String(transition || ""), "exploration", Number(issue.number));
      if (stop) {
        return driverResult(stop.status, stop.message, {
          driverAction: stop.driverAction,
          issueNumber: issue.number,
        });
      }
      if (isStaleLaunchError(error)) {
        return driverResult("skip", `Issue #${issue.number} changed before exploration launch; no workflow state was mutated`, {
          driverAction: "explorer_launch_stale",
          issueNumber: issue.number,
        });
      }
      throw error;
    }
    const monitorInput = {
      issueNumber: Number(issue.number || 0),
      automationDir: env.automationDir,
      promiseFile: String(launch.promiseFile || ""),
      attemptRecordFile: String(launch.attemptRecordFile || ""),
      actorName: "explorer",
      projectId: env.projectId,
      repoPath: env.repoPath,
      githubRepo: env.githubRepo,
      stateDir: env.stateDir,
      enabledAt: env.enabledAt,
      exploreLabel: env.exploreLabel,
      implementLabel: env.implementLabel,
      inProgressLabel: env.inProgressLabel,
      blockedLabel: env.blockedLabel,
      requestEventId: String(launch.agentRequest?.eventId || ""),
      maxActiveMilliseconds: env.coordinatorMaxRuntimeSeconds * 1000,
    };
    // Durable launch handoff (#386): if this driver's result is lost after the launch, the runner
    // re-adopts the monitoring handoff from this sidecar instead of orphaning the attempt.
    writeLaunchHandoffSidecar(String(launch.attemptRecordFile || ""), {
      action: "monitor",
      summary: `Launched read-only explorer for Issue #${issue.number}`,
      monitorHandoff: { kind: "explorer", input: monitorInput },
    });
    return driverResult("monitor", `Launched read-only explorer for Issue #${issue.number}`, {
      driverAction: "explorer_monitor_request",
      issueNumber: issue.number,
      launch,
      monitorHandoff: { kind: "explorer", input: monitorInput },
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
    const transition = (error as Error & { requestTransition?: string }).requestTransition;
    const stop = issueRequestStopResult(String(transition || ""), "implementation", Number(issue.number));
    if (stop) {
      return driverResult(stop.status, stop.message, {
        driverAction: stop.driverAction,
        issueNumber: issue.number,
      });
    }
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
    exploreLabel: env.exploreLabel,
    implementLabel: env.implementLabel,
    reviewLabel: env.reviewLabel,
    inProgressLabel: env.inProgressLabel,
    blockedLabel: env.blockedLabel,
    humanLabel: env.humanLabel,
    needsInfoLabel: env.needsInfoLabel,
    wontfixLabel: env.wontfixLabel,
    requestEventId: String(launch.agentRequest?.eventId || ""),
    maxActiveMilliseconds: env.coordinatorMaxRuntimeSeconds * 1000,
  };
  // Durable launch handoff (#386): recorded right after the successful launch so a lost driver
  // result still leaves the monitoring handoff beside the attempt journal for the runner to adopt.
  writeLaunchHandoffSidecar(String(launch.attemptRecordFile || ""), {
    action: "monitor",
    summary: `Launched Worker for Issue #${issue.number}`,
    monitorHandoff: { kind: "issue", input: monitorInput },
  });
  return driverResult("monitor", `Launched Worker for Issue #${issue.number}`, {
    driverAction: "worker_monitor_request",
    issueNumber: issue.number,
    launch,
    monitorHandoff: { kind: "issue", input: monitorInput },
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

module.exports = {
  assertPreparedWorkerContractCurrent,
  assertRecoverableWorkerCheckout,
  assertWorkerLaunchBaseCurrent,
  clearIssueRecoveryBlock,
  envConfig,
  issueWorkerLaunchPlan,
  launchIssueWorkerFlow,
  stoppedWorkerCheckout,
  renderUnresolvedDependencyComment,
  unresolvedDependencyCommentPresent,
  unresolvedDependencyEntryFingerprint,
};
