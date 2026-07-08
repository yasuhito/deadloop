#!/usr/bin/env node
// Deterministic issue-coordinator driver. CommonJS-shaped so it can run directly
// under this package's `type: commonjs`, matching launch-agent.ts.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { renderIssueBlockedComment } = require("../../../src/issue-coordinator-renderers.ts");

type JsonObject = Record<string, any>;

type DriverResult = {
  action: "skip" | "done" | "needs_llm" | "error";
  summary: string;
  [key: string]: any;
};

const SCRIPT_DIR = __dirname;
const DECISION_SCRIPT = path.join(SCRIPT_DIR, "issue-coordinator-decisions.py");
const CLEANUP_SCRIPT = path.join(SCRIPT_DIR, "cleanup-completed-worker-worktrees.py");

const CONTRACT_BRIEF_RE = /^##\s*(?:Agent Brief|What to build)\b/im;
const CONTRACT_ACCEPTANCE_RE = /^##\s*(?:Acceptance criteria|受け入れ条件)\b|\bAcceptance criteria\b|受け入れ条件/im;
const PRD_ONLY_RE = /^##\s*(?:PRD|RFC|設計|計画)\b|\b(?:PRD|RFC)\b/im;
const TASK_LIST_RE = /^\s*- \[[ xX]\] .+#\d+/m;

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

