#!/usr/bin/env node
// Deterministic PR reviewer driver. Keep this CLI CommonJS-shaped so it can run
// directly under this package's `type: commonjs`, matching launch-agent.ts.

const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");
const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
const { planPrReviewerAction } = require("./pr-reviewer-flow.ts");
const { launchAgentFlow } = require("../../../src/agent-launch-flow.ts");
const { renderBranchUpdateMonitorPrompt, renderReviewerMonitorPrompt } = require("../../../src/monitor-prompts.ts");
const { renderProjectCheckCommand } = require("../../../src/project-check.ts");
const { decideBranchUpdateLive } = require("./pr-branch-update-decision.ts");
const { branchUpdateAttemptExists, branchUpdateRetryKey, renderBranchUpdateMarker } = require("./pr-branch-update-state.ts");
const {
  createCommandRunner,
  createHerdrRunnerFromCommandRunner,
  driverResult,
  loadFixture,
  oneLine,
  parseBool,
  parseFixtureArg,
  shellQuote,
} = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { withEnabledDriverLaunch, withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { StaleLaunchError, assertSameLaunchTarget, isStaleLaunchError } = require("../../../src/launch-revalidation.ts");

import type { DriverResult, JsonObject } from "../../../src/automation-driver-kit";

const SCRIPT_DIR = __dirname;
const commandRunner = createCommandRunner();
const { runText } = commandRunner;

function herdrRunner() {
  return createHerdrRunnerFromCommandRunner(commandRunner);
}

function githubOperations() {
  return createGithubOperations(commandRunner);
}

function envConfig() {
  return {
    projectId: process.env.DEADLOOP_PROJECT_ID || "project",
    repoPath: process.env.DEADLOOP_REPO_PATH || ".",
    githubRepo: process.env.DEADLOOP_GITHUB_REPO || "",
    enabledAt: Number(process.env.DEADLOOP_ENABLED_AT),
    baseBranch: process.env.DEADLOOP_BASE_BRANCH || "origin/main",
    automationDir: SCRIPT_DIR,
    stateDir:
      process.env.DEADLOOP_STATE_DIR ||
      path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "deadloop"),
    checkCommand: process.env.DEADLOOP_CHECK_COMMAND || "git diff --check",
    reviewerAgent: process.env.DEADLOOP_REVIEWER_AGENT || "pi",
    reviewerModel: process.env.DEADLOOP_REVIEWER_MODEL || "",
    branchUpdateAgent: process.env.DEADLOOP_WORKER_AGENT || "pi",
    branchUpdateModel: process.env.DEADLOOP_WORKER_MODEL || "",
    branchUpdateRemote: process.env.DEADLOOP_BRANCH_UPDATE_REMOTE || "origin",
    reviewLabel: process.env.DEADLOOP_REVIEW_LABEL || "agent:review",
    reviewingLabel: process.env.DEADLOOP_REVIEWING_LABEL || "agent:reviewing",
    humanLabel: process.env.DEADLOOP_HUMAN_LABEL || "ready-for-human",
    blockedLabel: process.env.DEADLOOP_BLOCKED_LABEL || "agent:blocked",
    implementLabel: process.env.DEADLOOP_IMPLEMENT_LABEL || "agent:implement",
    autoMerge: parseBool(process.env.DEADLOOP_AUTO_MERGE),
    externalReviewEnabled: parseBool(process.env.DEADLOOP_EXTERNAL_REVIEW_ENABLED),
    externalReviewWaitSeconds: process.env.DEADLOOP_EXTERNAL_REVIEW_WAIT_SECONDS || "1800",
    now: process.env.DEADLOOP_NOW || "",
  };
}

function livePrs(repo: string): JsonObject[] {
  return githubOperations().listOpenPrs(repo);
}

function liveAgents(): any {
  try {
    return herdrRunner().listAgents();
  } catch {
    return [];
  }
}

function shouldSimulateLaunch(fixture: JsonObject | null): boolean {
  return Boolean(fixture);
}

