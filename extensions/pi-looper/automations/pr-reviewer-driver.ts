#!/usr/bin/env node
// Deterministic PR reviewer driver. Keep this CLI CommonJS-shaped so it can run
// directly under this package's `type: commonjs`, matching launch-agent.ts.

const fs = require("node:fs") as typeof import("node:fs");
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const {
  defaultDecisionConfig,
  externalReviewGate: decideExternalReviewGate,
  selectPrForReview,
  workingReviewerPrNumbers,
} = require("./pr-reviewer-decisions.ts");

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
    projectId: process.env.PI_LOOPER_PROJECT_ID || "project",
    repoPath: process.env.PI_LOOPER_REPO_PATH || ".",
    githubRepo: process.env.PI_LOOPER_GITHUB_REPO || "",
    baseBranch: process.env.PI_LOOPER_BASE_BRANCH || "origin/main",
    automationDir: SCRIPT_DIR,
    checkCommand: process.env.PI_LOOPER_CHECK_COMMAND || "git diff --check",
    reviewerAgent: process.env.PI_LOOPER_REVIEWER_AGENT || "pi",
    reviewerModel: process.env.PI_LOOPER_REVIEWER_MODEL || "",
    reviewLabel: process.env.PI_LOOPER_REVIEW_LABEL || "agent:review",
    reviewingLabel: process.env.PI_LOOPER_REVIEWING_LABEL || "agent:reviewing",
    humanLabel: process.env.PI_LOOPER_HUMAN_LABEL || "ready-for-human",
    blockedLabel: process.env.PI_LOOPER_BLOCKED_LABEL || "agent:blocked",
    implementLabel: process.env.PI_LOOPER_IMPLEMENT_LABEL || "agent:implement",
    autoMerge: parseBool(process.env.PI_LOOPER_AUTO_MERGE),
    externalReviewWaitSeconds: process.env.PI_LOOPER_EXTERNAL_REVIEW_WAIT_SECONDS || "1800",
    now: process.env.PI_LOOPER_NOW || "",
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
    throw new Error("PI_LOOPER_EXTERNAL_REVIEW_WAIT_SECONDS must be a non-negative number");
  }
  if (env.now && !/^\d{4}-\d{2}-\d{2}T/.test(env.now)) throw new Error("PI_LOOPER_NOW must be an ISO-8601 timestamp");
  const now = env.now ? new Date(env.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("PI_LOOPER_NOW must be an ISO-8601 timestamp");
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

function hasSkippedReason(decision: JsonObject, reasons: string[]): boolean {
  const wanted = new Set(reasons);
  return (decision.skipped || []).some((entry: JsonObject) => wanted.has(String(entry.reason || "")));
}

function draftBlockedComment(pr: JsonObject, env: ReturnType<typeof envConfig>): string {
  const number = Number(pr.number || 0);
  const headRefName = oneLine(pr.headRefName || "<headRefName>");
  return `## 何が起きたか
- draft PR のため、自動レビューと自動マージを見送りました。
- 確認済み事項:
- PR #${number} は draft 状態です。
- 次に必要な判断: 準備できたら ready にして \`${env.reviewLabel}\` を付け直してください。

## 復旧手順
1. 原因を確認する。
   \`\`\`bash
gh pr view ${number} -R ${shellQuote(env.githubRepo)} --comments --json number,title,url,headRefName,headRefOid,labels,commits,statusCheckRollup
gh pr checks ${number} -R ${shellQuote(env.githubRepo)}
node ${shellQuote(env.automationDir)}/extract-worker-promise.ts --file '<promiseFile>' || true
herdr agent list
herdr pane list
\`\`\`
2. 残骸（worktree / branch）を確認し、安全に掃除する。
   該当なし: draft gate では worktree / branch を作成していません。
   \`\`\`bash
herdr worktree list --cwd ${shellQuote(env.repoPath)} --json
git -C ${shellQuote(env.repoPath)} worktree list
git -C ${shellQuote(env.repoPath)} branch --list ${shellQuote(headRefName)}
herdr worktree remove --workspace '<workspaceId>'
git -C ${shellQuote(env.repoPath)} worktree remove '<worktreePath>'
git -C ${shellQuote(env.repoPath)} branch -d ${shellQuote(headRefName)}
\`\`\`
3. 原因を解消したあと、対象 issue を再 queue する。
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
    `@coderabbitai review\n\n<!-- pi-looper:external-review-request head=${head} -->`,
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
  if (!env.githubRepo && !fixture) return driverResult("error", "PI_LOOPER_GITHUB_REPO is required", { driverAction: "configuration_error" });

  const prs = fixture ? fixture.prs || [] : livePrs(env.githubRepo);
  const agents = fixture ? fixture.agents || { result: { agents: [] } } : liveAgents();
  const decision = selectDecision(prs, agents, env);

  if (!decision.selected) {
    const driverAction = hasSkippedReason(decision, ["pending_checks", "external_review_wait"]) ? "wait" : "no_candidate";
    const summary = driverAction === "wait" ? "PR reviewer is waiting for checks or external review" : "対象 PR なし";
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

  return driverResult("needs_llm", `PR #${decision.number} needs review agent work`, {
    driverAction: "reviewer_launch_request",
    prNumber: decision.number,
    gate,
    prompt: reviewPrompt(pr, env, String(gate.reason || decision.reason || "review_required")),
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
