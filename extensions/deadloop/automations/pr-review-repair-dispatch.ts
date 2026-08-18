#!/usr/bin/env node
// Turn a completed reviewer promise into an approved handoff, bounded retry,
// human block, or one dedicated repair launch for the exact PR head/result.

const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");
const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
const { validatePromise } = require("./extract-worker-promise.ts");
const {
  decideTechnicalReviewFailure,
  renderTechnicalFailureMarker,
  reviewOutcomeFingerprint,
  selectRepairAttempt,
} = require("./pr-review-repair-state.ts");
const {
  publicText,
  renderApprovedReviewComment,
  renderChangesRequestedComment,
  renderHumanRequiredComment,
  reviewCommentExists,
} = require("./pr-review-comments.ts");
const { hasUncommittedWork, UNCOMMITTED_WORK_STATUS_ARGS } = require("../../../src/agent-scratch-area.cjs");
const { launchAgentFlow, prepareAgentLaunchFlow, recordAgentLaunchGithubClaimed } = require("../../../src/agent-launch-flow.ts");
const { renderRepairMonitorPrompt } = require("../../../src/monitor-prompts.ts");
const { blockedPrLabelMove } = require("../../../src/pr-request-selection.ts");
const { decideReviewTransition } = require("../../../src/reviewer-outcome-contract.ts");
const {
  isPrRequiredVerificationStopComment,
  planPrRequiredVerificationStop,
  requiredVerificationStopDiagnosis,
} = require("../../../src/issue-required-verification-stop.ts");
const {
  createCommandRunner,
  createHerdrRunnerFromCommandRunner,
  driverResult,
  shellQuote,
} = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { withEnabledDriverLaunch, withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { runHerdrPreflight } = require("../../../src/herdr-preflight.cjs");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { parseAttemptPersistenceMarkers, renderAttemptPersistenceMarker } = require("../../../src/attempt-persistence-marker.cjs");
const { StaleLaunchError, assertSameLaunchTarget, isStaleLaunchError, labelNames } = require("../../../src/launch-revalidation.ts");
const {
  isRequiredVerificationPolicyBlock,
  reauthorizeReviewWrite,
} = require("../../../src/worker-required-verification-runtime.cjs");
const { assertLocallyEnabled } = require("../../../src/enabled-operation.cjs");
const {
  advancePrHistoryAfterDeterministicComment,
  comparePrHistoryObservations,
  observePrHistory,
  readPrHistoryObservation,
  writePrHistoryObservation,
} = require("../../../src/pr-review-history.ts");

import type { DriverResult, JsonObject } from "../../../src/automation-driver-kit";
import type { RunnerAdapter } from "../../../src/runner";

const commandRunner = createCommandRunner();

function configValue(args: JsonObject, name: string, environmentValue: string | undefined, fallback: string): string {
  const argumentValue = args[name];
  return typeof argumentValue === "string" ? argumentValue : environmentValue || fallback;
}

function envConfig(args: JsonObject = {}) {
  const automationDir = __dirname;
  return {
    projectId: configValue(args, "projectId", process.env.DEADLOOP_PROJECT_ID, "project"),
    repoPath: configValue(args, "repoPath", process.env.DEADLOOP_REPO_PATH, "."),
    worktreeRoot: configValue(args, "worktreeRoot", process.env.DEADLOOP_WORKTREE_ROOT, path.join(os.homedir(), ".herdr", "worktrees", configValue(args, "projectId", process.env.DEADLOOP_PROJECT_ID, "project"))),
    githubRepo: configValue(args, "githubRepo", process.env.DEADLOOP_GITHUB_REPO, ""),
    baseBranch: configValue(args, "baseBranch", process.env.DEADLOOP_BASE_BRANCH, "origin/main"),
    requiredVerification: args.requiredVerification
      || (process.env.DEADLOOP_REQUIRED_VERIFICATION ? JSON.parse(process.env.DEADLOOP_REQUIRED_VERIFICATION) : undefined),
    enabledAt: Number(configValue(args, "enabledAt", process.env.DEADLOOP_ENABLED_AT, "")),
    stateDir: configValue(
      args,
      "stateDir",
      process.env.DEADLOOP_STATE_DIR,
      path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "deadloop"),
    ),
    checkCommand: configValue(args, "checkCommand", process.env.DEADLOOP_CHECK_COMMAND, "git diff --check"),
    workerAgent: configValue(args, "workerAgent", process.env.DEADLOOP_WORKER_AGENT, "pi"),
    workerModel: configValue(args, "workerModel", process.env.DEADLOOP_WORKER_MODEL, ""),
    remote: configValue(args, "remote", process.env.DEADLOOP_REVIEW_REPAIR_REMOTE, "origin"),
    reviewLabel: configValue(args, "reviewLabel", process.env.DEADLOOP_REVIEW_LABEL, "agent:review"),
    blockedLabel: configValue(args, "blockedLabel", process.env.DEADLOOP_BLOCKED_LABEL, "agent:blocked"),
    implementLabel: configValue(args, "implementLabel", process.env.DEADLOOP_IMPLEMENT_LABEL, "agent:implement"),
    updateBranchLabel: configValue(args, "updateBranchLabel", process.env.DEADLOOP_UPDATE_BRANCH_LABEL, "agent:update-branch"),
    inProgressLabel: configValue(args, "inProgressLabel", process.env.DEADLOOP_IN_PROGRESS_LABEL, "agent:in-progress"),
    humanLabel: configValue(args, "humanLabel", process.env.DEADLOOP_HUMAN_LABEL, "ready-for-human"),
    // Every guarded write of this dispatch re-reads the bound reviewer attempt from here, so the
    // attempt's fixed required-verification contract can be re-authenticated against the current
    // trusted policy immediately before the write.
    attemptRecordFile: configValue(args, "attemptRecord", undefined, ""),
    requestEventId: "",
    automationDir,
  };
}

function parseArgs(argv: string[]): JsonObject {
  const values: JsonObject = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const name of ["promise", "pr", "expectedHead", "branch", "requestEventId"]) {
    if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return values;
}

function readLivePr(repo: string, prNumber: string, runner = commandRunner): JsonObject {
  const pr = runner.runJson([
    "gh",
    "pr",
    "view",
    prNumber,
    "-R",
    repo,
    "--json",
    "number,state,isDraft,headRefName,headRefOid,isCrossRepository,labels,comments",
  ]);
  if (!Array.isArray(pr.comments) || pr.comments.length < 100) return pr;
  const pages = runner.runJson([
    "gh",
    "api",
    "--paginate",
    "--slurp",
    `repos/${repo}/issues/${prNumber}/comments`,
  ]);
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) {
    throw new Error(`PR #${prNumber} comments pagination returned an invalid response`);
  }
  return {
    ...pr,
    comments: pages.flat().map((comment) => ({ ...comment, author: comment.author || comment.user })),
  };
}

type RepairWorktreeInspection =
  | { kind: "absent" }
  | { kind: "ambiguous" }
  | { kind: "present"; head: string; clean: boolean };

function branchWorktrees(repoPath: string, branch: string): string[] {
  const output = commandRunner.runText(["git", "-C", repoPath, "worktree", "list", "--porcelain", "-z"]);
  const expectedBranch = `refs/heads/${branch}`;
  const matches: string[] = [];
  for (const block of output.split("\0\0")) {
    const fields = block.split("\0");
    const worktreeField = fields.find((field) => field.startsWith("worktree "));
    const branchField = fields.find((field) => field.startsWith("branch "));
    if (worktreeField && branchField?.slice("branch ".length) === expectedBranch) {
      matches.push(worktreeField.slice("worktree ".length));
    }
  }
  return matches;
}

function inspectRepairWorktree(repoPath: string, branch: string): RepairWorktreeInspection {
  const worktrees = branchWorktrees(repoPath, branch);
  if (worktrees.length === 0) return { kind: "absent" };
  if (worktrees.length !== 1) return { kind: "ambiguous" };
  const worktreePath = worktrees[0];
  const head = commandRunner.runText(["git", "-C", worktreePath, "rev-parse", "HEAD"]).trim().toLowerCase();
  const clean = !hasUncommittedWork(
    commandRunner.runText(["git", "-C", worktreePath, ...UNCOMMITTED_WORK_STATUS_ARGS]),
  );
  return { kind: "present", head, clean };
}

function recoveryComment(prNumber: string, env: ReturnType<typeof envConfig>, reason: string, summary: string, marker = ""): string {
  return `## What happened
- Automatic review repair for PR #${prNumber} requires human intervention: ${publicText(reason, "the bounded automatic path could not safely continue")}.
- ${publicText(summary, "The bounded automatic path could not safely continue.")}

## Recovery steps
1. Inspect the current head, review findings, checks, and deadloop attempt markers.
   \`\`\`bash
gh pr view ${prNumber} -R ${shellQuote(env.githubRepo)} --comments --json number,state,headRefName,headRefOid,labels,statusCheckRollup
   \`\`\`
2. Correct the branch or resolve the required decision without rewriting history.
3. Push a new commit, then add ${env.reviewLabel}; the changed head starts a new review cycle and ${env.blockedLabel} clears with it.${marker ? `\n\n${marker}` : ""}`;
}