function reviewAgentPrompt(
  pr: JsonObject,
  env: ReturnType<typeof envConfig>,
  promiseFile: string,
  reason: string,
  worktreePath: string,
): string {
  const number = Number(pr.number || 0);
  const title = oneLine(pr.title || "PR review");
  return `Review PR #${number}.

Target:
- GitHub repo: ${env.githubRepo}
- PR: #${number} ${title}
- PR URL: ${pr.url || `https://github.com/${env.githubRepo}/pull/${number}`}
- Reason: ${reason}
- autoMerge: ${env.autoMerge ? "true" : "false"}

Contract:
- Do not edit the main workspace ${env.repoPath}; inspect only this worktree.
- Read the PR diff, related issues/docs, and AGENTS.md. Check both spec fit and repository standards.
- Run needed validation. Minimum check command: ${renderProjectCheckCommand({
    automationDir: env.automationDir,
    stateDir: env.stateDir,
    cwd: worktreePath,
    command: env.checkCommand,
  })}
- Do not push, edit labels, comment on PRs, merge, or delete branches.
- If autoMerge=false, summarize the review for human handoff even if the PR looks mergeable.

Promise report:
- Before stopping, write JSON to the promise file: \`${promiseFile.replace(/`/g, "\\`")}\`.
- Keep status limited to complete|blocked. Use blocked only when the review itself could not complete for a technical reason; actionable code, lint, test, documentation, or contract defects are a successful review.
- If no actionable defect remains, write {"status":"complete","outcome":"approved","reason":"","summary":"three sentences: what was reviewed, result, remaining risk","findings":[]}.
- If actionable defects exist, write {"status":"complete","outcome":"changes_requested","reason":"","summary":"three-sentence summary","findings":[{"title":"concise defect","body":"bounded required correction and evidence","path":"optional/repo/path","line":1,"severity":"blocker|major|minor"}]}.
- Use outcome=human_required only when a product/spec/safety decision cannot be repaired within the PR. Explain it in reason and optional findings.
- Findings are the repair worker's entire contract. Include only verified, actionable defects; #243-style lint or repository-contract failures are changes_requested, not blocked.
- Always write the promise file, even on failure. Do not exit silently.`;
}

function branchUpdateWorkerPrompt(
  pr: JsonObject,
  env: ReturnType<typeof envConfig>,
  promiseFile: string,
  worktreePath: string,
  headOid: string,
  baseOid: string,
): string {
  const number = Number(pr.number || 0);
  const branch = String(pr.headRefName || "");
  const finalizeCommand = [
    "node",
    shellQuote(path.join(env.automationDir, "pr-branch-update-finalize.ts")),
    "--repo",
    shellQuote(worktreePath),
    "--project-repo",
    shellQuote(env.repoPath),
    "--github-repo",
    shellQuote(env.githubRepo),
    "--pr",
    String(number),
    "--branch",
    shellQuote(branch),
    "--expected-head",
    shellQuote(headOid),
    "--expected-base",
    shellQuote(baseOid),
    "--remote",
    shellQuote(env.branchUpdateRemote),
    "--automation-dir",
    shellQuote(env.automationDir),
    "--state-dir",
    shellQuote(env.stateDir),
    "--enabled-at",
    String(env.enabledAt),
    "--check-command",
    shellQuote(env.checkCommand),
  ].join(" ");
  return `Update the existing branch for PR #${number} by merging the selected base head and resolving its conflicts.

Exact target:
- GitHub repo: ${env.githubRepo}
- PR: #${number}
- Only branch you may push: ${branch}
- Expected PR head: ${headOid}
- Selected configured base head: ${baseOid}

Safety contract:
- Work only in ${worktreePath}; never edit the main workspace ${env.repoPath}.
- First require a clean worktree and require HEAD to equal the expected PR head.
- Merge ${baseOid} into the existing PR branch. Use git merge, never rebase, and never rewrite existing commits.
- Resolve only conflicts caused by this merge. Do not widen the PR's scope.
- Commit the merge resolution before finalization.
- Do not run git push directly. After resolving and committing, run exactly this finalizer; it runs all configured checks and atomically updates only the driver-selected branch if its head still equals the validated PR head:
  ${finalizeCommand}
- Never force-push. Never push another ref. Never edit labels, create or edit a PR, merge a PR, close an issue, or delete a branch.
- If the finalizer returns stale_head, stop without pushing or changing GitHub state so the next cycle can re-evaluate.

Promise report:
- Always write JSON to ${promiseFile} before stopping.
- After finalizer action=pushed, write {"status":"complete","reason":"branch_updated","summary":"what conflicts were resolved and checks passed"}.
- After finalizer action=stale_head, write {"status":"complete","reason":"stale_head","summary":"PR head changed; stopped without push"}.
- On merge, validation, invariant, or push failure, write {"status":"blocked","reason":"specific failure","summary":"what failed and why the update is unsafe"}.
- Do not claim complete unless the finalizer returned pushed or stale_head.`;
}

