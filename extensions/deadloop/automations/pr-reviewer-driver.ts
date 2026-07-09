#!/usr/bin/env node
// Deterministic PR reviewer driver. Keep this CLI CommonJS-shaped so it can run
// directly under this package's `type: commonjs`, matching launch-agent.ts.

const fs = require("node:fs") as typeof import("node:fs");
const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const {
  defaultDecisionConfig,
  externalReviewGate: decideExternalReviewGate,
  selectPrForReview,
  workingReviewerPrNumbers,
} = require("./pr-reviewer-decisions.ts");
const { launchAgentFlow } = require("../../../src/agent-launch-flow.ts");

type JsonObject = Record<string, any>;

type DriverResult = {
  action: "skip" | "done" | "needs_llm" | "error";
  summary: string;
  [key: string]: any;
};

const SCRIPT_DIR = __dirname;

function driverResult(action: DriverResult["action"], summary: string, extra: JsonObject = {}): DriverResult {
  return { action, summary, ...extra };
}

function runText(args: string[], options: { input?: string; check?: boolean } = {}): string {
  const completed = spawnSync(args[0], args.slice(1), {
    input: options.input,
    encoding: "utf8",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (options.check !== false && completed.status !== 0) {
    throw new Error((completed.stderr || completed.stdout || `command failed: ${args.join(" ")}`).trim());
  }
  return completed.stdout || "";
}

function runJson(args: string[], options: { input?: string } = {}): any {
  return JSON.parse(runText(args, { input: options.input }));
}

function shellQuote(value: string | number): string {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function oneLine(value: unknown): string {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseBool(value: string | undefined): boolean {
  return String(value || "").toLowerCase() === "1" || String(value || "").toLowerCase() === "true";
}

function loadFixture(file: string | undefined): JsonObject | null {
  if (!file) return null;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("fixture must be a JSON object");
  return data;
}

function envConfig() {
  return {
    projectId: process.env.DEADLOOP_PROJECT_ID || "project",
    repoPath: process.env.DEADLOOP_REPO_PATH || ".",
    githubRepo: process.env.DEADLOOP_GITHUB_REPO || "",
    baseBranch: process.env.DEADLOOP_BASE_BRANCH || "origin/main",
    automationDir: SCRIPT_DIR,
    checkCommand: process.env.DEADLOOP_CHECK_COMMAND || "git diff --check",
    reviewerAgent: process.env.DEADLOOP_REVIEWER_AGENT || "pi",
    reviewerModel: process.env.DEADLOOP_REVIEWER_MODEL || "",
    reviewLabel: process.env.DEADLOOP_REVIEW_LABEL || "agent:review",
    reviewingLabel: process.env.DEADLOOP_REVIEWING_LABEL || "agent:reviewing",
    humanLabel: process.env.DEADLOOP_HUMAN_LABEL || "ready-for-human",
    blockedLabel: process.env.DEADLOOP_BLOCKED_LABEL || "agent:blocked",
    implementLabel: process.env.DEADLOOP_IMPLEMENT_LABEL || "agent:implement",
    autoMerge: parseBool(process.env.DEADLOOP_AUTO_MERGE),
    externalReviewWaitSeconds: process.env.DEADLOOP_EXTERNAL_REVIEW_WAIT_SECONDS || "1800",
    now: process.env.DEADLOOP_NOW || "",
    simulateLaunch: process.env.DEADLOOP_SIMULATE_LAUNCH === "1",
  };
}

function livePrs(repo: string): JsonObject[] {
  return runJson([
    "gh",
    "pr",
    "list",
    "-R",
    repo,
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,url,updatedAt,headRefName,headRefOid,isDraft,labels,statusCheckRollup,comments,reviewRequests",
  ]);
}

function liveAgents(): any {
  try {
    return runJson(["herdr", "agent", "list"]);
  } catch {
    return { result: { agents: [] } };
  }
}

function decisionConfig(env: ReturnType<typeof envConfig>): JsonObject {
  const externalReviewWaitSeconds = Number(env.externalReviewWaitSeconds || 1800);
  if (!Number.isFinite(externalReviewWaitSeconds) || externalReviewWaitSeconds < 0) {
    throw new Error("DEADLOOP_EXTERNAL_REVIEW_WAIT_SECONDS must be a non-negative number");
  }
  if (env.now && !/^\d{4}-\d{2}-\d{2}T/.test(env.now)) throw new Error("DEADLOOP_NOW must be an ISO-8601 timestamp");
  const now = env.now ? new Date(env.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("DEADLOOP_NOW must be an ISO-8601 timestamp");
  return defaultDecisionConfig({
    reviewLabel: env.reviewLabel,
    reviewingLabel: env.reviewingLabel,
    humanLabel: env.humanLabel,
    blockedLabel: env.blockedLabel,
    autoMerge: env.autoMerge,
    externalReviewWaitSeconds,
    projectId: env.projectId,
    now,
  });
}

function selectDecision(prs: JsonObject[], agents: any, env: ReturnType<typeof envConfig>): JsonObject {
  const config = decisionConfig(env);
  return selectPrForReview(prs, config, workingReviewerPrNumbers(agents, env.projectId));
}

function externalReviewGate(pr: JsonObject, env: ReturnType<typeof envConfig>): JsonObject {
  return decideExternalReviewGate(pr, decisionConfig(env));
}

function selectedPr(prs: JsonObject[], number: number): JsonObject {
  return prs.find((pr) => Number(pr.number) === number) || { number };
}

function shouldSimulateLaunch(fixture: JsonObject | null, env: ReturnType<typeof envConfig>): boolean {
  return Boolean(fixture && env.simulateLaunch);
}

function shouldDirectLaunch(fixture: JsonObject | null, env: ReturnType<typeof envConfig>): boolean {
  return fixture ? shouldSimulateLaunch(fixture, env) : true;
}

function reviewerMonitorPrompt(pr: JsonObject, env: ReturnType<typeof envConfig>, launch: JsonObject): string {
  const number = Number(pr.number || 0);
  return `Deterministic driver launched reviewer for PR #${number}. Do not launch another agent and do not reselect another PR.

Monitor only this promise file. It is the only completion authority:
- ${launch.promiseFile}

Polling rules:
- Use \`node ${env.automationDir}/extract-worker-promise.ts --file ${launch.promiseFile}\`.
- If the promise status is \`complete\` or \`blocked\`, break polling immediately. Do not use Herdr status as completion authority.
- If the promise is missing while the agent is idle/done, ask the reviewer to write the promise file instead of guessing completion.

After a \`complete\` promise:
- Re-check GitHub PR state, reviews, and checks before changing labels.
- Run local validation including \`${env.checkCommand}\` when needed for CI fallback; do not ignore failing checks by guesswork.
- If autoMerge=false, never merge; hand off by moving PR toward \`${env.humanLabel}\` with review evidence.
- If autoMerge=true, merge only after review, CI/fallback, and repository safety gates all pass.

After a \`blocked\` promise:
- Use the promise reason/summary to write the blocked report.
- Move the PR from \`${env.reviewingLabel}\` to \`${env.blockedLabel}\` only when the blocker is actionable.

Report only the resulting action and evidence.`;
}

function reviewAgentPrompt(pr: JsonObject, env: ReturnType<typeof envConfig>, promiseFile: string, reason: string): string {
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
- Run needed validation. Minimum check command: ${env.checkCommand}
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
  const uuid = shouldSimulateLaunch(fixture, env) ? "fixture-reviewer-uuid" : randomUUID();
  const reviewerName = `${env.projectId}-pr-${number}-reviewer`;
  const headRefName = String(pr.headRefName || `pr-${number}`);
  const simulatedWorktreePath = `/worktrees/${env.projectId}/${headRefName.replace(/\//g, "-")}`;

  if (shouldSimulateLaunch(fixture, env)) {
    return {
      reviewerName,
      headRefName,
      workspaceId: "fixture-workspace",
      tabId: "fixture-tab",
      worktreePath: simulatedWorktreePath,
      promptFile: `${simulatedWorktreePath}/.deadloop/reviewer-prompt-${uuid}.md`,
      promiseFile: `${simulatedWorktreePath}/.deadloop/promise-${uuid}.json`,
      simulated: true,
    };
  }

  runText(["gh", "pr", "edit", String(number), "-R", env.githubRepo, "--add-label", env.reviewingLabel]);
  const launch = launchAgentFlow(
    {
      worktree: { mode: "open", branch: headRefName },
      repoPath: env.repoPath,
      automationDir: env.automationDir,
      name: reviewerName,
      agent: env.reviewerAgent,
      model: env.reviewerModel,
      level: "medium",
      uuid,
      promptFilePrefix: "reviewer-prompt",
      renderPrompt: ({ promiseFile }: { promiseFile: string }) => reviewAgentPrompt(pr, env, promiseFile, reason),
    },
    { mkdirSync: fs.mkdirSync, runJson, runText, writeFileSync: fs.writeFileSync },
  );
  return { reviewerName, headRefName, ...launch };
}

function hasSkippedReason(decision: JsonObject, reasons: string[]): boolean {
  const wanted = new Set(reasons);
  return (decision.skipped || []).some((entry: JsonObject) => wanted.has(String(entry.reason || "")));
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
  runText(["gh", "pr", "comment", number, "-R", env.githubRepo, "--body", comment]);
  runText(["gh", "pr", "edit", number, "-R", env.githubRepo, "--remove-label", env.reviewingLabel], { check: false });
  runText(["gh", "pr", "edit", number, "-R", env.githubRepo, "--remove-label", env.reviewLabel], { check: false });
  runText(["gh", "pr", "edit", number, "-R", env.githubRepo, "--add-label", env.blockedLabel]);
}

function applyExternalReviewRequest(pr: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null): void {
  if (fixture) return;
  const number = String(pr.number);
  const head = String(pr.headRefOid || "");
  runText(["gh", "pr", "edit", number, "-R", env.githubRepo, "--add-reviewer", "@copilot"], { check: false });
  runText([
    "gh",
    "pr",
    "comment",
    number,
    "-R",
    env.githubRepo,
    "--body",
    `@coderabbitai review\n\n<!-- deadloop:external-review-request head=${head} -->`,
  ]);
  runText(["gh", "pr", "edit", number, "-R", env.githubRepo, "--remove-label", env.reviewingLabel], { check: false });
}

function reviewPrompt(pr: JsonObject, env: ReturnType<typeof envConfig>, reason: string): string {
  const number = Number(pr.number || 0);
  const title = oneLine(pr.title || "PR review");
  const reviewerName = `${env.projectId}-pr-${number}-reviewer`;
  return `Deterministic PR reviewer driver selected PR #${number}. Continue only this bounded review path; do not reselect another PR.

Target:
- GitHub repo: ${env.githubRepo}
- PR: #${number} ${title}
- PR URL: ${pr.url || `https://github.com/${env.githubRepo}/pull/${number}`}
- Reason: ${reason}
- autoMerge=${env.autoMerge ? "true" : "false"}; if autoMerge=false, do not merge. Hand off to ${env.humanLabel} after review/verification.

Required safety contract:
- Claim with ${env.reviewingLabel} before launching review work unless already claimed by stale reclaim.
- Use reviewer name ${reviewerName}; never use the default pi name.
- Prepare a PR branch Herdr worktree; do not edit the main workspace ${env.repoPath}.
- Create a dedicated tab before launch: herdr tab create --workspace <workspaceId> --cwd <worktreePath> --label "${reviewerName}" --no-focus.
- Launch only through node ${env.automationDir}/launch-agent.ts --agent "${env.reviewerAgent}" --name "$reviewer_name" --cwd "$worktree_path" --repo-path ${shellQuote(env.repoPath)} --level "$level" --model "${env.reviewerModel}" --uuid "$uuid" --prompt-file "$prompt_file" --tab "$tab_id".
- The promise file is the only completion authority. When complete or blocked appears, break polling immediately.
- Preserve external review, CI fallback, local verification, and auto-merge safety rules from the project documentation.

Report only the resulting action and evidence.`;
}

function drive(fixturePath: string | undefined): DriverResult {
  const fixture = loadFixture(fixturePath);
  const env = envConfig();
  if (!env.githubRepo && !fixture) return driverResult("error", "DEADLOOP_GITHUB_REPO is required", { driverAction: "configuration_error" });

  const prs = fixture ? fixture.prs || [] : livePrs(env.githubRepo);
  const agents = fixture ? fixture.agents || { result: { agents: [] } } : liveAgents();
  const decision = selectDecision(prs, agents, env);

  if (!decision.selected) {
    const driverAction = hasSkippedReason(decision, ["pending_checks", "external_review_wait"]) ? "wait" : "no_candidate";
    const summary = driverAction === "wait" ? "PR reviewer is waiting for checks or external review" : "No target PR";
    return driverResult("skip", summary, { driverAction, decision });
  }

  const pr = selectedPr(prs, Number(decision.number));
  if (decision.action === "draft_gate") {
    const comment = draftBlockedComment(pr, env);
    applyDraftGate(pr, env, fixture, comment);
    return driverResult("done", `PR #${decision.number} is draft; marked blocked`, {
      driverAction: "draft_blocked",
      prNumber: decision.number,
      comment,
    });
  }

  const gate = externalReviewGate(pr, env);
  if (gate.action === "request_external_review") {
    applyExternalReviewRequest(pr, env, fixture);
    return driverResult("done", `Requested external review for PR #${decision.number}`, {
      driverAction: "external_review_requested",
      prNumber: decision.number,
      gate,
    });
  }
  if (gate.action === "wait_external_review") {
    return driverResult("skip", `Waiting for external review on PR #${decision.number}`, {
      driverAction: "wait",
      prNumber: decision.number,
      gate,
    });
  }

  const reason = String(gate.reason || decision.reason || "review_required");
  if (shouldDirectLaunch(fixture, env)) {
    const launch = launchPrReviewer(pr, env, fixture, reason);
    return driverResult("needs_llm", `Launched reviewer agent for PR #${decision.number}`, {
      driverAction: "reviewer_monitor_request",
      prNumber: decision.number,
      gate,
      launch,
      prompt: reviewerMonitorPrompt(pr, env, launch),
    });
  }

  return driverResult("needs_llm", `PR #${decision.number} needs review agent work`, {
    driverAction: "reviewer_launch_request",
    prNumber: decision.number,
    gate,
    prompt: reviewPrompt(pr, env, reason),
  });
}

function parseArgs(argv: string[]): { fixture?: string } {
  const parsed: { fixture?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--fixture") {
      parsed.fixture = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(drive(args.fixture))}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "exception" }))}\n`,
    );
  }
}

main();
