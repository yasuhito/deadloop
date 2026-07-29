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
const { launchAgentFlow } = require("../../../src/agent-launch-flow.ts");
const { renderRepairMonitorPrompt } = require("../../../src/monitor-prompts.ts");
const {
  createCommandRunner,
  createHerdrRunnerFromCommandRunner,
  driverResult,
  shellQuote,
} = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { withEnabledDriverLaunch, withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { StaleLaunchError, assertSameLaunchTarget, isStaleLaunchError, labelNames } = require("../../../src/launch-revalidation.ts");

import type { DriverResult, JsonObject } from "../../../src/automation-driver-kit";

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
    githubRepo: configValue(args, "githubRepo", process.env.DEADLOOP_GITHUB_REPO, ""),
    enabledAt: Number(process.env.DEADLOOP_ENABLED_AT),
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
    reviewingLabel: configValue(args, "reviewingLabel", process.env.DEADLOOP_REVIEWING_LABEL, "agent:reviewing"),
    blockedLabel: configValue(args, "blockedLabel", process.env.DEADLOOP_BLOCKED_LABEL, "agent:blocked"),
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
  for (const name of ["promise", "pr", "expectedHead", "branch"]) {
    if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return values;
}

function readLivePr(repo: string, prNumber: string): JsonObject {
  return commandRunner.runJson([
    "gh",
    "pr",
    "view",
    prNumber,
    "-R",
    repo,
    "--json",
    "number,state,headRefName,headRefOid,isCrossRepository,labels,comments",
  ]);
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
  const clean =
    commandRunner.runText(["git", "-C", worktreePath, "status", "--porcelain", "--untracked-files=all"]).trim() === "";
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
3. Push a new commit, then remove ${env.blockedLabel}; the changed head can start a new review cycle.${marker ? `\n\n${marker}` : ""}`;
}

function withRevalidatedPrMutation(
  prNumber: string,
  env: ReturnType<typeof envConfig>,
  expectedPr: JsonObject,
  mutation: (guardedGithub: ReturnType<typeof createGithubOperations>, livePr: JsonObject) => void,
): void {
  withEnabledDriverLock(env, (_enabled: unknown, recheck: () => void) => {
    const livePr = readLivePr(env.githubRepo, prNumber);
    assertSameLaunchTarget(expectedPr, livePr, "pr");
    mutation(createGithubOperations(commandRunner, recheck), livePr);
  });
}

function applyHumanBlock(
  prNumber: string,
  env: ReturnType<typeof envConfig>,
  expectedPr: JsonObject,
  reason: string,
  summary: string,
  marker = "",
): string {
  const comment = recoveryComment(prNumber, env, reason, summary, marker);
  withRevalidatedPrMutation(prNumber, env, expectedPr, (guardedGithub) => {
    guardedGithub.commentPr(env.githubRepo, prNumber, comment);
    guardedGithub.movePrLabels(env.githubRepo, prNumber, { remove: env.reviewingLabel, add: env.blockedLabel });
  });
  return comment;
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
  ].join(" ");
  return `Repair only the actionable review findings below on existing PR #${prNumber}.

Exact target:
- GitHub repo: ${env.githubRepo}
- Existing PR branch (the only branch you may push): ${branch}
- Expected PR head: ${expectedHead}
- Worktree: ${worktreePath}

Bounded findings contract:
\`\`\`json
${JSON.stringify(findings, null, 2)}
\`\`\`

Safety contract:
- First require a clean worktree and HEAD exactly equal to ${expectedHead}.
- Change only what is needed to resolve every listed finding. Do not add features, reinterpret the issue, or widen scope.
- Run focused tests while editing, then commit the repair normally. Never amend, rebase, reset published history, or force-push.
- Do not run git push directly. After committing, run exactly this finalizer; it runs configured checks, immediately re-checks the PR head, and performs the only permitted non-force push to the exact branch:
  ${finalizer}
- Never edit labels or PR metadata, create a PR, merge, close an issue, delete a branch, or invoke another agent.
- If the finalizer returns stale_head, stop without pushing or changing GitHub state.

Promise report:
- Always write one V1 JSON object to ${promiseFile}. Its immutable identity is ${JSON.stringify({ schemaVersion: 1, attemptId: attemptKey, role: "review-repair", target: { repository: env.githubRepo, kind: "pull-request", number: Number(prNumber) }, inputRevision: { head: expectedHead } })}.
- After action=pushed, read the finalizer result file beside the promise and write a summary plus status="complete", result={outcome:"repair_pushed",outputRevision:"<finalizer headOid>",repairs:[{title:"exact finding title",summary:"specific change",paths:["changed/repo/path"]}]}, and evidence={finalizer:<entire receipt>,validations:<receipt checks>}. Include exactly one repair entry for every finding and only files actually changed for that finding.
- After action=stale_head, write a summary plus status="complete", result={outcome:"stale_head"}, and evidence={finalizer:<entire receipt>}.
- On technical, validation, invariant, or push failure, write a summary plus status="blocked", result={reason:"typed_reason_code",explanation:"what failed",recovery:"safe next step"}, and evidence={}.
- This attempt key is ${attemptKey}; do not place it or any local path in public text.
- Do not claim success unless the finalizer returned pushed or stale_head.`;
}

function repairAgentName(prNumber: string, key: string, env: ReturnType<typeof envConfig>): string {
  return `${env.projectId}-pr-${prNumber}-review-repair-${key}`;
}

function launchEvidenceFile(prNumber: string, key: string, env: ReturnType<typeof envConfig>): string {
  return path.join(env.stateDir, "review-repair-launches", `${env.projectId}-pr-${prNumber}-${key}.json`);
}

type RepairLaunchMetadata = { repairName: string; promiseFile: string };

function findRunMetadata(expectedHead: string, key: string, env: ReturnType<typeof envConfig>): RepairLaunchMetadata | null {
  const runsDir = path.join(env.stateDir, "runs");
  let entries: string[];
  try { entries = fs.readdirSync(runsDir); } catch { return null; }
  const matches: RepairLaunchMetadata[] = [];
  for (const entry of entries) {
    const runDir = path.join(runsDir, entry);
    try {
      const contract = JSON.parse(fs.readFileSync(path.join(runDir, "review-contract.json"), "utf8"));
      if (contract?.attemptKey === key && String(contract?.expectedHead || "").toLowerCase() === expectedHead.toLowerCase()) {
        matches.push({ repairName: "", promiseFile: path.join(runDir, "promise.json") });
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
    return promiseFile ? { repairName: String(evidence?.repairName || repairAgentName(prNumber, key, env)), promiseFile } : null;
  } catch {
    return null;
  }
}

function recoverLaunchFromHerdr(
  prNumber: string,
  branch: string,
  key: string,
  env: ReturnType<typeof envConfig>,
): boolean {
  const runner = createHerdrRunnerFromCommandRunner(commandRunner);
  const worktrees = runner.listWorktrees(env.repoPath).filter((worktree) => String(worktree.branch || "") === branch);
  const agents = runner.listAgents().filter((agent) => agent.name === repairAgentName(prNumber, key, env));
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

function launchRepair(
  prNumber: string,
  branch: string,
  expectedHead: string,
  findings: JsonObject[],
  key: string,
  env: ReturnType<typeof envConfig>,
  beforeAgentStart?: () => void,
): JsonObject {
  commandRunner.runText(["git", "check-ref-format", "--branch", branch]);
  const uuid = randomUUID();
  const runDir = path.join(env.stateDir, "runs", uuid);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(runDir, "review-contract.json"),
    `${JSON.stringify({ attemptKey: key, expectedHead, findingTitles: findings.map((finding) => String(finding.title)) })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const repairName = repairAgentName(prNumber, key, env);
  const promiseFile = path.join(runDir, "promise.json");
  try {
    const launch = launchAgentFlow(
      {
        worktree: { mode: "open", branch },
        repoPath: env.repoPath,
        automationDir: env.automationDir,
        stateDir: env.stateDir,
        name: repairName,
        agent: env.workerAgent,
        model: env.workerModel,
        level: "medium",
        uuid,
        promptFilePrefix: "review-repair-prompt",
        renderPrompt: ({ promiseFile, worktreePath }: { promiseFile: string; worktreePath: string }) =>
          repairWorkerPrompt(prNumber, branch, expectedHead, findings, key, promiseFile, worktreePath, env),
      },
      {
        mkdirSync: fs.mkdirSync,
        runner: createHerdrRunnerFromCommandRunner(commandRunner),
        runText: commandRunner.runText,
        writeFileSync: fs.writeFileSync,
        beforeAgentStart,
      },
    );
    return { repairName, ...launch };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      launch: { repairName, promiseFile },
    });
  }
}

function dispatch(args: JsonObject): DriverResult {
  const env = envConfig(args);
  if (!env.githubRepo) return driverResult("error", "DEADLOOP_GITHUB_REPO is required", { driverAction: "configuration_error" });
  const validation = validatePromise(String(args.promise));
  if (validation.status === "none" || validation.status === "invalid") {
    return driverResult("error", `reviewer promise is ${validation.status}`, { driverAction: "invalid_promise", validation });
  }
  const promise = validation.promise as JsonObject;
  const prNumber = String(args.pr);
  const expectedHead = String(args.expectedHead).toLowerCase();
  const branch = String(args.branch);
  const pr = readLivePr(env.githubRepo, prNumber);

  if (String(pr.state || "").toUpperCase() !== "OPEN" || Boolean(pr.isCrossRepository) || String(pr.headRefName || "") !== branch) {
    const comment = applyHumanBlock(prNumber, env, pr, "the selected PR is no longer a safe same-repository branch target", promise.summary);
    return driverResult("done", `PR #${prNumber} requires human intervention`, { driverAction: "review_human_blocked", comment });
  }
  if (validation.status === "blocked") {
    if (String(pr.headRefOid || "").toLowerCase() !== expectedHead) {
      return driverResult("done", `PR #${prNumber} head changed; left labels untouched for re-evaluation`, { driverAction: "review_stale_head" });
    }
    const technicalDecision = decideTechnicalReviewFailure(pr.comments || [], expectedHead);
    if (technicalDecision.action === "retry") {
      withRevalidatedPrMutation(prNumber, env, pr, (guardedGithub) => guardedGithub.commentPr(
        env.githubRepo,
        prNumber,
        `Reviewer technical failure will be retried once for this head: ${publicText(promise.reason, "technical review failure")}\n\n${renderTechnicalFailureMarker(expectedHead)}`,
      ));
      return driverResult("done", `PR #${prNumber} reviewer technical failure retained review labels for one retry`, {
        driverAction: "review_technical_retry",
      });
    }
    const comment = applyHumanBlock(prNumber, env, pr, "the reviewer failed technically twice on the same PR head", promise.summary);
    return driverResult("done", `PR #${prNumber} exhausted its technical review retry`, {
      driverAction: "review_technical_retry_exhausted",
      comment,
    });
  }

  const outcome = String(promise.outcome || "approved");
  const findings = (promise.findings || []) as JsonObject[];
  const reviewFingerprint = reviewOutcomeFingerprint(outcome, promise.reason || "", promise.summary || "", findings);
  const commentInput = {
    headOid: expectedHead,
    reason: promise.reason || "",
    summary: promise.summary || "",
    findings,
    reviewFingerprint,
    blockedLabel: env.blockedLabel,
  };

  if (outcome === "approved") {
    if (String(pr.headRefOid || "").toLowerCase() !== expectedHead) {
      return driverResult("done", `PR #${prNumber} head changed; left labels untouched for re-evaluation`, { driverAction: "review_stale_head" });
    }
    withRevalidatedPrMutation(prNumber, env, pr, (guardedGithub, livePr) => {
      if (!reviewCommentExists(livePr.comments || [], expectedHead, reviewFingerprint, outcome)) {
        guardedGithub.commentPr(env.githubRepo, prNumber, renderApprovedReviewComment(commentInput));
      }
    });
    return driverResult("done", `PR #${prNumber} review completed without actionable findings`, { driverAction: "review_approved" });
  }
  if (outcome === "human_required") {
    if (String(pr.headRefOid || "").toLowerCase() !== expectedHead) {
      return driverResult("done", `PR #${prNumber} head changed; left labels untouched for re-evaluation`, { driverAction: "review_stale_head" });
    }
    let comment = "Review result comment already exists.";
    withRevalidatedPrMutation(prNumber, env, pr, (guardedGithub, livePr) => {
      if (!reviewCommentExists(livePr.comments || [], expectedHead, reviewFingerprint, outcome)) {
        comment = renderHumanRequiredComment(commentInput);
        guardedGithub.commentPr(env.githubRepo, prNumber, comment);
      }
      const labels = labelNames(livePr.labels);
      if (labels.includes(env.reviewingLabel) || !labels.includes(env.blockedLabel)) {
        guardedGithub.movePrLabels(env.githubRepo, prNumber, { remove: env.reviewingLabel, add: env.blockedLabel });
      }
    });
    return driverResult("done", `PR #${prNumber} review requires a human`, { driverAction: "review_human_blocked", comment });
  }

  const worktree = inspectRepairWorktree(env.repoPath, branch);
  const refreshedPr = readLivePr(env.githubRepo, prNumber);
  if (String(refreshedPr.state || "").toUpperCase() !== "OPEN" || Boolean(refreshedPr.isCrossRepository) || String(refreshedPr.headRefName || "") !== branch) {
    const comment = applyHumanBlock(prNumber, env, refreshedPr, "the selected PR stopped being a safe same-repository branch target before repair dispatch", promise.summary);
    return driverResult("done", `PR #${prNumber} requires human intervention`, { driverAction: "review_human_blocked", comment });
  }
  if (worktree.kind === "ambiguous") {
    const comment = applyHumanBlock(prNumber, env, refreshedPr, "more than one worktree claims the repair branch", "Worktree ownership must be made unambiguous before another repair starts.");
    return driverResult("done", `PR #${prNumber} repair worktree ownership is ambiguous; marked blocked`, { driverAction: "review_repair_ambiguous_worktree", comment });
  }
  if (worktree.kind === "present" && !worktree.clean) {
    const comment = applyHumanBlock(prNumber, env, refreshedPr, "the existing repair worktree is dirty", "The existing repair worktree must be inspected before another repair starts.");
    return driverResult("done", `PR #${prNumber} repair worktree is dirty; marked blocked`, { driverAction: "review_repair_dirty_worktree", comment });
  }
  const refreshedHead = String(refreshedPr.headRefOid || "").toLowerCase();
  if (refreshedHead !== expectedHead) {
    if (worktree.kind === "present" && worktree.head === refreshedHead) {
      return driverResult("done", `PR #${prNumber} head changed before repair dispatch; left labels untouched for re-evaluation`, { driverAction: "review_stale_head" });
    }
    const comment = applyHumanBlock(prNumber, env, refreshedPr, "the refreshed PR head does not have one matching clean repair worktree", "The PR branch and worktree ownership must be reconciled before another repair starts.");
    return driverResult("done", `PR #${prNumber} refreshed head lacks a matching repair worktree; marked blocked`, { driverAction: "review_repair_worktree_mismatch", comment });
  }
  if (worktree.kind === "present" && worktree.head !== expectedHead) {
    const comment = applyHumanBlock(prNumber, env, refreshedPr, "the clean repair worktree and current PR head do not match", "The existing worktree must be reconciled without rewriting history before another repair starts.");
    return driverResult("done", `PR #${prNumber} repair worktree does not match its current head; marked blocked`, { driverAction: "review_repair_worktree_mismatch", comment });
  }

  const selection = selectRepairAttempt(refreshedPr.comments || [], expectedHead, findings);
  if (selection.action === "already_attempted") {
    let recoveredLaunch = readLaunchEvidence(prNumber, branch, expectedHead, selection.key, env);
    let workerConfirmed = Boolean(recoveredLaunch);
    if (!workerConfirmed) {
      workerConfirmed = recoverLaunchFromHerdr(prNumber, branch, selection.key, env);
      if (workerConfirmed) recoveredLaunch = findRunMetadata(expectedHead, selection.key, env);
    }
    if (workerConfirmed && recoveredLaunch) {
      withRevalidatedPrMutation(prNumber, env, refreshedPr, (guardedGithub, livePr) => {
        if (!reviewCommentExists(livePr.comments || [], expectedHead, selection.reviewFingerprint, outcome)) {
          guardedGithub.commentPr(
            env.githubRepo,
            prNumber,
            renderChangesRequestedComment({ ...commentInput, reviewFingerprint: selection.reviewFingerprint, repairAlreadyStarted: true }),
          );
        }
      });
      const monitorInput = {
        prNumber: Number(prNumber), expectedHeadOid: expectedHead, branch, automationDir: env.automationDir,
        promiseFile: recoveredLaunch.promiseFile, actorName: "review-repair worker", projectId: env.projectId,
        repoPath: env.repoPath, githubRepo: env.githubRepo, stateDir: env.stateDir, enabledAt: env.enabledAt,
        reviewLabel: env.reviewLabel, reviewingLabel: env.reviewingLabel, blockedLabel: env.blockedLabel,
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
      comment = applyHumanBlock(prNumber, env, refreshedPr, "the repair attempt was recorded but no confirmed worker launch exists", promise.summary, interruptionMarker);
    } else {
      const labels = labelNames(refreshedPr.labels);
      if (labels.includes(env.reviewingLabel) || !labels.includes(env.blockedLabel)) {
        withRevalidatedPrMutation(prNumber, env, refreshedPr, (guardedGithub) => guardedGithub.movePrLabels(env.githubRepo, prNumber, { remove: env.reviewingLabel, add: env.blockedLabel }));
      }
    }
    return driverResult("done", `PR #${prNumber} repair dispatch was interrupted; marked blocked`, { driverAction: "review_repair_dispatch_interrupted", selection, comment });
  }
  if (selection.action !== "launch_repair") {
    let comment = "Review result comment already exists.";
    withRevalidatedPrMutation(prNumber, env, refreshedPr, (guardedGithub, livePr) => {
      if (!reviewCommentExists(livePr.comments || [], expectedHead, selection.reviewFingerprint, outcome)) {
        comment = renderChangesRequestedComment({ ...commentInput, reviewFingerprint: selection.reviewFingerprint, repairUnavailable: true });
        guardedGithub.commentPr(env.githubRepo, prNumber, comment);
      }
      const labels = labelNames(livePr.labels);
      if (labels.includes(env.reviewingLabel) || !labels.includes(env.blockedLabel)) {
        guardedGithub.movePrLabels(env.githubRepo, prNumber, { remove: env.reviewingLabel, add: env.blockedLabel });
      }
    });
    return driverResult("done", `PR #${prNumber} repeated the same findings; marked blocked`, { driverAction: "review_repair_repeated", selection, comment });
  }

  let launch: JsonObject;
  try {
    launch = withEnabledDriverLaunch(
      env,
      (recheck: () => void) => {
        const guardedGithub = createGithubOperations(commandRunner, recheck);
        guardedGithub.commentPr(env.githubRepo, prNumber, renderChangesRequestedComment({ ...commentInput, reviewFingerprint: selection.reviewFingerprint }));
        guardedGithub.movePrLabels(env.githubRepo, prNumber, { add: [env.reviewLabel, env.reviewingLabel] });
      },
      (recheck: () => void) => launchRepair(prNumber, branch, expectedHead, findings, selection.key, env, recheck),
      {
        revalidate: () => {
          const livePr = readLivePr(env.githubRepo, prNumber);
          assertSameLaunchTarget(refreshedPr, livePr, "pr");
          const labels = labelNames(livePr.labels);
          if (!labels.includes(env.reviewLabel) || !labels.includes(env.reviewingLabel) || labels.includes(env.blockedLabel)) {
            throw new StaleLaunchError(`PR #${prNumber} is no longer eligible for repair`);
          }
          const liveSelection = selectRepairAttempt(livePr.comments || [], expectedHead, findings);
          if (liveSelection.action !== "launch_repair" || liveSelection.key !== selection.key) {
            throw new StaleLaunchError(`PR #${prNumber} repair attempt state changed before launch`);
          }
        },
      },
    );
  } catch (error) {
    if (isStaleLaunchError(error)) {
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
      const comment = applyHumanBlock(
        prNumber,
        env,
        latestPr,
        `the bounded repair launch failed after its attempt marker was recorded: ${error instanceof Error ? error.message : String(error)}`,
        promise.summary,
        `<!-- deadloop:review-repair-dispatch-stop key=${selection.key} -->`,
      );
      return driverResult("done", `PR #${prNumber} repair launch failed; marked blocked`, { driverAction: "review_repair_launch_failed", comment });
    }
  }

  let launchEvidenceError = "";
  try {
    recordLaunchEvidence(prNumber, branch, expectedHead, selection.key, {
      repairName: String(launch.repairName || repairAgentName(prNumber, selection.key, env)),
      promiseFile: String(launch.promiseFile),
    }, env);
  } catch (error) {
    launchEvidenceError = error instanceof Error ? error.message : String(error);
  }
  const monitorInput = {
    prNumber: Number(prNumber), expectedHeadOid: expectedHead, branch, automationDir: env.automationDir,
    promiseFile: launch.promiseFile, actorName: "review-repair worker", projectId: env.projectId,
    repoPath: env.repoPath, githubRepo: env.githubRepo, stateDir: env.stateDir, enabledAt: env.enabledAt,
    reviewLabel: env.reviewLabel, reviewingLabel: env.reviewingLabel, blockedLabel: env.blockedLabel,
    attemptKey: selection.key,
  };
  return driverResult("needs_llm", `Launched review-repair worker for PR #${prNumber}`, {
    driverAction: "review_repair_monitor_request", selection, labelsPreserved: [env.reviewLabel, env.reviewingLabel], launch,
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

module.exports = { dispatch, parseArgs, repairWorkerPrompt };