function fixtureBranchUpdateDecision(pr: JsonObject, fixture: JsonObject): JsonObject {
  const configured = fixture.branchUpdate;
  if (!configured) return { action: "no_update", reason: "fixture_default", headOid: pr.headRefOid || "", baseOid: "fixture-base" };
  return { headOid: pr.headRefOid || "", baseOid: configured.baseOid || "fixture-base", ...configured };
}

function liveBranchUpdateDecision(pr: JsonObject, env: ReturnType<typeof envConfig>): JsonObject {
  const number = Number(pr.number || 0);
  const expectedHead = String(pr.headRefOid || "");
  if (!expectedHead) throw new Error(`PR #${number} has no head SHA`);
  runText(["git", "-C", env.repoPath, "fetch", "--quiet", "--prune"]);
  runText(["git", "-C", env.repoPath, "fetch", "--quiet", env.branchUpdateRemote, `pull/${number}/head`]);
  const baseOid = runText(["git", "-C", env.repoPath, "rev-parse", "--verify", env.baseBranch]).trim();
  const decision = decideBranchUpdateLive(env.repoPath, expectedHead, baseOid, expectedHead, { requireCleanWorktree: false });
  return { ...decision, baseOid };
}

function branchUpdateDecision(pr: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null): JsonObject {
  if (String(pr.mergeStateStatus || "").toUpperCase() !== "CONFLICTING") {
    return { action: "no_update", reason: "pr_not_conflicting", headOid: pr.headRefOid || "", baseOid: "" };
  }
  return fixture ? fixtureBranchUpdateDecision(pr, fixture) : liveBranchUpdateDecision(pr, env);
}

function branchUpdateBlockedComment(pr: JsonObject, env: ReturnType<typeof envConfig>, reason: string): string {
  return `## What happened
- Automatic branch update for PR #${Number(pr.number || 0)} stopped because ${reason}.
- No force-push was attempted. A human must inspect the existing PR branch before re-queueing it.

## Recovery steps
1. Inspect the PR head, checks, and branch-update comments.
   \`\`\`bash
gh pr view ${Number(pr.number || 0)} -R ${shellQuote(env.githubRepo)} --comments --json number,state,headRefName,headRefOid,labels,statusCheckRollup
   \`\`\`
2. Resolve the failure without rewriting the PR branch.
3. After changing either the PR head or configured base head, remove ${env.blockedLabel}; the new exact head/base pair may be attempted once.`;
}

function applyBranchUpdateBlocked(pr: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null, reason: string): string {
  const comment = branchUpdateBlockedComment(pr, env, reason);
  if (!fixture) {
    const github = githubOperations();
    withEnabledDriverLock(env, () => github.commentPr(env.githubRepo, Number(pr.number || 0), comment));
    withEnabledDriverLock(env, () => github.movePrLabels(env.githubRepo, Number(pr.number || 0), { remove: env.reviewingLabel, add: env.blockedLabel }));
  }
  return comment;
}

