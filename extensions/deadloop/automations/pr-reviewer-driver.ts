#!/usr/bin/env node
// Deterministic PR reviewer driver. Keep this CLI CommonJS-shaped so it can run
// directly under this package's `type: commonjs`, matching launch-agent.ts.

const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");
const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
const { planPrReviewerAction } = require("./pr-reviewer-flow.ts");
const { launchAgentFlow } = require("../../../src/agent-launch-flow.ts");
const { renderReviewerMonitorPrompt } = require("../../../src/monitor-prompts.ts");
const { renderProjectCheckCommand } = require("../../../src/project-check.ts");
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
    baseBranch: process.env.DEADLOOP_BASE_BRANCH || "origin/main",
    automationDir: SCRIPT_DIR,
    stateDir:
      process.env.DEADLOOP_STATE_DIR ||
      path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "deadloop"),
    checkCommand: process.env.DEADLOOP_CHECK_COMMAND || "git diff --check",
    reviewerAgent: process.env.DEADLOOP_REVIEWER_AGENT || "pi",
    reviewerModel: process.env.DEADLOOP_REVIEWER_MODEL || "",
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
- On success, write {"status":"complete","reason":"","summary":"three sentences: what was reviewed, result, remaining risk"}.
- If review is blocked by unsafe changes, missing CI, unclear spec, or uncertainty, write {"status":"blocked","reason":"clear reason","summary":"three-sentence summary"}.
- Always write the promise file, even on failure. Do not exit silently.`;
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

  githubOperations().movePrLabels(env.githubRepo, number, { add: env.reviewingLabel });
  const launch = launchAgentFlow(
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
  github.commentPr(env.githubRepo, number, comment);
  github.movePrLabels(env.githubRepo, number, { remove: env.reviewingLabel }, { check: false });
  github.movePrLabels(env.githubRepo, number, { remove: env.reviewLabel }, { check: false });
  github.movePrLabels(env.githubRepo, number, { add: env.blockedLabel });
}

function applyExternalReviewRequest(pr: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null): void {
  if (fixture) return;
  const number = String(pr.number);
  const head = String(pr.headRefOid || "");
  const github = githubOperations();
  github.addPrReviewer(env.githubRepo, number, "@copilot", { check: false });
  github.commentPr(env.githubRepo, number, `@coderabbitai review\n\n<!-- deadloop:external-review-request head=${head} -->`);
  github.movePrLabels(env.githubRepo, number, { remove: env.reviewingLabel }, { check: false });
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
  const launch = launchPrReviewer(pr, env, fixture, reason);
  return driverResult("needs_llm", `Launched reviewer agent for PR #${decision.number}`, {
    driverAction: "reviewer_monitor_request",
    prNumber: decision.number,
    gate,
    launch,
    prompt: renderReviewerMonitorPrompt({
      prNumber: Number(pr.number || 0),
      automationDir: env.automationDir,
      promiseFile: String(launch.promiseFile || ""),
      actorName: "reviewer",
      checkCommand: env.checkCommand,
      humanLabel: env.humanLabel,
      reviewingLabel: env.reviewingLabel,
      blockedLabel: env.blockedLabel,
    }),
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