function requireManagedPr(pr: JsonObject, env: ReturnType<typeof envConfig>): void {
  const labels = labelNames(pr.labels);
  if (!labels.includes(env.inProgressLabel) || labels.includes(env.blockedLabel)) {
    throw new Error("active in-progress state is required before review repair mutation");
  }
}

/**
 * Re-authenticate the bound reviewer attempt's fixed required-verification contract against the
 * current trusted policy.
 *
 * A failing review result is reportable without any verification record, so this requires no
 * success record. It requires only currency: whatever contract the attempt fixed must still be the
 * current trusted policy, so a policy change during the attempt produces no GitHub write and no
 * repair launch. The attempt is re-read from disk because this runs immediately before a write,
 * after every external observation.
 */
function assertAttemptContractCurrent(
  env: { attemptRecordFile: string; repoPath: string; stateDir: string },
  enabled: { githubRepositoryId?: string },
): void {
  if (!env.attemptRecordFile) throw new Error("bound reviewer attempt is missing before review repair mutation");
  reauthorizeReviewWrite(readAttemptRecord(path.dirname(env.attemptRecordFile)), {
    projectRepo: env.repoPath,
    localConfigPath: process.env.DEADLOOP_CONFIG || path.join(env.stateDir, "projects.json"),
    repositoryId: enabled.githubRepositoryId,
  });
}

function revalidateManagedPr(
  prNumber: string,
  env: ReturnType<typeof envConfig>,
  enabled: { automationLogin?: string; githubRepositoryId?: string; githubRepo?: string },
  expectedHead: string,
): void {
  const authenticated = commandRunner.runText(["gh", "api", "user", "--jq", ".login"]).trim().toLowerCase();
  const enabledLogin = String(enabled?.automationLogin || "").trim().toLowerCase();
  if (!authenticated || !enabledLogin || authenticated !== enabledLogin) {
    throw new StaleLaunchError(`PR #${prNumber} authenticated identity no longer matches enablement authority`);
  }
  const repository = commandRunner.runJson(["gh", "repo", "view", env.githubRepo, "--json", "id,nameWithOwner"]);
  if (String(repository.id || "") !== String(enabled.githubRepositoryId || "")
    || String(repository.nameWithOwner || "") !== String(enabled.githubRepo || "")) {
    throw new StaleLaunchError(`PR #${prNumber} repository identity changed before mutation`);
  }
  const livePr = readLivePr(env.githubRepo, prNumber);
  if (String(livePr.state || "").toUpperCase() !== "OPEN"
    || String(livePr.headRefOid || "").toLowerCase() !== expectedHead.toLowerCase()) {
    throw new StaleLaunchError(`PR #${prNumber} review repair target changed before mutation`);
  }
  requireManagedPr(livePr, env);
  // The last gate is local, so no external observation stands between it and the write it guards.
  assertAttemptContractCurrent(env, enabled);
}

function withRevalidatedPrMutation(
  prNumber: string,
  env: ReturnType<typeof envConfig>,
  expectedPr: JsonObject,
  mutation: (guardedGithub: ReturnType<typeof createGithubOperations>, livePr: JsonObject) => void,
  historyFile = "",
): JsonObject | undefined {
  let staleComparison: JsonObject | undefined;
  withEnabledDriverLock(env, (enabled: { automationLogin?: string }, recheck: () => void) => {
    const livePr = readLivePr(env.githubRepo, prNumber);
    assertSameLaunchTarget(expectedPr, livePr, "pr");
    requireManagedPr(livePr, env);
    const revalidate = () => revalidateManagedPr(prNumber, env, enabled, String(expectedPr.headRefOid || ""));
    revalidate();
    const guardedGithub = createGithubOperations(commandRunner, () => { recheck(); revalidate(); });
    if (historyFile && fs.existsSync(historyFile)) {
      const expectedHistory = readPrHistoryObservation(historyFile);
      const currentHistory = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
      const comparison = comparePrHistoryObservations(expectedHistory, currentHistory);
      if (comparison.kind !== "unchanged") {
        staleComparison = comparison;
        guardedGithub.movePrLabels(env.githubRepo, prNumber, { remove: [env.inProgressLabel], add: env.reviewLabel });
        return;
      }
    }
    mutation(guardedGithub, livePr);
  });
  return staleComparison;
}

function claimedPrStillReleasable(livePr: JsonObject, env: ReturnType<typeof envConfig>, expectedHead: string): boolean {
  const labels = labelNames(livePr.labels);
  return String(livePr.state || "").toUpperCase() === "OPEN"
    && String(livePr.headRefOid || "").toLowerCase() === expectedHead.toLowerCase()
    && labels.includes(env.inProgressLabel)
    && !labels.includes(env.blockedLabel);
}

function releaseObservedStaleReviewHistory(
  prNumber: string,
  env: ReturnType<typeof envConfig>,
  comparison: JsonObject,
  expectedHead: string,
): { stale: true; comparison: JsonObject } {
  withEnabledDriverLock(env, (_enabled: unknown, recheck: () => void) => {
    const livePr = readLivePr(env.githubRepo, prNumber);
    if (!claimedPrStillReleasable(livePr, env, expectedHead)) return;
    const guardedGithub = createGithubOperations(commandRunner, recheck);
    guardedGithub.movePrLabels(env.githubRepo, prNumber, { remove: [env.inProgressLabel], add: env.reviewLabel });
  });
  return { stale: true, comparison };
}

function releaseStaleReviewHistory(
  prNumber: string,
  env: ReturnType<typeof envConfig>,
  historyFile: string,
  expectedHead: string,
): { stale: boolean; comparison?: JsonObject } {
  const expected = readPrHistoryObservation(historyFile);
  let comparison: JsonObject | undefined;
  let stale = false;
  withEnabledDriverLock(env, (_enabled: unknown, recheck: () => void) => {
    const current = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
    comparison = comparePrHistoryObservations(expected, current);
    if (comparison.kind !== "stale") return;
    stale = true;
    const livePr = readLivePr(env.githubRepo, prNumber);
    if (!claimedPrStillReleasable(livePr, env, expectedHead)) return;
    const guardedGithub = createGithubOperations(commandRunner, recheck);
    guardedGithub.movePrLabels(env.githubRepo, prNumber, { remove: [env.inProgressLabel], add: env.reviewLabel });
  });
  return { stale, comparison };
}

function blockedClaimMove(env: ReturnType<typeof envConfig>) {
  return blockedPrLabelMove(
    { updateBranch: env.updateBranchLabel, implement: env.implementLabel, review: env.reviewLabel },
    env.inProgressLabel,
    env.blockedLabel,
  );
}

/**
 * Every agent workflow label, which a human handoff keeps none of.
 *
 * A blocked pull request is one deadloop could not finish safely, and a completed review that needs
 * a person is one deadloop finished. Neither keeps an agent request waiting; they differ in the
 * blocked label, which the block adds and the handoff removes.
 */
function humanHandoffLabelMove(env: ReturnType<typeof envConfig>) {
  return {
    remove: [env.reviewLabel, env.implementLabel, env.updateBranchLabel, env.inProgressLabel, env.blockedLabel],
    add: [],
  };
}

function applyHumanBlock(
  prNumber: string,
  env: ReturnType<typeof envConfig>,
  expectedPr: JsonObject,
  reason: string,
  summary: string,
  marker = "",
  historyFile = "",
): { comment: string; staleComparison?: JsonObject } {
  const comment = recoveryComment(prNumber, env, reason, summary, marker);
  const staleComparison = withRevalidatedPrMutation(prNumber, env, expectedPr, (guardedGithub) => {
    guardedGithub.commentPr(env.githubRepo, prNumber, comment);
    guardedGithub.movePrLabels(env.githubRepo, prNumber, blockedClaimMove(env));
  }, historyFile);
  return { comment, ...(staleComparison ? { staleComparison } : {}) };
}

function staleHistoryResult(prNumber: string, comparison: JsonObject, context: string): DriverResult {
  return driverResult("done", `PR #${prNumber} review history changed ${context}; released the active claim`, {
    driverAction: "review_stale_history",
    historyComparison: comparison,
  });
}