function launchBranchUpdate(
  pr: JsonObject,
  env: ReturnType<typeof envConfig>,
  fixture: JsonObject | null,
  decision: JsonObject,
): JsonObject {
  const number = Number(pr.number || 0);
  const branch = String(pr.headRefName || "");
  const headOid = String(decision.headOid || pr.headRefOid || "");
  const baseOid = String(decision.baseOid || "");
  const key = branchUpdateRetryKey(headOid, baseOid);
  const updaterName = `${env.projectId}-pr-${number}-branch-update-${key}`;
  const uuid = fixture ? "fixture-branch-update-uuid" : randomUUID();
  if (fixture) {
    return {
      updaterName,
      headRefName: branch,
      retryKey: key,
      workspaceId: "fixture-update-workspace",
      tabId: "fixture-update-tab",
      worktreePath: `/worktrees/${env.projectId}/${branch.replace(/\//g, "-")}`,
      promptFile: `${env.stateDir}/runs/${uuid}/branch-update-prompt.md`,
      promiseFile: `${env.stateDir}/runs/${uuid}/promise.json`,
      simulated: true,
    };
  }

  runText(["git", "check-ref-format", "--branch", branch]);
  const marker = renderBranchUpdateMarker(headOid, baseOid);
  const github = githubOperations();
  const launch = withEnabledDriverLaunch(
    env,
    () => {
      github.commentPr(env.githubRepo, number, `Starting one guarded merge update for the current PR/base pair.\n\n${marker}`);
      github.movePrLabels(env.githubRepo, number, { add: env.reviewingLabel });
    },
    () => launchAgentFlow(
      {
        worktree: { mode: "open", branch },
        repoPath: env.repoPath,
        automationDir: env.automationDir,
        stateDir: env.stateDir,
        name: updaterName,
        agent: env.branchUpdateAgent,
        model: env.branchUpdateModel,
        level: "medium",
        uuid,
        promptFilePrefix: "branch-update-prompt",
        renderPrompt: ({ promiseFile, worktreePath }: { promiseFile: string; worktreePath: string }) =>
          branchUpdateWorkerPrompt(pr, env, promiseFile, worktreePath, headOid, baseOid),
      },
      { mkdirSync: fs.mkdirSync, runner: herdrRunner(), runText, writeFileSync: fs.writeFileSync },
    ),
    {
      revalidate: () => {
        const livePlan = planPrReviewerAction(livePrs(env.githubRepo), liveAgents(), env);
        if (!("pr" in livePlan)) throw new StaleLaunchError(`PR #${number} is no longer eligible`);
        assertSameLaunchTarget(pr, livePlan.pr, "pr");
        const liveDecision = branchUpdateDecision(livePlan.pr, env, null);
        if (
          liveDecision.action !== "delegate_worker"
          || String(liveDecision.headOid || "") !== headOid
          || String(liveDecision.baseOid || "") !== baseOid
          || branchUpdateAttemptExists(livePlan.pr.comments || [], headOid, baseOid)
        ) throw new StaleLaunchError(`PR #${number} branch-update target changed before launch`);
      },
    },
  );
  return { updaterName, headRefName: branch, retryKey: key, ...launch };
}

