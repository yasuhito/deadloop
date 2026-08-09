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
const { launchAgentFlow, prepareAgentLaunchFlow, recordAgentLaunchGithubClaimed } = require("../../../src/agent-launch-flow.ts");
const { renderRepairMonitorPrompt } = require("../../../src/monitor-prompts.ts");
const {
  createCommandRunner,
  createHerdrRunnerFromCommandRunner,
  driverResult,
  shellQuote,
} = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { withEnabledDriverLaunch, withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { runHerdrCompatibilityPreflight } = require("../../../src/herdr-preflight.cjs");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { parseAttemptPersistenceMarkers, renderAttemptPersistenceMarker } = require("../../../src/attempt-persistence-marker.cjs");
const { StaleLaunchError, assertSameLaunchTarget, isStaleLaunchError, labelNames } = require("../../../src/launch-revalidation.ts");
const { readGithubRestResponseHeaders, validateActiveReviewClaim } = require("./pr-review-claim.ts");

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
    humanLabel: configValue(args, "humanLabel", process.env.DEADLOOP_HUMAN_LABEL, "ready-for-human"),
    inProgressLabel: configValue(args, "inProgressLabel", process.env.DEADLOOP_IN_PROGRESS_LABEL, "agent:in-progress"),
    reviewClaim: (() => {
      const value = configValue(args, "reviewClaim", process.env.DEADLOOP_REVIEW_CLAIM, "");
      if (!value) return null;
      try { return JSON.parse(value); } catch { throw new Error("review claim contract is malformed"); }
    })(),
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

function readLivePr(repo: string, prNumber: string, runner = commandRunner): JsonObject {
  const pr = runner.runJson([
    "gh",
    "pr",
    "view",
    prNumber,
    "-R",
    repo,
    "--json",
    "number,state,headRefName,headRefOid,isCrossRepository,labels,comments",
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
    const observation = createGithubOperations(commandRunner);
    const reauthorize = () => {
      if (env.reviewClaim && !validateActiveReviewClaim(
        observation.getPr(env.githubRepo, prNumber),
        observation.listPrTimelineEvents(env.githubRepo, prNumber),
        observation.listPrComments(env.githubRepo, prNumber),
        readGithubRestResponseHeaders(commandRunner, env.githubRepo),
        env.reviewClaim,
      )) throw new StaleLaunchError(`PR #${prNumber} active review claim could not be reauthorized`);
    };
    reauthorize();
    mutation(createGithubOperations(commandRunner, () => { recheck(); reauthorize(); }), livePr);
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
    ...(env.reviewClaim ? ["--review-claim", shellQuote(JSON.stringify(env.reviewClaim))] : []),
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
    worktree: { mode: "open" as const, branch },
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

function dispatch(args: JsonObject): DriverResult {
  runHerdrCompatibilityPreflight({ run: (command: string, commandArgs: string[]) => commandRunner.runText([command, ...commandArgs]) });
  const env = envConfig(args);
  if (!env.githubRepo) return driverResult("error", "DEADLOOP_GITHUB_REPO is required", { driverAction: "configuration_error" });
  const hasAttemptRecord = Boolean(args.attemptRecord && fs.existsSync(String(args.attemptRecord)));
  const validation = validatePromise(String(args.promise), hasAttemptRecord ? String(args.attemptRecord) : undefined);
  if (validation.status === "none" || validation.status === "invalid") {
    return driverResult("error", `reviewer promise is ${validation.status}`, { driverAction: "invalid_promise", validation });
  }
  const promise = validation.promise as JsonObject;
  const rawReport = hasAttemptRecord ? JSON.parse(fs.readFileSync(String(args.promise), "utf8")) : null;
  const attemptRecord = hasAttemptRecord ? readAttemptRecord(path.dirname(String(args.attemptRecord))) : null;
  const persistenceMarker = attemptRecord && rawReport?.schemaVersion === 1
    ? renderAttemptPersistenceMarker(attemptRecord, rawReport, {
        findings: rawReport.role === "reviewer" ? rawReport.result?.findings || [] : [],
        boundedRepairAttemptMarked: rawReport.role === "reviewer" && rawReport.result?.outcome === "changes_requested",
      })
    : "";
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
      const body = persistedReviewBody(livePr.comments || [], expectedHead, reviewFingerprint, outcome,
        renderApprovedReviewComment(commentInput), persistenceMarker, attemptRecord?.attemptId);
      if (body) guardedGithub.commentPr(env.githubRepo, prNumber, body);
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

  const automationLogin = commandRunner.runText(["gh", "api", "user", "--jq", ".login"]).trim();
  if (!automationLogin) throw new Error("authenticated GitHub identity is unavailable");
  const selection = selectRepairAttempt(refreshedPr.comments || [], expectedHead, findings, automationLogin);
  if (selection.cumulativeLimitExceeded) {
    const comment = applyHumanBlock(
      prNumber,
      env,
      refreshedPr,
      "the PR exceeded the cumulative limit of three automatic repair attempts",
      "Inspect the current head and correct the branch without rewriting history before removing the blocked label.",
    );
    return driverResult("done", `PR #${prNumber} exceeded the cumulative repair limit; marked blocked`, {
      driverAction: "review_repair_limit_reached",
      selection,
      comment,
    });
  }
  if (selection.action === "already_attempted") {
    let recoveredLaunch = readLaunchEvidence(prNumber, branch, expectedHead, selection.key, env);
    const retained = findRunMetadata(expectedHead, selection.key, env);
    if (!recoveredLaunch && retained?.launchUuid && ["prepared", "github_claimed"].includes(String(retained.phase || ""))) {
      const resumeUuid = retained.launchUuid;
      let resumed: JsonObject;
      try {
        resumed = withEnabledDriverLaunch(
          env,
          (recheck: () => void) => recheck(),
          (recheck: () => void) => launchRepair(prNumber, branch, expectedHead, findings, selection.key, env, recheck, resumeUuid),
          {
            prepareAttempt: () => launchRepair(prNumber, branch, expectedHead, findings, selection.key, env, undefined, resumeUuid, true),
            recordClaim: () => recordRepairLaunchGithubClaim(
              prNumber, branch, expectedHead, findings, selection.key, env, resumeUuid,
            ),
            revalidate: () => {
              const livePr = readLivePr(env.githubRepo, prNumber);
              assertSameLaunchTarget(refreshedPr, livePr, "pr");
              const labels = labelNames(livePr.labels);
              const liveSelection = selectRepairAttempt(livePr.comments || [], expectedHead, findings, automationLogin);
              if (liveSelection.cumulativeLimitExceeded) {
                throw new Error("cumulative_repair_limit_exceeded_before_recovery");
              }
              if (!labels.includes(env.reviewLabel) || !labels.includes(env.reviewingLabel) || labels.includes(env.blockedLabel)
                || liveSelection.action !== "already_attempted" || liveSelection.key !== selection.key) {
                throw new StaleLaunchError(`PR #${prNumber} interrupted repair is no longer resumable`);
              }
            },
          },
        );
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "cumulative_repair_limit_exceeded_before_recovery") throw error;
        const latestPr = readLivePr(env.githubRepo, prNumber);
        const comment = applyHumanBlock(
          prNumber,
          env,
          latestPr,
          "the PR exceeded the cumulative limit of three automatic repair attempts before recovery",
          "Inspect the current head and correct the branch without rewriting history before removing the blocked label.",
        );
        return driverResult("done", `PR #${prNumber} exceeded the cumulative repair limit; marked blocked`, {
          driverAction: "review_repair_limit_reached",
          comment,
        });
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
        promiseFile: recoveredLaunch.promiseFile, attemptRecordFile: path.join(path.dirname(recoveredLaunch.promiseFile), "attempt.json"), actorName: "review-repair worker", projectId: env.projectId,
        repoPath: env.repoPath, githubRepo: env.githubRepo, stateDir: env.stateDir, enabledAt: env.enabledAt,
        reviewLabel: env.reviewLabel, reviewingLabel: env.reviewingLabel, blockedLabel: env.blockedLabel,
        reviewClaim: env.reviewClaim,
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
        comment = renderChangesRequestedComment({
          ...commentInput,
          reviewFingerprint: selection.reviewFingerprint,
          repairUnavailable: true,
          repairUnavailableReason: selection.reason,
        });
        guardedGithub.commentPr(env.githubRepo, prNumber, comment);
      }
      const labels = labelNames(livePr.labels);
      if (labels.includes(env.reviewingLabel) || !labels.includes(env.blockedLabel)) {
        guardedGithub.movePrLabels(env.githubRepo, prNumber, { remove: env.reviewingLabel, add: env.blockedLabel });
      }
    });
    const cumulativeLimitReached = selection.reason === "cumulative_repair_limit";
    return driverResult(
      "done",
      cumulativeLimitReached
        ? `PR #${prNumber} reached the cumulative repair limit; marked blocked`
        : `PR #${prNumber} repeated the same findings; marked blocked`,
      {
        driverAction: cumulativeLimitReached ? "review_repair_limit_reached" : "review_repair_repeated",
        selection,
        comment,
      },
    );
  }

  const repairLaunchUuid = randomUUID();
  const preparedRepair = launchRepair(
    prNumber, branch, expectedHead, findings, selection.key, env, undefined, repairLaunchUuid, true,
  );

  if (hasAttemptRecord) {
    withRevalidatedPrMutation(prNumber, env, refreshedPr, (guardedGithub, livePr) => {
      const body = persistedReviewBody(livePr.comments || [], expectedHead, selection.reviewFingerprint, outcome,
        renderChangesRequestedComment({ ...commentInput, reviewFingerprint: selection.reviewFingerprint }),
        persistenceMarker, attemptRecord?.attemptId);
      if (body) guardedGithub.commentPr(env.githubRepo, prNumber, body);
      guardedGithub.movePrLabels(env.githubRepo, prNumber, { add: [env.reviewLabel, env.reviewingLabel] });
    });
    const closed = commandRunner.runJson([
      "node", path.join(env.automationDir, "complete-attempt-workspace.ts"),
      "--attempt-record", String(args.attemptRecord),
      "--project-id", env.projectId,
      "--project-repo", env.repoPath,
      "--github-repo", env.githubRepo,
      "--state-dir", env.stateDir,
      "--enabled-at", String(env.enabledAt),
      "--expected-label", env.reviewLabel,
      "--expected-label", env.reviewingLabel,
      "--managed-label", env.reviewLabel,
      "--managed-label", env.reviewingLabel,
      "--managed-label", env.blockedLabel,
      "--managed-label", env.humanLabel,
    ]);
    if (closed?.driverAction !== "workspace_closed") throw new Error("reviewer workspace was not closed before repair launch");
  }

  let launch: JsonObject;
  try {
    launch = withEnabledDriverLaunch(
      env,
      (recheck: () => void) => {
        if (hasAttemptRecord) {
          recheck();
          return;
        }
        const guardedGithub = createGithubOperations(commandRunner, recheck);
        guardedGithub.commentPr(env.githubRepo, prNumber, renderChangesRequestedComment({ ...commentInput, reviewFingerprint: selection.reviewFingerprint }));
        guardedGithub.movePrLabels(env.githubRepo, prNumber, { add: [env.reviewLabel, env.reviewingLabel] });
      },
      (recheck: () => void) => launchRepair(prNumber, branch, expectedHead, findings, selection.key, env, recheck, repairLaunchUuid),
      {
        prepareAttempt: () => launchRepair(
          prNumber, branch, expectedHead, findings, selection.key, env, undefined, repairLaunchUuid, true,
        ),
        recordClaim: () => recordRepairLaunchGithubClaim(
          prNumber, branch, expectedHead, findings, selection.key, env, repairLaunchUuid,
        ),
        revalidate: () => {
          const livePr = readLivePr(env.githubRepo, prNumber);
          assertSameLaunchTarget(refreshedPr, livePr, "pr");
          const labels = labelNames(livePr.labels);
          if (!labels.includes(env.reviewLabel) || !labels.includes(env.reviewingLabel) || labels.includes(env.blockedLabel)) {
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
          if (liveSelection.cumulativeLimitExceeded) {
            throw new Error("cumulative_repair_limit_exceeded_before_launch");
          }
          if ((liveSelection.action !== "launch_repair" || liveSelection.key !== selection.key) && !markerOwnedByPreparedRepair) {
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
    if (error instanceof Error && error.message === "cumulative_repair_limit_exceeded_before_launch") {
      const latestPr = readLivePr(env.githubRepo, prNumber);
      const comment = applyHumanBlock(
        prNumber,
        env,
        latestPr,
        "the PR exceeded the cumulative limit of three automatic repair attempts before launch",
        "Inspect the current head and correct the branch without rewriting history before removing the blocked label.",
      );
      return driverResult("done", `PR #${prNumber} exceeded the cumulative repair limit; marked blocked`, {
        driverAction: "review_repair_limit_reached",
        comment,
      });
    }
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
    reviewLabel: env.reviewLabel, reviewingLabel: env.reviewingLabel, blockedLabel: env.blockedLabel,
    reviewClaim: env.reviewClaim,
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

module.exports = { dispatch, envConfig, launchRepair, parseArgs, readLivePr, recordRepairLaunchGithubClaim, repairWorkerPrompt };