function createdCommentIdentity(output: string, author: string, body: string): { id: string; author: string; body: string } {
  const id = output.trim().match(/#issuecomment-(\d+)\/?$/)?.[1];
  if (!id || !author) throw new Error("persisted review comment identity is unavailable");
  return { id, author, body };
}

function repairWorkerPrompt(
  prNumber: string,
  branch: string,
  expectedHead: string,
  findings: JsonObject[],
  attemptKey: string,
  promiseFile: string,
  worktreePath: string,
  env: ReturnType<typeof envConfig>,
): string {
  const finalizer = [
    "node",
    shellQuote(path.join(env.automationDir, "pr-review-repair-finalize.ts")),
    "--repo",
    shellQuote(worktreePath),
    "--project-id",
    shellQuote(env.projectId),
    "--attempt-record",
    shellQuote(path.join(path.dirname(promiseFile), "attempt.json")),
    "--project-repo",
    shellQuote(env.repoPath),
    "--github-repo",
    shellQuote(env.githubRepo),
    "--pr",
    prNumber,
    "--branch",
    shellQuote(branch),
    "--expected-head",
    shellQuote(expectedHead),
    "--remote",
    shellQuote(env.remote),
    "--automation-dir",
    shellQuote(env.automationDir),
    "--state-dir",
    shellQuote(env.stateDir),
    "--enabled-at",
    String(env.enabledAt),
    "--check-command",
    shellQuote(env.checkCommand),
    "--result-file",
    shellQuote(path.join(path.dirname(promiseFile), "finalizer-result.json")),
    "--in-progress-label",
    shellQuote(env.inProgressLabel),
    "--blocked-label",
    shellQuote(env.blockedLabel),
  ].join(" ");
  return `Repair only the actionable review findings below on existing PR #${prNumber}.

Exact target:
- GitHub repo: ${env.githubRepo}
- Existing PR branch (the only branch you may push): ${branch}
- Expected PR head: ${expectedHead}
- Worktree: ${worktreePath}

Required findings contract:
\`\`\`json
${JSON.stringify(findings, null, 2)}
\`\`\`

Safety contract:
- Change only what is needed to resolve every listed finding. Do not add features, reinterpret the issue, or widen scope.
- Run focused tests while editing, then commit the repair normally. Never amend, rebase, reset published history, or force-push.
- Do not run git push directly. After committing, run exactly this finalizer; it runs configured checks, immediately re-checks the PR head, and performs the only permitted push to the exact branch, leased to that exact head:
  ${finalizer}
- Never edit labels or PR metadata, create a PR, merge, close an issue, delete a branch, or invoke another agent.
- If the finalizer returns stale_head, stop without pushing or changing GitHub state.

Promise report:
- Always write one V1 JSON object to ${promiseFile}. Its immutable identity is ${JSON.stringify({ schemaVersion: 1, attemptId: attemptKey, role: "review-repair", target: { repository: env.githubRepo, kind: "pull-request", number: Number(prNumber) }, inputRevision: { head: expectedHead } })}.
- After action=pushed, read the finalizer result file beside the promise and write a summary plus status="complete", result={outcome:"repair_pushed",outputRevision:"<finalizer headOid>",repairs:[{title:"exact finding title",summary:"specific change",paths:["changed/repo/path"]}]}, and evidence={finalizer:<entire receipt>,validations:<receipt checks>}. Include exactly one repair entry for every finding and only files actually changed for that finding.
- After action=stale_head, read the finalizer result file and write a summary plus status="complete", result={outcome:"stale_head",outputRevision:"<finalizer currentRemoteHeadOid>"}, and evidence={finalizer:<entire receipt>}. The outputRevision is required and must be the current remote head recorded by the finalizer.
- On technical, validation, invariant, or push failure, write a summary plus status="blocked", result={reason:"typed_reason_code",explanation:"what failed",recovery:"safe next step"}, and evidence={}.
- This attempt key is ${attemptKey}; do not place it or any local path in public text.
- Do not claim success unless the finalizer returned pushed or stale_head.`;
}

function repairWorkspaceLabel(prNumber: string, key: string, env: ReturnType<typeof envConfig>): string {
  return `${env.projectId}-pr-${prNumber}-review-repair-${key}`;
}

function launchEvidenceFile(prNumber: string, key: string, env: ReturnType<typeof envConfig>): string {
  return path.join(env.stateDir, "review-repair-launches", `${env.projectId}-pr-${prNumber}-${key}.json`);
}

type RepairLaunchMetadata = { repairName: string; promiseFile: string; launchUuid?: string; phase?: string };

function findRunMetadata(expectedHead: string, key: string, env: ReturnType<typeof envConfig>): RepairLaunchMetadata | null {
  const runsDir = path.join(env.stateDir, "runs");
  let entries: string[];
  try { entries = fs.readdirSync(runsDir); } catch { return null; }
  const matches: RepairLaunchMetadata[] = [];
  for (const entry of entries) {
    const runDir = path.join(runsDir, entry);
    try {
      const contract = JSON.parse(fs.readFileSync(path.join(runDir, "review-contract.json"), "utf8"));
      const attempt = JSON.parse(fs.readFileSync(path.join(runDir, "attempt.json"), "utf8"));
      if (contract?.attemptKey === key && (!expectedHead || String(contract?.expectedHead || "").toLowerCase() === expectedHead.toLowerCase())) {
        matches.push({
          repairName: String(attempt.agentName || ""),
          promiseFile: path.join(runDir, "promise.json"),
          launchUuid: String(attempt.launchUuid || ""),
          phase: String(attempt.phase || ""),
        });
      }
    } catch {}
  }
  if (matches.length > 1) throw new Error("repair launch recovery found ambiguous run metadata");
  return matches[0] || null;
}

function readLaunchEvidence(
  prNumber: string,
  branch: string,
  expectedHead: string,
  key: string,
  env: ReturnType<typeof envConfig>,
): RepairLaunchMetadata | null {
  try {
    const evidence = JSON.parse(fs.readFileSync(launchEvidenceFile(prNumber, key, env), "utf8"));
    if (
      evidence?.key !== key
      || evidence?.githubRepo !== env.githubRepo
      || evidence?.branch !== branch
      || String(evidence?.expectedHead || "").toLowerCase() !== expectedHead.toLowerCase()
    ) return null;
    const fallback = findRunMetadata(expectedHead, key, env);
    const promiseFile = String(evidence?.promiseFile || fallback?.promiseFile || "");
    const repairName = String(evidence?.repairName || fallback?.repairName || "");
    return promiseFile && repairName ? { repairName, promiseFile } : null;
  } catch {
    return null;
  }
}

function recoverLaunchFromHerdr(
  _prNumber: string,
  branch: string,
  key: string,
  env: ReturnType<typeof envConfig>,
): boolean {
  const metadata = findRunMetadata("", key, env);
  if (!metadata?.repairName) return false;
  const runner = createHerdrRunnerFromCommandRunner(commandRunner);
  const worktrees = runner.listWorktrees(env.repoPath).filter((worktree) => String(worktree.branch || "") === branch);
  const agents = runner.listAgents().filter((agent) => agent.name === metadata.repairName);
  if (!agents.length) return false;
  if (agents.length !== 1 || worktrees.length !== 1) {
    throw new Error(`repair launch recovery found ${agents.length} named agent(s) and ${worktrees.length} branch worktree(s)`);
  }

  const worktreePath = String(worktrees[0].path || worktrees[0].worktreePath || "");
  const agentPath = String(agents[0].cwd || "");
  if (!worktreePath || !agentPath || path.resolve(worktreePath) !== path.resolve(agentPath)) {
    throw new Error("repair launch recovery found a named agent outside the selected branch worktree");
  }
  return true;
}

function recordLaunchEvidence(
  prNumber: string,
  branch: string,
  expectedHead: string,
  key: string,
  launch: RepairLaunchMetadata,
  env: ReturnType<typeof envConfig>,
): void {
  const file = launchEvidenceFile(prNumber, key, env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ key, githubRepo: env.githubRepo, branch, expectedHead, ...launch })}\n`, {
    encoding: "utf8", mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function repairLaunchInput(
  prNumber: string,
  branch: string,
  expectedHead: string,
  findings: JsonObject[],
  key: string,
  env: ReturnType<typeof envConfig>,
  uuid: string,
) {
  return {
    worktree: { mode: "open" as const, branch, baseBranch: env.baseBranch, remote: env.remote },
    repoPath: env.repoPath,
    automationDir: env.automationDir,
    stateDir: env.stateDir,
    workspaceLabel: repairWorkspaceLabel(prNumber, key, env),
    agent: env.workerAgent,
    model: env.workerModel,
    level: "medium",
    uuid,
    attemptId: key,
    promptFilePrefix: "review-repair-prompt",
    project: env.projectId,
    repository: env.githubRepo,
    role: "review-repair" as const,
    target: { kind: "pull-request" as const, number: Number(prNumber) },
    inputRevision: { head: expectedHead },
    requiredVerification: env.requiredVerification,
    requestEventId: env.requestEventId || undefined,
    intendedWorktreePath: path.join(env.worktreeRoot, branch.replace(/\//g, "-")),
    renderPrompt: ({ promiseFile, worktreePath }: { promiseFile: string; worktreePath: string }) =>
      repairWorkerPrompt(prNumber, branch, expectedHead, findings, key, promiseFile, worktreePath, env),
  };
}

function writeRepairContract(
  runDir: string,
  expectedHead: string,
  findings: JsonObject[],
  key: string,
): void {
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(runDir, "review-contract.json"),
    `${JSON.stringify({ attemptKey: key, expectedHead, findingTitles: findings.map((finding) => String(finding.title)) })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

type RepairLaunchOperations = {
  mkdirSync: (dir: string, options: { recursive: true; mode?: number }) => void;
  runner?: RunnerAdapter;
  runText: (args: string[]) => string;
  writeFileSync: (file: string, text: string, encoding: "utf8") => void;
};

function recordRepairLaunchGithubClaim(
  prNumber: string,
  branch: string,
  expectedHead: string,
  findings: JsonObject[],
  key: string,
  env: ReturnType<typeof envConfig>,
  uuid: string,
) {
  return recordAgentLaunchGithubClaimed(repairLaunchInput(prNumber, branch, expectedHead, findings, key, env, uuid));
}

function launchRepair(
  prNumber: string,
  branch: string,
  expectedHead: string,
  findings: JsonObject[],
  key: string,
  env: ReturnType<typeof envConfig>,
  beforeAgentStart?: () => void,
  uuid: string = randomUUID(),
  prepareOnly = false,
  operations?: RepairLaunchOperations,
): JsonObject {
  const selectedOperations = operations || {
    mkdirSync: fs.mkdirSync,
    runner: createHerdrRunnerFromCommandRunner(commandRunner),
    runText: commandRunner.runText,
    writeFileSync: fs.writeFileSync,
  };
  selectedOperations.runText(["git", "check-ref-format", "--branch", branch]);
  const runDir = path.join(env.stateDir, "runs", uuid);
  writeRepairContract(runDir, expectedHead, findings, key);
  const input = repairLaunchInput(prNumber, branch, expectedHead, findings, key, env, uuid);
  const repairName = input.workspaceLabel;
  const promiseFile = path.join(runDir, "promise.json");
  try {
    const ops = { ...selectedOperations, beforeAgentStart };
    const prepared = prepareAgentLaunchFlow(input, ops);
    if (prepareOnly) return { repairName: prepared.agentName, promiseFile: prepared.promiseFile };
    const launch = launchAgentFlow(input, ops);
    return { ...launch, repairName: launch.agentName };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      launch: { repairName, promiseFile },
    });
  }
}