function launchPrReviewer(pr: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null, reason: string): JsonObject {
  const number = Number(pr.number || 0);
  const uuid = shouldSimulateLaunch(fixture) ? "fixture-reviewer-uuid" : randomUUID();
  const reviewerName = `${env.projectId}-pr-${number}-reviewer`;
  const headRefName = String(pr.headRefName || `pr-${number}`);
  const simulatedWorktreePath = `/worktrees/${env.projectId}/${headRefName.replace(/\//g, "-")}`;

  if (shouldSimulateLaunch(fixture)) {
    return {
      reviewerName,
      headRefName,
      workspaceId: "fixture-workspace",
      tabId: "fixture-tab",
      worktreePath: simulatedWorktreePath,
      promptFile: `${env.stateDir}/runs/${uuid}/reviewer-prompt.md`,
      promiseFile: `${env.stateDir}/runs/${uuid}/promise.json`,
      simulated: true,
    };
  }

  const launch = withEnabledDriverLaunch(
    env,
    () => githubOperations().movePrLabels(env.githubRepo, number, { add: env.reviewingLabel }),
    () => launchAgentFlow(
      {
        worktree: { mode: "open", branch: headRefName },
        repoPath: env.repoPath,
        automationDir: env.automationDir,
        stateDir: env.stateDir,
        name: reviewerName,
        agent: env.reviewerAgent,
        model: env.reviewerModel,
        level: "medium",
        uuid,
        promptFilePrefix: "reviewer-prompt",
        renderPrompt: ({ promiseFile, worktreePath }: { promiseFile: string; worktreePath: string }) =>
          reviewAgentPrompt(pr, env, promiseFile, reason, worktreePath),
      },
      { mkdirSync: fs.mkdirSync, runner: herdrRunner(), runText, writeFileSync: fs.writeFileSync },
    ),
    {
      revalidate: () => {
        const livePlan = planPrReviewerAction(livePrs(env.githubRepo), liveAgents(), env);
        if (livePlan.kind !== "review_required") throw new StaleLaunchError(`PR #${number} is no longer eligible for reviewer launch`);
        assertSameLaunchTarget(pr, livePlan.pr, "pr");
        if (branchUpdateDecision(livePlan.pr, env, null).action !== "no_update") {
          throw new StaleLaunchError(`PR #${number} branch-update state changed before reviewer launch`);
        }
      },
    },
  );
  return { reviewerName, headRefName, ...launch };
}

function draftBlockedComment(pr: JsonObject, env: ReturnType<typeof envConfig>): string {
  const number = Number(pr.number || 0);
  const headRefName = oneLine(pr.headRefName || "<headRefName>");
  return `## What happened
- Skipped automated review and auto-merge because the PR is a draft.
- Confirmed facts:
- PR #${number} is in draft state.
- Next decision: mark the PR ready and add \`${env.reviewLabel}\` again when it is ready for review.

## Recovery steps
1. Inspect the cause.
   \`\`\`bash
gh pr view ${number} -R ${shellQuote(env.githubRepo)} --comments --json number,title,url,headRefName,headRefOid,labels,commits,statusCheckRollup
gh pr checks ${number} -R ${shellQuote(env.githubRepo)}
node ${shellQuote(env.automationDir)}/extract-worker-promise.ts --file '<promiseFile>' || true
herdr agent list
herdr pane list
\`\`\`
2. Inspect leftover worktrees or branches before cleanup.
   Not applicable: the draft gate did not create a worktree or branch.
   \`\`\`bash
herdr worktree list --cwd ${shellQuote(env.repoPath)} --json
git -C ${shellQuote(env.repoPath)} worktree list
git -C ${shellQuote(env.repoPath)} branch --list ${shellQuote(headRefName)}
herdr worktree remove --workspace '<workspaceId>'
git -C ${shellQuote(env.repoPath)} worktree remove '<worktreePath>'
git -C ${shellQuote(env.repoPath)} branch -d ${shellQuote(headRefName)}
\`\`\`
3. Re-queue the target issue after fixing the cause.
   \`\`\`bash
gh issue edit <issueNumber> -R ${shellQuote(env.githubRepo)} --remove-label ${shellQuote(env.blockedLabel)} --add-label ${shellQuote(env.implementLabel)}
\`\`\``;
}

function applyDraftGate(pr: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null, comment: string): void {
  if (fixture) return;
  const number = String(pr.number);
  const github = githubOperations();
  withEnabledDriverLock(env, () => github.commentPr(env.githubRepo, number, comment));
  withEnabledDriverLock(env, () => github.movePrLabels(env.githubRepo, number, { remove: env.reviewingLabel }, { check: false }));
  withEnabledDriverLock(env, () => github.movePrLabels(env.githubRepo, number, { remove: env.reviewLabel }, { check: false }));
  withEnabledDriverLock(env, () => github.movePrLabels(env.githubRepo, number, { add: env.blockedLabel }));
}