function shellQuoteForDriver(value: string | number): string {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function oneLineForDriver(value: unknown): string {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function loadFixture(file: string | undefined): JsonObject | null {
  if (!file) return null;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("fixture must be a JSON object");
  return data;
}

function cleanupPlan(fixture: JsonObject | null): JsonObject {
  if (fixture) return { ...(fixture.cleanup || { candidates: [] }) };
  return runJson(["python3", CLEANUP_SCRIPT, "--plan", "--json"]);
}

function applyCleanup(plan: JsonObject, fixture: JsonObject | null): JsonObject {
  if (fixture) return { ...plan, appliedFromFixture: true };
  return runJson(["python3", CLEANUP_SCRIPT, "--apply", "--json"]);
}

function issueList(fixture: JsonObject | null, repo: string): JsonObject[] {
  if (fixture) return (fixture.issues || []).filter((issue: unknown) => issue && typeof issue === "object");
  return runJson([
    "gh",
    "issue",
    "list",
    "-R",
    repo,
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number,title,body,labels,updatedAt,url",
  ]);
}

function decisionForIssues(fixturePath: string | undefined, issues: JsonObject[], repo: string, env: ReturnType<typeof envConfig>): JsonObject {
  const args = [
    "python3",
    DECISION_SCRIPT,
    "--json",
    "--repo",
    repo,
    "--ready-label",
    env.readyLabel,
    "--implement-label",
    env.implementLabel,
    "--in-progress-label",
    env.inProgressLabel,
    "--blocked-label",
    env.blockedLabel,
    "--human-label",
    env.humanLabel,
    "--needs-info-label",
    env.needsInfoLabel,
    "--wontfix-label",
    env.wontfixLabel,
  ];
  if (fixturePath) {
    args.push("--fixture", fixturePath);
    return runJson(args);
  }
  return runJson(args, { input: JSON.stringify(issues) });
}

function selectedIssue(issues: JsonObject[], number: number): JsonObject {
  return issues.find((issue) => Number(issue.number || 0) === number) || { number, title: "", body: "", url: "" };
}

function hasImplementationContract(issue: JsonObject): boolean {
  const body = String(issue.body || "");
  return CONTRACT_BRIEF_RE.test(body) && CONTRACT_ACCEPTANCE_RE.test(body);
}

function isBlockedPlanningIssue(issue: JsonObject): boolean {
  const text = `${String(issue.title || "")}\n${String(issue.body || "")}`;
  return PRD_ONLY_RE.test(text) || TASK_LIST_RE.test(String(issue.body || ""));
}

function gateMissingContractComment(issue: JsonObject): string {
  return [
    "実装契約が不足しているため、自動実装の対象から外しました。",
    "",
    "不足しているもの:",
    "- `## Agent Brief` または `## What to build`",
    "- `## Acceptance criteria` または `## 受け入れ条件`",
    "",
    `Issue 本文を整えたあと、\`agent:implement\` を付け直してください。対象: #${issue.number}`,
  ].join("\n");
}

function applyContractMissing(issue: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null): void {
  if (fixture) return;
  const number = String(issue.number);
  runText(["gh", "issue", "edit", number, "-R", env.githubRepo, "--remove-label", env.implementLabel, "--add-label", env.needsTriageLabel]);
  runText(["gh", "issue", "comment", number, "-R", env.githubRepo, "--body", gateMissingContractComment(issue)]);
}

function blockedComment(issue: JsonObject, env: ReturnType<typeof envConfig>, reason: string): string {
  const number = Number(issue.number || 0);
  return renderIssueBlockedComment({
    issueNumber: number,
    githubRepo: env.githubRepo,
    repoPath: env.repoPath,
    automationDir: env.automationDir,
    blockedLabel: env.blockedLabel,
    implementLabel: env.implementLabel,
    summary: reason,
    confirmed: [`Issue #${number} は、単一 Worker に渡せる実装単位ではありません。`],
    nextDecision: "実装可能な単位の Issue を別に用意するか、この Issue の scope を分割してください。",
  });
}

function applyBlocked(issue: JsonObject, env: ReturnType<typeof envConfig>, comment: string, fixture: JsonObject | null): void {
  if (fixture) return;
  const number = String(issue.number);
  runText(["gh", "issue", "edit", number, "-R", env.githubRepo, "--remove-label", env.implementLabel, "--add-label", env.blockedLabel]);
  runText(["gh", "issue", "comment", number, "-R", env.githubRepo, "--body", comment]);
}

function workerLaunchPrompt(issue: JsonObject, env: ReturnType<typeof envConfig>): string {
  const number = Number(issue.number || 0);
  const title = oneLineForDriver(issue.title || "task");
  const url = String(issue.url || `https://github.com/${env.githubRepo}/issues/${number}`);
  const workerName = `${env.projectId}-issue-${number}-worker`;
  return `Deterministic issue-coordinator driver selected Issue #${number}. Continue only this bounded worker-launch path; do not reselect another issue.

Target:
- GitHub repo: ${env.githubRepo}
- Issue: #${number} ${title}
- Issue URL: ${url}

Required safety contract:
- Claim before launch: remove \`${env.implementLabel}\` and add \`${env.inProgressLabel}\`.
- Use a unique Worker name like \`${workerName}\`; never use the default \`pi\` name.
- Create a Herdr worktree and then a dedicated tab with \`herdr tab create --workspace <workspaceId> --cwd <worktreePath> --label "${workerName}" --no-focus\`.
- Render the Worker prompt with \`src/issue-coordinator-renderers.ts\` / \`renderIssueWorkerPrompt\` semantics, including promise file \`<worktreePath>/.pi-looper/promise-<uuid>.json\`.
- Start the Worker only through \`node ${env.automationDir}/launch-agent.ts --agent "${env.workerAgent}" --name "$worker_name" --cwd "$worktree_path" --repo-path ${shellQuoteForDriver(env.repoPath)} --level "$level" --model "${env.workerModel}" --uuid "$uuid" --prompt-file "$prompt_file" --tab "$tab_id"\`.
- The promise file is the only completion authority. When \`complete\` or \`blocked\` appears, break polling immediately (\`complete|blocked) break\`). Do not use Herdr status as completion authority.
- After a complete promise, run validation including \`${env.checkCommand}\`, create a reviewable PR, add \`${env.reviewLabel}\`, and preserve existing safety rules.

Report only the resulting action and evidence.`;
}

function envConfig() {
  return {
    projectId: process.env.PI_LOOPER_PROJECT_ID || "project",
    repoPath: process.env.PI_LOOPER_REPO_PATH || ".",
    githubRepo: process.env.PI_LOOPER_GITHUB_REPO || "",
    baseBranch: process.env.PI_LOOPER_BASE_BRANCH || "origin/main",
    automationDir: SCRIPT_DIR,
    checkCommand: process.env.PI_LOOPER_CHECK_COMMAND || "git diff --check",
    workerAgent: process.env.PI_LOOPER_WORKER_AGENT || "pi",
    workerModel: process.env.PI_LOOPER_WORKER_MODEL || "",
    readyLabel: process.env.PI_LOOPER_READY_LABEL || "ready-for-agent",
    implementLabel: process.env.PI_LOOPER_IMPLEMENT_LABEL || "agent:implement",
    inProgressLabel: process.env.PI_LOOPER_IN_PROGRESS_LABEL || "agent:in-progress",
    blockedLabel: process.env.PI_LOOPER_BLOCKED_LABEL || "agent:blocked",
    reviewLabel: process.env.PI_LOOPER_REVIEW_LABEL || "agent:review",
    humanLabel: process.env.PI_LOOPER_HUMAN_LABEL || "ready-for-human",
    needsInfoLabel: process.env.PI_LOOPER_NEEDS_INFO_LABEL || "needs-info",
    wontfixLabel: process.env.PI_LOOPER_WONTFIX_LABEL || "wontfix",
    needsTriageLabel: process.env.PI_LOOPER_NEEDS_TRIAGE_LABEL || "needs-triage",
  };
}

function drive(fixturePath: string | undefined): DriverResult {
  const fixture = loadFixture(fixturePath);
  const env = envConfig();
  if (!env.githubRepo && !fixture) return driverResult("error", "PI_LOOPER_GITHUB_REPO is required", { driverAction: "configuration_error" });

  const plan = cleanupPlan(fixture);
  const candidates = plan.candidates || [];
  if (candidates.length) {
    return driverResult("done", `completed worker cleanup: ${candidates.length} candidate(s)`, {
      driverAction: "cleanup_applied",
      cleanup: applyCleanup(plan, fixture),
    });
  }

  const issues = issueList(fixture, env.githubRepo);
  const decision = decisionForIssues(fixturePath, issues, env.githubRepo, env);
  if (!decision.selected) return driverResult("skip", "対象 issue なし", { driverAction: "no_candidate", decision });

  const issue = selectedIssue(issues, Number(decision.number || 0));
  if (!hasImplementationContract(issue)) {
    applyContractMissing(issue, env, fixture);
    return driverResult("done", `Issue #${issue.number} は契約不足のため needs-triage に移しました`, {
      driverAction: "contract_missing",
      issueNumber: issue.number,
      comment: gateMissingContractComment(issue),
    });
  }

  if (isBlockedPlanningIssue(issue)) {
    const comment = blockedComment(issue, env, "PRD / 設計 / 親 Issue 型のため、自動実装を見送りました。");
    applyBlocked(issue, env, comment, fixture);
    return driverResult("done", `Issue #${issue.number} は実装単位ではないため blocked にしました`, {
      driverAction: "blocked_comment",
      issueNumber: issue.number,
      comment,
    });
  }

  return driverResult("needs_llm", `Issue #${issue.number} の Worker 起動が必要です`, {
    driverAction: "worker_launch_request",
    issueNumber: issue.number,
    prompt: workerLaunchPrompt(issue, env),
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