function persistAuthorizedApproval<T extends unknown[]>(
  withMutation: (callback: (...args: T) => void) => void,
  authorize: () => void,
  persist: (...args: T) => void,
): unknown {
  let authorizationError: unknown;
  withMutation((...callbackArgs) => {
    try {
      authorize();
    } catch (error) {
      authorizationError = error;
      return;
    }
    persist(...callbackArgs);
  });
  return authorizationError;
}

function persistedReviewBody(
  comments: JsonObject[],
  head: string,
  fingerprint: string,
  outcome: string,
  rendered: string,
  marker: string,
  attemptId?: string,
): string {
  const reviewExists = reviewCommentExists(comments, head, fingerprint, outcome);
  const markerExists = attemptId && parseAttemptPersistenceMarkers(comments).some((item: JsonObject) => item.attemptId === attemptId);
  if (!reviewExists) return `${rendered}${marker ? `\n${marker}` : ""}`;
  return marker && !markerExists ? marker : "";
}

function assertReviewerDispatchAttemptBinding(record: JsonObject, input: JsonObject): void {
  if (record.project !== String(input.projectId)
    || record.repository !== String(input.githubRepo)
    || record.role !== "reviewer"
    || record.target?.kind !== "pull-request"
    || Number(record.target?.number) !== Number(input.pr)
    || String(record.inputRevision?.head || "").toLowerCase() !== String(input.expectedHead).toLowerCase()
    || record.branch !== String(input.branch)
    || String(record.requestEventId || "") !== String(input.requestEventId || "")) {
    throw new Error("saved reviewer attempt does not match the repair dispatch target");
  }
}

function applyPrRequiredVerificationStop(args: JsonObject, error: unknown): DriverResult {
  const env = envConfig(args);
  const prNumber = String(args.pr);
  const attemptRecord = readAttemptRecord(path.dirname(String(args.attemptRecord)));
  const report = JSON.parse(fs.readFileSync(String(args.promise), "utf8"));
  const expectedHead = String(args.expectedHead || "").toLowerCase();
  const diagnosis = requiredVerificationStopDiagnosis(attemptRecord, error);
  let reviewComment = "";
  let stopComment = "Required-verification stop comment already exists.";

  withEnabledDriverLock(env, (enabled: { automationLogin?: string; githubRepositoryId?: string; githubRepo?: string }, recheck: () => void) => {
    const observe = (): JsonObject => {
      const authenticated = commandRunner.runText(["gh", "api", "user", "--jq", ".login"]).trim().toLowerCase();
      if (!authenticated || authenticated !== String(enabled.automationLogin || "").trim().toLowerCase()) {
        throw new StaleLaunchError(`PR #${prNumber} authenticated identity no longer matches enablement authority`);
      }
      const repository = commandRunner.runJson(["gh", "repo", "view", env.githubRepo, "--json", "id,nameWithOwner"]);
      if (String(repository.id || "") !== String(enabled.githubRepositoryId || "")
        || String(repository.nameWithOwner || "") !== String(enabled.githubRepo || "")) {
        throw new StaleLaunchError(`PR #${prNumber} repository identity changed before required-verification stop`);
      }
      const live = readLivePr(env.githubRepo, prNumber);
      if (String(live.state || "").toUpperCase() !== "OPEN"
        || String(live.headRefOid || "").toLowerCase() !== expectedHead
        || String(live.headRefName || "") !== String(args.branch || "")) {
        throw new StaleLaunchError(`PR #${prNumber} changed before required-verification stop`);
      }
      const labels = labelNames(live.labels);
      const resumable = labels.includes(env.blockedLabel)
        && (live.comments || []).some((comment: JsonObject) => isPrRequiredVerificationStopComment(comment.body));
      if (!labels.includes(env.inProgressLabel) && !resumable) {
        throw new StaleLaunchError(`PR #${prNumber} no longer has the review attempt claim`);
      }
      return live;
    };

    let livePr = observe();
    const beforeMutation = () => { recheck(); livePr = observe(); };
    const github = createGithubOperations(commandRunner, beforeMutation);
    const outcome = String(report.result?.outcome || "");
    if (outcome === "changes_requested") {
      const findings = Array.isArray(report.result?.findings) ? report.result.findings : [];
      const advisories = Array.isArray(report.result?.advisories) ? report.result.advisories : [];
      const fingerprint = reviewOutcomeFingerprint(outcome, "", report.summary || "", findings, advisories);
      if (!reviewCommentExists(livePr.comments || [], expectedHead, fingerprint, outcome)) {
        reviewComment = renderChangesRequestedComment({
          headOid: expectedHead,
          summary: report.summary || "",
          findings,
          advisories,
          priorRequiredFindings: report.result?.priorRequiredFindings,
          reviewFingerprint: fingerprint,
          repairBlocked: true,
        });
        github.commentPr(env.githubRepo, prNumber, reviewComment);
        livePr = observe();
      }
    }
    const plan = planPrRequiredVerificationStop({
      pr: livePr,
      resolution: diagnosis,
      labels: {
        review: env.reviewLabel,
        implement: env.implementLabel,
        updateBranch: env.updateBranchLabel,
        inProgress: env.inProgressLabel,
        blocked: env.blockedLabel,
        human: env.humanLabel,
      },
    });
    if (plan.comment) {
      stopComment = plan.comment;
      github.commentPr(env.githubRepo, prNumber, plan.comment);
    }
    if (plan.removeLabels.length || plan.addLabels.length) {
      github.movePrLabels(env.githubRepo, prNumber, { remove: plan.removeLabels, add: plan.addLabels });
    }
  });

  return driverResult("done", `PR #${prNumber} review stopped by required verification`, {
    driverAction: "review_verification_blocked",
    comment: stopComment,
    findingsRecorded: Boolean(reviewComment),
    labelsPreserved: [env.reviewLabel],
    labelsRemoved: [env.inProgressLabel],
  });
}

function dispatch(args: JsonObject): DriverResult {
  try {
    return dispatchReviewResult(args);
  } catch (error) {
    if (!isRequiredVerificationPolicyBlock(error)) throw error;
    return applyPrRequiredVerificationStop(args, error);
  }
}