function applyExternalReviewRequest(pr: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null): void {
  if (fixture) return;
  const number = String(pr.number);
  const head = String(pr.headRefOid || "");
  const github = githubOperations();
  withEnabledDriverLock(env, () => github.addPrReviewer(env.githubRepo, number, "@copilot", { check: false }));
  withEnabledDriverLock(env, () => github.commentPr(env.githubRepo, number, `@coderabbitai review\n\n<!-- deadloop:external-review-request head=${head} -->`));
  withEnabledDriverLock(env, () => github.movePrLabels(env.githubRepo, number, { remove: env.reviewingLabel }, { check: false }));
}

function drive(fixturePath: string | undefined): DriverResult {
  const fixture = loadFixture(fixturePath);
  const env = envConfig();
  if (!env.githubRepo && !fixture) return driverResult("error", "DEADLOOP_GITHUB_REPO is required", { driverAction: "configuration_error" });

  const prs = fixture ? fixture.prs || [] : livePrs(env.githubRepo);
  const agents = fixture ? fixture.agents || { result: { agents: [] } } : liveAgents();
  const plan = planPrReviewerAction(prs, agents, env);

  if (plan.kind === "skip_no_candidate" || plan.kind === "skip_wait") {
    return driverResult("skip", plan.summary, { driverAction: plan.driverAction, decision: plan.decision });
  }

  if (plan.kind === "draft_gate") {
    const comment = draftBlockedComment(plan.pr, env);
    applyDraftGate(plan.pr, env, fixture, comment);
    return driverResult("done", `PR #${plan.decision.number} is draft; marked blocked`, {
      driverAction: "draft_blocked",
      prNumber: plan.decision.number,
      comment,
    });
  }

  const updateDecision = branchUpdateDecision(plan.pr, env, fixture);
  if (updateDecision.action === "blocked") {
    if (updateDecision.reason === "stale_head") {
      return driverResult("skip", `PR #${plan.decision.number} head changed while planning; will re-evaluate next cycle`, {
        driverAction: "branch_update_stale",
        prNumber: plan.decision.number,
        branchUpdate: updateDecision,
      });
    }
    const comment = applyBranchUpdateBlocked(plan.pr, env, fixture, String(updateDecision.reason || "unsafe branch-update state"));
    return driverResult("done", `PR #${plan.decision.number} branch update is unsafe; marked blocked`, {
      driverAction: "branch_update_blocked",
      prNumber: plan.decision.number,
      branchUpdate: updateDecision,
      comment,
    });
  }

  if (updateDecision.action === "delegate_worker") {
    const headOid = String(updateDecision.headOid || plan.pr.headRefOid || "");
    const baseOid = String(updateDecision.baseOid || "");
    if (Boolean(plan.pr.isCrossRepository)) {
      const comment = applyBranchUpdateBlocked(plan.pr, env, fixture, "the PR comes from another repository");
      return driverResult("done", `PR #${plan.decision.number} is cross-repository; marked blocked`, {
        driverAction: "branch_update_blocked",
        prNumber: plan.decision.number,
        branchUpdate: updateDecision,
        comment,
      });
    }
    const marker = renderBranchUpdateMarker(headOid, baseOid);
    if (branchUpdateAttemptExists(plan.pr.comments || [], headOid, baseOid)) {
      const comment = applyBranchUpdateBlocked(plan.pr, env, fixture, "this exact PR head/base head pair already used its one attempt");
      return driverResult("done", `PR #${plan.decision.number} exact branch-update pair was already attempted; marked blocked`, {
        driverAction: "branch_update_attempt_exhausted",
        prNumber: plan.decision.number,
        retryKey: branchUpdateRetryKey(headOid, baseOid),
        marker,
        comment,
      });
    }
    try {
      const launch = launchBranchUpdate(plan.pr, env, fixture, updateDecision);
      const monitorInput = {
        prNumber: Number(plan.pr.number || 0),
        expectedHeadOid: headOid,
        expectedBaseOid: baseOid,
        branch: String(plan.pr.headRefName || ""),
        automationDir: env.automationDir,
        promiseFile: String(launch.promiseFile || ""),
        actorName: "branch-update worker",
        projectId: env.projectId,
        repoPath: env.repoPath,
        githubRepo: env.githubRepo,
        stateDir: env.stateDir,
        enabledAt: env.enabledAt,
        reviewingLabel: env.reviewingLabel,
        reviewLabel: env.reviewLabel,
        blockedLabel: env.blockedLabel,
      };
      return driverResult("needs_llm", `Launched branch-update worker for PR #${plan.decision.number}`, {
        driverAction: "branch_update_monitor_request",
        prNumber: plan.decision.number,
        branchUpdate: updateDecision,
        marker,
        labelsPreserved: [env.reviewLabel, env.reviewingLabel],
        launch,
        monitorHandoff: { kind: "branch-update", input: monitorInput },
        prompt: renderBranchUpdateMonitorPrompt(monitorInput),
      });
    } catch (error) {
      if (isStaleLaunchError(error)) {
        return driverResult("skip", `PR #${plan.decision.number} changed before branch-update launch; no workflow state was mutated`, {
          driverAction: "branch_update_launch_stale",
          prNumber: plan.decision.number,
        });
      }
      const reason = `branch-update launch failed: ${error instanceof Error ? error.message : String(error)}`;
      const comment = applyBranchUpdateBlocked(plan.pr, env, fixture, reason);
      return driverResult("done", `PR #${plan.decision.number} branch-update launch failed; marked blocked`, {
        driverAction: "branch_update_launch_failed",
        prNumber: plan.decision.number,
        marker,
        comment,
      });
    }
  }

  if (plan.kind === "external_review_request") {
    applyExternalReviewRequest(plan.pr, env, fixture);
    return driverResult("done", `Requested external review for PR #${plan.decision.number}`, {
      driverAction: "external_review_requested",
      prNumber: plan.decision.number,
      gate: plan.gate,
    });
  }
  if (plan.kind === "external_review_wait") {
    return driverResult("skip", `Waiting for external review on PR #${plan.decision.number}`, {
      driverAction: "wait",
      prNumber: plan.decision.number,
      gate: plan.gate,
    });
  }

  const { pr, gate, reason } = plan;
  const decision = plan.decision;
  let launch: JsonObject;
  try {
    launch = launchPrReviewer(pr, env, fixture, reason);
  } catch (error) {
    if (isStaleLaunchError(error)) {
      return driverResult("skip", `PR #${decision.number} changed before reviewer launch; no workflow state was mutated`, {
        driverAction: "reviewer_launch_stale",
        prNumber: decision.number,
      });
    }
    throw error;
  }
  const monitorInput = {
    prNumber: Number(pr.number || 0),
    expectedHeadOid: String(pr.headRefOid || ""),
    branch: String(pr.headRefName || ""),
    automationDir: env.automationDir,
    promiseFile: String(launch.promiseFile || ""),
    actorName: "reviewer",
    projectId: env.projectId,
    repoPath: env.repoPath,
    githubRepo: env.githubRepo,
    stateDir: env.stateDir,
    enabledAt: env.enabledAt,
    checkCommand: renderProjectCheckCommand({
      automationDir: env.automationDir,
      stateDir: env.stateDir,
      cwd: String(launch.worktreePath || ""),
      command: env.checkCommand,
    }),
    projectCheckCommand: env.checkCommand,
    workerAgent: env.branchUpdateAgent,
    workerModel: env.branchUpdateModel,
    repairRemote: env.branchUpdateRemote,
    humanLabel: env.humanLabel,
    reviewLabel: env.reviewLabel,
    reviewingLabel: env.reviewingLabel,
    blockedLabel: env.blockedLabel,
  };
  return driverResult("needs_llm", `Launched reviewer agent for PR #${decision.number}`, {
    driverAction: "reviewer_monitor_request",
    prNumber: decision.number,
    gate,
    launch,
    monitorHandoff: { kind: "reviewer", input: monitorInput },
    prompt: renderReviewerMonitorPrompt(monitorInput),
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

main();