function dispatchReviewResult(args: JsonObject): DriverResult {
  runHerdrPreflight({ run: (command: string, commandArgs: string[]) => commandRunner.runText([command, ...commandArgs]) });
  const env = envConfig(args);
  if (!env.githubRepo) return driverResult("error", "DEADLOOP_GITHUB_REPO is required", { driverAction: "configuration_error" });
  const prNumber = String(args.pr);
  const hasAttemptRecord = Boolean(args.attemptRecord && fs.existsSync(String(args.attemptRecord)));
  if (!hasAttemptRecord) throw new Error("saved reviewer attempt record is required before repair dispatch");
  const validation = validatePromise(String(args.promise), String(args.attemptRecord));
  if (validation.status === "none" || validation.status === "invalid") {
    return driverResult("error", `reviewer promise is ${validation.status}`, { driverAction: "invalid_promise", validation });
  }
  const promise = validation.promise as JsonObject;
  const rawReport = JSON.parse(fs.readFileSync(String(args.promise), "utf8"));
  const attemptRecord = readAttemptRecord(path.dirname(String(args.attemptRecord)));
  assertReviewerDispatchAttemptBinding(attemptRecord, {
    projectId: env.projectId,
    githubRepo: env.githubRepo,
    pr: prNumber,
    expectedHead: args.expectedHead,
    branch: args.branch,
    requestEventId: args.requestEventId,
  });
  env.requestEventId = String(attemptRecord.requestEventId || "");
  const persistenceMarker = rawReport?.schemaVersion === 1
    ? renderAttemptPersistenceMarker(attemptRecord, rawReport, {
        findings: rawReport.role === "reviewer" ? rawReport.result?.findings || [] : [],
        boundedRepairAttemptMarked: rawReport.role === "reviewer"
          && decideReviewTransition(rawReport.result || {}).transition === "repair",
      })
    : "";
  const expectedHead = String(args.expectedHead).toLowerCase();
  const branch = String(args.branch);
  const pr = readLivePr(env.githubRepo, prNumber);
  requireManagedPr(pr, env);
  const historyFile = hasAttemptRecord
    ? path.join(path.dirname(String(args.attemptRecord)), "pr-review-history.json")
    : "";
  const acceptedHistoryFile = historyFile ? path.join(path.dirname(historyFile), "pr-review-history-accepted.json") : "";
  const historyRequired = attemptRecord?.reviewHistoryRequired === true;
  if (historyRequired) {
    if (!fs.existsSync(historyFile)) {
      return driverResult("error", `PR #${prNumber} attempt history observation is missing`, {
        driverAction: "incomplete_review_history",
        reason: "missing_attempt_history_observation",
      });
    }
    try {
      readPrHistoryObservation(historyFile);
    } catch {
      return driverResult("error", `PR #${prNumber} attempt history observation is invalid`, {
        driverAction: "incomplete_review_history",
        reason: "invalid_attempt_history_observation",
      });
    }
  }
  if (historyFile && fs.existsSync(historyFile)) {
    const freshness = releaseStaleReviewHistory(prNumber, env, historyFile, expectedHead);
    if (freshness.stale) {
      return driverResult("done", `PR #${prNumber} review history changed; released the active claim for a fresh review`, {
        driverAction: "review_stale_history",
        historyComparison: freshness.comparison,
        labelsPreserved: [env.reviewLabel],
        labelsRemoved: [env.inProgressLabel],
      });
    }
  }

  if (String(pr.state || "").toUpperCase() !== "OPEN" || Boolean(pr.isCrossRepository) || String(pr.headRefName || "") !== branch) {
    const block = applyHumanBlock(prNumber, env, pr, "the selected PR is no longer a safe same-repository branch target", promise.summary, "", historyFile);
    if (block.staleComparison) return staleHistoryResult(prNumber, block.staleComparison, "before human block");
    return driverResult("done", `PR #${prNumber} requires human intervention`, { driverAction: "review_human_blocked", comment: block.comment });
  }
  if (validation.status === "blocked") {
    if (String(pr.headRefOid || "").toLowerCase() !== expectedHead) {
      return driverResult("done", `PR #${prNumber} head changed; left labels untouched for re-evaluation`, { driverAction: "review_stale_head" });
    }
    const technicalDecision = decideTechnicalReviewFailure(pr.comments || [], expectedHead);
    if (technicalDecision.action === "retry") {
      const staleComparison = withRevalidatedPrMutation(prNumber, env, pr, (guardedGithub) => {
        guardedGithub.commentPr(
          env.githubRepo,
          prNumber,
          `Reviewer technical failure will be retried once for this head: ${publicText(promise.reason, "technical review failure")}\n\n${renderTechnicalFailureMarker(expectedHead)}`,
        );
        guardedGithub.movePrLabels(env.githubRepo, prNumber, {
          remove: [env.inProgressLabel], add: env.reviewLabel,
        });
      }, historyFile);
      if (staleComparison) return staleHistoryResult(prNumber, staleComparison, "before technical retry");
      return driverResult("done", `PR #${prNumber} reviewer technical failure requeued review once`, {
        driverAction: "review_technical_retry",
      });
    }
    const block = applyHumanBlock(prNumber, env, pr, "the reviewer failed technically twice on the same PR head", promise.summary, "", historyFile);
    if (block.staleComparison) return staleHistoryResult(prNumber, block.staleComparison, "before technical retry exhaustion");
    return driverResult("done", `PR #${prNumber} exhausted its technical review retry`, {
      driverAction: "review_technical_retry_exhausted",
      comment: block.comment,
    });
  }

  const outcome = String(promise.outcome || "approved");
  const findings = (promise.findings || []) as JsonObject[];
  const advisories = (promise.advisories || []) as JsonObject[];
  const priorRequiredFindings = promise.priorRequiredFindings;
  // The reviewer owns the semantic judgment; this picks the one allowed transition.
  const review = decideReviewTransition({ outcome, priorRequiredFindings });
  const reviewFingerprint = reviewOutcomeFingerprint(outcome, promise.reason || "", promise.summary || "", findings, advisories);
  const commentInput = {
    headOid: expectedHead,
    reason: promise.reason || "",
    summary: promise.summary || "",
    findings,
    additionalValidations: Array.isArray(promise.checks) ? promise.checks : [],
    advisories,
    priorRequiredFindings,
    transitionReason: review.reason,
    reviewFingerprint,
    reviewLabel: env.reviewLabel,
  };

  if (review.transition === "approve") {
    if (String(pr.headRefOid || "").toLowerCase() !== expectedHead) {
      return driverResult("done", `PR #${prNumber} head changed; left labels untouched for re-evaluation`, { driverAction: "review_stale_head" });
    }
    let persistedBody = "";
    let createdComment: { id: string; author: string; body: string } | undefined;
    let observedStaleComparison: JsonObject | undefined;
    let authorizationError: unknown;
    let headChangedDuringAuthorization = false;
    try {
      authorizationError = persistAuthorizedApproval(
        (persist: (guardedGithub: ReturnType<typeof createGithubOperations>, refreshed: JsonObject, livePr: JsonObject) => void) => {
          withRevalidatedPrMutation(prNumber, env, pr, (guardedGithub, livePr) => {
            if (historyFile && fs.existsSync(historyFile)) {
              const expectedHistory = readPrHistoryObservation(historyFile);
              const currentHistory = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
              const comparison = comparePrHistoryObservations(expectedHistory, currentHistory);
              if (comparison.kind !== "unchanged") {
                observedStaleComparison = comparison;
                throw new StaleLaunchError(`PR #${prNumber} review history changed before result persistence`);
              }
            }
            const refreshed = readLivePr(env.githubRepo, prNumber);
            if (String(refreshed.state || "").toUpperCase() !== "OPEN"
              || String(refreshed.headRefOid || "").toLowerCase() !== expectedHead) {
              headChangedDuringAuthorization = true;
              return;
            }
            persist(guardedGithub, refreshed, livePr);
          });
        },
        // This runs after the last PR head observation and immediately before the comment, so the
        // fixed contract, the current trusted policy and the success record bound to this exact
        // head are all re-authenticated with nothing observable left to change.
        () => {
          if (!attemptRecord || !rawReport) throw new Error("bound reviewer attempt is missing");
          const enabled = assertLocallyEnabled({ repoPath: env.repoPath, githubRepo: env.githubRepo, stateDir: env.stateDir, enabledAt: env.enabledAt });
          reauthorizeReviewWrite(attemptRecord, {
            projectRepo: env.repoPath,
            localConfigPath: process.env.DEADLOOP_CONFIG || path.join(env.stateDir, "projects.json"),
            repositoryId: enabled.githubRepositoryId,
            report: rawReport,
            attemptRecordFile: String(args.attemptRecord),
          });
        },
        (guardedGithub, refreshed, livePr) => {
          persistedBody = persistedReviewBody(refreshed.comments || livePr.comments || [], expectedHead, reviewFingerprint, outcome,
            renderApprovedReviewComment(commentInput), persistenceMarker, attemptRecord?.attemptId);
          if (!persistedBody) return;
          const output = guardedGithub.commentPr(env.githubRepo, prNumber, persistedBody);
          if (historyFile && fs.existsSync(historyFile)) {
            const automationLogin = commandRunner.runText(["gh", "api", "user", "--jq", ".login"]).trim();
            createdComment = createdCommentIdentity(output, automationLogin, persistedBody);
          }
        },
      );
    } catch (error) {
      if (!isStaleLaunchError(error) || !observedStaleComparison) throw error;
      const freshness = releaseObservedStaleReviewHistory(prNumber, env, observedStaleComparison, expectedHead);
      return driverResult("done", `PR #${prNumber} review history changed before result persistence; released the active claim`, {
        driverAction: "review_stale_history", historyComparison: freshness.comparison,
      });
    }
    if (headChangedDuringAuthorization) {
      return driverResult("done", `PR #${prNumber} head changed during approval authorization; left labels untouched for re-evaluation`, { driverAction: "review_stale_head" });
    }
    if (authorizationError) return applyPrRequiredVerificationStop(args, authorizationError);
    if (historyFile && fs.existsSync(historyFile)) {
      const expectedHistory = readPrHistoryObservation(historyFile);
      const afterPersistence = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
      const advancement = advancePrHistoryAfterDeterministicComment(expectedHistory, afterPersistence, createdComment);
      if (advancement.kind !== "accepted") {
        const freshness = releaseObservedStaleReviewHistory(prNumber, env, advancement.comparison, expectedHead);
        return driverResult("done", `PR #${prNumber} review history changed during result persistence; released the active claim`, {
          driverAction: "review_stale_history",
          historyComparison: freshness.comparison,
        });
      }
      writePrHistoryObservation(acceptedHistoryFile, advancement.observation);
    }
    return driverResult("done", `PR #${prNumber} review completed without actionable findings`, { driverAction: "review_approved" });
  }
  if (review.transition === "human_required") {
    if (historyFile && fs.existsSync(historyFile)) {
      const freshness = releaseStaleReviewHistory(prNumber, env, historyFile, expectedHead);
      if (freshness.stale) {
        return driverResult("done", `PR #${prNumber} review history changed; released the active claim for a fresh review`, {
          driverAction: "review_stale_history", historyComparison: freshness.comparison,
        });
      }
    }
    if (String(pr.headRefOid || "").toLowerCase() !== expectedHead) {
      return driverResult("done", `PR #${prNumber} head changed; left labels untouched for re-evaluation`, { driverAction: "review_stale_head" });
    }
    let comment = "Review result comment already exists.";
    let createdComment: { id: string; author: string; body: string } | undefined;
    let observedStaleComparison: JsonObject | undefined;
    try {
      withRevalidatedPrMutation(prNumber, env, pr, (guardedGithub, livePr) => {
        let expectedHistory: ReturnType<typeof readPrHistoryObservation> | undefined;
        if (historyFile && fs.existsSync(historyFile)) {
          expectedHistory = readPrHistoryObservation(historyFile);
          const currentHistory = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
          const comparison = comparePrHistoryObservations(expectedHistory, currentHistory);
          if (comparison.kind !== "unchanged") {
            observedStaleComparison = comparison;
            throw new StaleLaunchError(`PR #${prNumber} review history changed before human handoff`);
          }
        }
        if (!reviewCommentExists(livePr.comments || [], expectedHead, reviewFingerprint, "human_required")) {
          comment = renderHumanRequiredComment(commentInput);
          const output = guardedGithub.commentPr(env.githubRepo, prNumber, comment);
          if (expectedHistory) {
            const automationLogin = commandRunner.runText(["gh", "api", "user", "--jq", ".login"]).trim();
            createdComment = createdCommentIdentity(output, automationLogin, comment);
          }
        }
        if (expectedHistory) {
          const afterPersistence = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
          const advancement = advancePrHistoryAfterDeterministicComment(expectedHistory, afterPersistence, createdComment);
          if (advancement.kind !== "accepted") {
            observedStaleComparison = advancement.comparison;
            throw new StaleLaunchError(`PR #${prNumber} review history changed during human handoff`);
          }
          writePrHistoryObservation(acceptedHistoryFile, advancement.observation);
        }
        // The draft leaves first. A failed label removal then shows a ready pull request whose
        // requests are still visible, which the loop can retry; the reverse would strand a draft
        // nobody is waiting on.
        if (livePr.isDraft === true) guardedGithub.markPrReady(env.githubRepo, prNumber);
        const labels = labelNames(livePr.labels);
        if (humanHandoffLabelMove(env).remove.some((label) => labels.includes(label))) {
          guardedGithub.movePrLabels(env.githubRepo, prNumber, humanHandoffLabelMove(env));
        }
      });
    } catch (error) {
      if (!isStaleLaunchError(error) || !observedStaleComparison) throw error;
      const freshness = releaseObservedStaleReviewHistory(prNumber, env, observedStaleComparison, expectedHead);
      return driverResult("done", `PR #${prNumber} review history changed before human handoff; released the active claim`, {
        driverAction: "review_stale_history", historyComparison: freshness.comparison,
      });
    }
    return driverResult("done", `PR #${prNumber} review was handed to a human`, {
      driverAction: "review_human_handoff",
      reason: review.reason,
      comment,
    });
  }

  const worktree = inspectRepairWorktree(env.repoPath, branch);
  const refreshedPr = readLivePr(env.githubRepo, prNumber);
  if (String(refreshedPr.state || "").toUpperCase() !== "OPEN" || Boolean(refreshedPr.isCrossRepository) || String(refreshedPr.headRefName || "") !== branch) {
    const block = applyHumanBlock(prNumber, env, refreshedPr, "the selected PR stopped being a safe same-repository branch target before repair dispatch", promise.summary, "", historyFile);
    if (block.staleComparison) return staleHistoryResult(prNumber, block.staleComparison, "before repair dispatch block");
    return driverResult("done", `PR #${prNumber} requires human intervention`, { driverAction: "review_human_blocked", comment: block.comment });
  }
  const refreshedHead = String(refreshedPr.headRefOid || "").toLowerCase();
  if (refreshedHead !== expectedHead) {
    return driverResult("done", `PR #${prNumber} head changed before repair dispatch; left GitHub state untouched`, { driverAction: "review_stale_head" });
  }
  if (worktree.kind === "ambiguous") {
    const block = applyHumanBlock(prNumber, env, refreshedPr, "more than one worktree claims the repair branch", "Worktree ownership must be made unambiguous before another repair starts.", "", historyFile);
    if (block.staleComparison) return staleHistoryResult(prNumber, block.staleComparison, "before ambiguous-worktree block");
    return driverResult("done", `PR #${prNumber} repair worktree ownership is ambiguous; marked blocked`, { driverAction: "review_repair_ambiguous_worktree", comment: block.comment });
  }
  if (worktree.kind === "present" && !worktree.clean) {
    const block = applyHumanBlock(prNumber, env, refreshedPr, "the existing repair worktree is dirty", "The existing repair worktree must be inspected before another repair starts.", "", historyFile);
    if (block.staleComparison) return staleHistoryResult(prNumber, block.staleComparison, "before dirty-worktree block");
    return driverResult("done", `PR #${prNumber} repair worktree is dirty; marked blocked`, { driverAction: "review_repair_dirty_worktree", comment: block.comment });
  }
  if (worktree.kind === "present" && worktree.head !== expectedHead) {
    const block = applyHumanBlock(prNumber, env, refreshedPr, "the clean repair worktree and current PR head do not match", "The existing worktree must be reconciled without rewriting history before another repair starts.", "", historyFile);
    if (block.staleComparison) return staleHistoryResult(prNumber, block.staleComparison, "before repair-worktree mismatch block");
    return driverResult("done", `PR #${prNumber} repair worktree does not match its current head; marked blocked`, { driverAction: "review_repair_worktree_mismatch", comment: block.comment });
  }

  if (historyFile && fs.existsSync(historyFile)) {
    const freshness = releaseStaleReviewHistory(prNumber, env, historyFile, expectedHead);
    if (freshness.stale) {
      return driverResult("done", `PR #${prNumber} review history changed before repair selection; released the active claim`, {
        driverAction: "review_stale_history", historyComparison: freshness.comparison,
      });
    }
  }

  const automationLogin = commandRunner.runText(["gh", "api", "user", "--jq", ".login"]).trim();
  if (!automationLogin) throw new Error("authenticated GitHub identity is unavailable");
  const selection = selectRepairAttempt(refreshedPr.comments || [], expectedHead, findings, automationLogin);
  if (selection.action === "already_attempted") {
    let recoveredLaunch = readLaunchEvidence(prNumber, branch, expectedHead, selection.key, env);
    const retained = findRunMetadata(expectedHead, selection.key, env);
    if (!recoveredLaunch && retained?.launchUuid && ["prepared", "github_claimed"].includes(String(retained.phase || ""))) {
      const resumeUuid = retained.launchUuid;
      let resumed: JsonObject;
      let recoveryStaleComparison: JsonObject | undefined;
      try {
        resumed = withEnabledDriverLaunch(
          env,
          (recheck: () => void) => recheck(),
          (recheck: () => void) => launchRepair(prNumber, branch, expectedHead, findings, selection.key, env, recheck, resumeUuid),
          {
            prepareAttempt: () => launchRepair(prNumber, branch, expectedHead, findings, selection.key, env, undefined, resumeUuid, true),
            recordGithubMutation: () => recordRepairLaunchGithubClaim(
              prNumber, branch, expectedHead, findings, selection.key, env, resumeUuid,
            ),
            revalidate: (enabled: { automationLogin?: string; githubRepositoryId?: string }) => {
              const livePr = readLivePr(env.githubRepo, prNumber);
              assertSameLaunchTarget(refreshedPr, livePr, "pr");
              requireManagedPr(livePr, env);
              revalidateManagedPr(prNumber, env, enabled, expectedHead);
              const recoveryHistoryFile = fs.existsSync(acceptedHistoryFile)
                ? acceptedHistoryFile
                : fs.existsSync(historyFile) ? historyFile : "";
              if (recoveryHistoryFile) {
                const recoveryHistory = readPrHistoryObservation(recoveryHistoryFile);
                const currentHistory = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
                const comparison = comparePrHistoryObservations(recoveryHistory, currentHistory);
                if (comparison.kind !== "unchanged") {
                  recoveryStaleComparison = comparison;
                  throw new StaleLaunchError(`PR #${prNumber} review history changed before repair recovery`);
                }
              }
              const labels = labelNames(livePr.labels);
              const liveSelection = selectRepairAttempt(livePr.comments || [], expectedHead, findings, automationLogin);
              if (!labels.includes(env.inProgressLabel) || labels.includes(env.blockedLabel)
                || liveSelection.action !== "already_attempted" || liveSelection.key !== selection.key) {
                throw new StaleLaunchError(`PR #${prNumber} interrupted repair is no longer resumable`);
              }
              assertAttemptContractCurrent(env, enabled);
            },
          },
        );
      } catch (error) {
        if (isStaleLaunchError(error) && error instanceof Error && error.message.includes("review history")) {
          const recoveryHistoryFile = fs.existsSync(acceptedHistoryFile)
            ? acceptedHistoryFile
            : fs.existsSync(historyFile) ? historyFile : "";
          const freshness = recoveryStaleComparison
            ? releaseObservedStaleReviewHistory(prNumber, env, recoveryStaleComparison, expectedHead)
            : releaseStaleReviewHistory(prNumber, env, recoveryHistoryFile, expectedHead);
          return driverResult("done", `PR #${prNumber} review history changed before repair recovery; released the active claim`, {
            driverAction: "review_stale_history", historyComparison: freshness.comparison,
          });
        }
        throw error;
      }
      recoveredLaunch = { repairName: resumed.agentName, promiseFile: resumed.promiseFile, launchUuid: resumeUuid, phase: "agent_started" };
      recordLaunchEvidence(prNumber, branch, expectedHead, selection.key, recoveredLaunch, env);
    }
    let workerConfirmed = Boolean(recoveredLaunch);
    if (!workerConfirmed) {
      workerConfirmed = recoverLaunchFromHerdr(prNumber, branch, selection.key, env);
      if (workerConfirmed) recoveredLaunch = findRunMetadata(expectedHead, selection.key, env);
    }
    if (workerConfirmed && recoveredLaunch) {
      const staleComparison = withRevalidatedPrMutation(prNumber, env, refreshedPr, (guardedGithub, livePr) => {
        if (!reviewCommentExists(livePr.comments || [], expectedHead, selection.reviewFingerprint, outcome)) {
          guardedGithub.commentPr(
            env.githubRepo,
            prNumber,
            renderChangesRequestedComment({ ...commentInput, reviewFingerprint: selection.reviewFingerprint, repairAlreadyStarted: true }),
          );
        }
      }, fs.existsSync(acceptedHistoryFile) ? acceptedHistoryFile : historyFile);
      if (staleComparison) return staleHistoryResult(prNumber, staleComparison, "before repair recovery persistence");
      const monitorInput = {
        prNumber: Number(prNumber), expectedHeadOid: expectedHead, branch, automationDir: env.automationDir,
        promiseFile: recoveredLaunch.promiseFile, attemptRecordFile: path.join(path.dirname(recoveredLaunch.promiseFile), "attempt.json"), actorName: "review-repair worker", projectId: env.projectId,
        repoPath: env.repoPath, githubRepo: env.githubRepo, stateDir: env.stateDir, enabledAt: env.enabledAt,
        reviewLabel: env.reviewLabel, implementLabel: env.implementLabel, updateBranchLabel: env.updateBranchLabel,
        inProgressLabel: env.inProgressLabel, blockedLabel: env.blockedLabel,
        attemptKey: selection.key,
      };
      return driverResult("needs_llm", `Recovered review-repair monitor for PR #${prNumber}`, {
        driverAction: "review_repair_monitor_recovered", selection,
        monitorHandoff: { kind: "repair", input: monitorInput },
        prompt: renderRepairMonitorPrompt(monitorInput),
      });
    }
    const interruptionMarker = `<!-- deadloop:review-repair-dispatch-stop key=${selection.key} -->`;
    const alreadyRecovered = (refreshedPr.comments || []).some((comment: JsonObject) => String(comment?.body || "").includes(interruptionMarker));
    let comment = "Interrupted repair dispatch recovery already exists.";
    if (!alreadyRecovered) {
      const block = applyHumanBlock(prNumber, env, refreshedPr, "the repair attempt was recorded but no confirmed worker launch exists", promise.summary, interruptionMarker, historyFile);
      if (block.staleComparison) return staleHistoryResult(prNumber, block.staleComparison, "before interrupted-dispatch block");
      comment = block.comment;
    } else {
      const labels = labelNames(refreshedPr.labels);
      const move = blockedClaimMove(env);
      if (move.remove.some((label) => labels.includes(label)) || !move.add.every((label) => labels.includes(label))) {
        const staleComparison = withRevalidatedPrMutation(prNumber, env, refreshedPr, (guardedGithub) => guardedGithub.movePrLabels(env.githubRepo, prNumber, move), historyFile);
        if (staleComparison) return staleHistoryResult(prNumber, staleComparison, "before interrupted-dispatch block");
      }
    }
    return driverResult("done", `PR #${prNumber} repair dispatch was interrupted; marked blocked`, { driverAction: "review_repair_dispatch_interrupted", selection, comment });
  }
  if (hasAttemptRecord) {
    let persistedBody = "";
    let createdComment: { id: string; author: string; body: string } | undefined;
    let observedStaleComparison: JsonObject | undefined;
    try {
      withRevalidatedPrMutation(prNumber, env, refreshedPr, (guardedGithub, livePr) => {
        if (historyFile && fs.existsSync(historyFile)) {
          const expectedHistory = readPrHistoryObservation(historyFile);
          const currentHistory = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
          const comparison = comparePrHistoryObservations(expectedHistory, currentHistory);
          if (comparison.kind !== "unchanged") {
            observedStaleComparison = comparison;
            throw new StaleLaunchError(`PR #${prNumber} review history changed before repair result persistence`);
          }
        }
        persistedBody = persistedReviewBody(livePr.comments || [], expectedHead, selection.reviewFingerprint, outcome,
          renderChangesRequestedComment({ ...commentInput, reviewFingerprint: selection.reviewFingerprint }),
          persistenceMarker, attemptRecord?.attemptId);
        if (persistedBody) {
          const output = guardedGithub.commentPr(env.githubRepo, prNumber, persistedBody);
          if (historyFile && fs.existsSync(historyFile)) {
            createdComment = createdCommentIdentity(output, automationLogin, persistedBody);
          }
        }
      });
    } catch (error) {
      if (!isStaleLaunchError(error) || !observedStaleComparison) throw error;
      const freshness = releaseObservedStaleReviewHistory(prNumber, env, observedStaleComparison, expectedHead);
      return driverResult("done", `PR #${prNumber} review history changed before repair result persistence; released the active claim`, {
        driverAction: "review_stale_history", historyComparison: freshness.comparison,
      });
    }
    if (historyFile && fs.existsSync(historyFile)) {
      const expectedHistory = readPrHistoryObservation(historyFile);
      const afterPersistence = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
      const advancement = advancePrHistoryAfterDeterministicComment(expectedHistory, afterPersistence, createdComment);
      if (advancement.kind !== "accepted") {
        const freshness = releaseObservedStaleReviewHistory(prNumber, env, advancement.comparison, expectedHead);
        return driverResult("done", `PR #${prNumber} review history changed during repair dispatch; released the active claim`, {
          driverAction: "review_stale_history", historyComparison: freshness.comparison,
        });
      }
      writePrHistoryObservation(acceptedHistoryFile, advancement.observation);
    }
    const closed = commandRunner.runJson([
      "node", path.join(env.automationDir, "complete-attempt-workspace.ts"),
      "--attempt-record", String(args.attemptRecord),
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
    if (closed?.driverAction !== "workspace_closed") throw new Error("reviewer workspace was not closed before repair launch");
  }

  if (historyRequired && !fs.existsSync(acceptedHistoryFile)) {
    return driverResult("error", `PR #${prNumber} accepted history observation is missing before repair launch`, {
      driverAction: "incomplete_review_history",
      reason: "missing_accepted_history_observation",
    });
  }

  const repairLaunchUuid = randomUUID();
  const preparedRepair = launchRepair(
    prNumber, branch, expectedHead, findings, selection.key, env, undefined, repairLaunchUuid, true,
  );

  let launch: JsonObject;
  let launchStaleComparison: JsonObject | undefined;
  try {
    launch = withEnabledDriverLaunch(
      env,
      (recheck: () => void, enabled: { automationLogin?: string }) => {
        if (hasAttemptRecord) {
          recheck();
          return;
        }
        requireManagedPr(refreshedPr, env);
        revalidateManagedPr(prNumber, env, enabled, expectedHead);
        const guardedGithub = createGithubOperations(commandRunner, () => { recheck(); revalidateManagedPr(prNumber, env, enabled, expectedHead); });
        guardedGithub.commentPr(env.githubRepo, prNumber, renderChangesRequestedComment({ ...commentInput, reviewFingerprint: selection.reviewFingerprint }));
      },
      (recheck: () => void) => launchRepair(prNumber, branch, expectedHead, findings, selection.key, env, recheck, repairLaunchUuid),
      {
        prepareAttempt: () => launchRepair(
          prNumber, branch, expectedHead, findings, selection.key, env, undefined, repairLaunchUuid, true,
        ),
        recordGithubMutation: () => recordRepairLaunchGithubClaim(
          prNumber, branch, expectedHead, findings, selection.key, env, repairLaunchUuid,
        ),
        revalidate: (enabled: { automationLogin?: string; githubRepositoryId?: string }) => {
          const livePr = readLivePr(env.githubRepo, prNumber);
          assertSameLaunchTarget(refreshedPr, livePr, "pr");
          requireManagedPr(livePr, env);
          revalidateManagedPr(prNumber, env, enabled, expectedHead);
          if (historyRequired && !fs.existsSync(acceptedHistoryFile)) {
            throw new Error(`PR #${prNumber} accepted history observation is missing before repair launch`);
          }
          if (acceptedHistoryFile && fs.existsSync(acceptedHistoryFile)) {
            const acceptedHistory = readPrHistoryObservation(acceptedHistoryFile);
            const currentHistory = observePrHistory(env.githubRepo, Number(prNumber), commandRunner);
            const comparison = comparePrHistoryObservations(acceptedHistory, currentHistory);
            if (comparison.kind !== "unchanged") {
              launchStaleComparison = comparison;
              throw new StaleLaunchError(`PR #${prNumber} review history changed before repair launch`);
            }
          }
          const labels = labelNames(livePr.labels);
          if (!labels.includes(env.inProgressLabel) || labels.includes(env.blockedLabel)) {
            throw new StaleLaunchError(`PR #${prNumber} is no longer eligible for repair`);
          }
          const liveSelection = selectRepairAttempt(livePr.comments || [], expectedHead, findings, automationLogin);
          const markerOwnedByPreparedRepair = liveSelection.action === "already_attempted"
            && liveSelection.key === selection.key
            && preparedRepair.promiseFile === path.join(env.stateDir, "runs", repairLaunchUuid, "promise.json")
            && (() => {
              const preparedRecord = readAttemptRecord(path.join(env.stateDir, "runs", repairLaunchUuid));
              return preparedRecord.launchUuid === repairLaunchUuid
                && preparedRecord.attemptId === selection.key
                && ["prepared", "github_claimed"].includes(preparedRecord.phase);
            })();
          if ((liveSelection.action !== "launch_repair" || liveSelection.key !== selection.key) && !markerOwnedByPreparedRepair) {
            throw new StaleLaunchError(`PR #${prNumber} repair attempt state changed before launch`);
          }
          // Local and last, so the launch cannot start on a contract the policy no longer matches.
          assertAttemptContractCurrent(env, enabled);
        },
      },
    );
  } catch (error) {
    if (isStaleLaunchError(error)) {
      if (error instanceof Error && error.message.includes("review history") && acceptedHistoryFile) {
        const freshness = launchStaleComparison
          ? releaseObservedStaleReviewHistory(prNumber, env, launchStaleComparison, expectedHead)
          : releaseStaleReviewHistory(prNumber, env, acceptedHistoryFile, expectedHead);
        return driverResult("done", `PR #${prNumber} review history changed before repair launch; released the active claim`, {
          driverAction: "review_stale_history", historyComparison: freshness.comparison,
        });
      }
      return driverResult("done", `PR #${prNumber} changed before repair launch; left workflow state untouched`, { driverAction: "review_repair_launch_stale" });
    }
    if (error instanceof Error && error.message.includes("deadloop is disabled")) throw error;
    const failedLaunch = (error as Error & { launch?: JsonObject }).launch;
    let recovered = false;
    if (failedLaunch) {
      try { recovered = recoverLaunchFromHerdr(prNumber, branch, selection.key, env); } catch { recovered = false; }
    }
    if (recovered && failedLaunch?.promiseFile) {
      launch = { ...failedLaunch, recovered: true };
    } else {
      const latestPr = readLivePr(env.githubRepo, prNumber);
      const block = applyHumanBlock(
        prNumber,
        env,
        latestPr,
        `the bounded repair launch failed after its attempt marker was recorded: ${error instanceof Error ? error.message : String(error)}`,
        promise.summary,
        `<!-- deadloop:review-repair-dispatch-stop key=${selection.key} -->`,
        fs.existsSync(acceptedHistoryFile) ? acceptedHistoryFile : historyFile,
      );
      if (block.staleComparison) return staleHistoryResult(prNumber, block.staleComparison, "before launch-failure block");
      return driverResult("done", `PR #${prNumber} repair launch failed; marked blocked`, { driverAction: "review_repair_launch_failed", comment: block.comment });
    }
  }

  let launchEvidenceError = "";
  try {
    recordLaunchEvidence(prNumber, branch, expectedHead, selection.key, {
      repairName: String(launch.repairName),
      promiseFile: String(launch.promiseFile),
    }, env);
  } catch (error) {
    launchEvidenceError = error instanceof Error ? error.message : String(error);
  }
  const monitorInput = {
    prNumber: Number(prNumber), expectedHeadOid: expectedHead, branch, automationDir: env.automationDir,
    promiseFile: launch.promiseFile, attemptRecordFile: launch.attemptRecordFile || path.join(path.dirname(String(launch.promiseFile)), "attempt.json"), actorName: "review-repair worker", projectId: env.projectId,
    repoPath: env.repoPath, githubRepo: env.githubRepo, stateDir: env.stateDir, enabledAt: env.enabledAt,
    reviewLabel: env.reviewLabel, implementLabel: env.implementLabel, updateBranchLabel: env.updateBranchLabel,
    inProgressLabel: env.inProgressLabel, blockedLabel: env.blockedLabel,
    attemptKey: selection.key,
  };
  return driverResult("needs_llm", `Launched review-repair worker for PR #${prNumber}`, {
    driverAction: "review_repair_monitor_request", selection, labelsPreserved: [env.inProgressLabel], launch,
    ...(launchEvidenceError ? { launchEvidenceError } : {}),
    monitorHandoff: { kind: "repair", input: monitorInput },
    prompt: renderRepairMonitorPrompt(monitorInput),
  });
}
function main(): void {
  try {
    process.stdout.write(`${JSON.stringify(dispatch(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "exception" }))}\n`,
    );
  }
}

if (require.main === module) main();

module.exports = {
  assertReviewerDispatchAttemptBinding,
  blockedClaimMove,
  dispatch,
  envConfig,
  launchRepair,
  parseArgs,
  persistAuthorizedApproval,
  readLivePr,
  recordRepairLaunchGithubClaim,
  repairLaunchInput,
  repairWorkerPrompt,
  requireManagedPr,
};
