#!/usr/bin/env node
// Deterministic issue-coordinator driver. CommonJS-shaped so it can run directly
// under this package's `type: commonjs`, matching launch-agent.ts.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { decisionForIssues, planIssueCoordinatorAction } = require("./issue-coordinator-flow.ts");
const { renderIssueBlockedComment, renderIssueWorkerPrompt } = require("../../../src/issue-coordinator-renderers.ts");
const { launchAgentFlow } = require("../../../src/agent-launch-flow.ts");
const { createHerdrRunner } = require("../../../src/herdr-runner.ts");

type JsonObject = Record<string, any>;

type DriverResult = {
  action: "skip" | "done" | "needs_llm" | "error";
  summary: string;
  [key: string]: any;
};

const SCRIPT_DIR = __dirname;
const CLEANUP_SCRIPT = path.join(SCRIPT_DIR, "cleanup-completed-worker-worktrees.ts");

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

function herdrRunner() {
  return createHerdrRunner({
    runText: (command: string, args: string[]) => runText([command, ...args]),
    runJson: (command: string, args: string[]) => runJson([command, ...args]),
  });
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
  return runJson(["node", CLEANUP_SCRIPT, "--plan", "--json"]);
}

function applyCleanup(plan: JsonObject, fixture: JsonObject | null): JsonObject {
  if (fixture) return { ...plan, appliedFromFixture: true };
  return runJson(["node", CLEANUP_SCRIPT, "--apply", "--json"]);
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
    confirmed: [`Issue #${number} is not a single implementable Worker task.`],
    nextDecision: "Create a separate implementable issue or split this issue's scope.",
  });
}

function applyBlocked(issue: JsonObject, env: ReturnType<typeof envConfig>, comment: string, fixture: JsonObject | null): void {
  if (fixture) return;
  const number = String(issue.number);
  runText(["gh", "issue", "edit", number, "-R", env.githubRepo, "--remove-label", env.implementLabel, "--add-label", env.blockedLabel]);
  runText(["gh", "issue", "comment", number, "-R", env.githubRepo, "--body", comment]);
}

function slugForBranch(value: unknown): string {
  const slug = String(value || "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "task";
}

function shouldSimulateLaunch(fixture: JsonObject | null, env: ReturnType<typeof envConfig>): boolean {
  return Boolean(fixture && env.simulateLaunch);
}

function shouldDirectLaunch(fixture: JsonObject | null, env: ReturnType<typeof envConfig>): boolean {
  return fixture ? shouldSimulateLaunch(fixture, env) : true;
}

function issueMonitorPrompt(issue: JsonObject, env: ReturnType<typeof envConfig>, launch: JsonObject): string {
  const number = Number(issue.number || 0);
  return `Deterministic driver launched Worker for Issue #${number}. Do not launch another agent and do not reselect another issue.

Monitor only this promise file. It is the only completion authority:
- ${launch.promiseFile}

Polling rules:
- Use \`node ${env.automationDir}/extract-worker-promise.ts --file ${launch.promiseFile}\`.
- If the promise status is \`complete\` or \`blocked\`, break polling immediately. Do not use Herdr status as completion authority.
- If the promise is missing while the agent is idle/done, ask the Worker to write the promise file instead of guessing completion.

After a \`complete\` promise:
- Inspect \`${launch.worktreePath}\` and confirm only Issue #${number} changes are present.
- Run validation including \`${env.checkCommand}\` before creating any PR.
- Push only the Worker branch \`${launch.branch}\` without force-push, create a reviewable PR linked to Issue #${number}, and add \`${env.reviewLabel}\`.
- Do not close the issue or merge the PR.

After a \`blocked\` promise:
- Use the promise reason/summary to report the blocker.
- Move the issue from \`${env.inProgressLabel}\` to \`${env.blockedLabel}\` only when the blocker is actionable.

Report only the resulting action and evidence.`;
}

function launchIssueWorker(issue: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null): JsonObject {
  const number = Number(issue.number || 0);
  const uuid = shouldSimulateLaunch(fixture, env) ? "fixture-worker-uuid" : randomUUID();
  const workerName = `${env.projectId}-issue-${number}-worker`;
  const branch = `agent/issue-${number}-${slugForBranch(issue.title)}`;
  const simulatedWorktreePath = `/worktrees/${env.projectId}/${branch.replace(/\//g, "-")}`;

  if (shouldSimulateLaunch(fixture, env)) {
    return {
      workerName,
      branch,
      workspaceId: "fixture-workspace",
      tabId: "fixture-tab",
      worktreePath: simulatedWorktreePath,
      promptFile: `${simulatedWorktreePath}/.deadloop/worker-prompt-${uuid}.md`,
      promiseFile: `${simulatedWorktreePath}/.deadloop/promise-${uuid}.json`,
      simulated: true,
    };
  }

  runText(["gh", "issue", "edit", String(number), "-R", env.githubRepo, "--remove-label", env.implementLabel, "--add-label", env.inProgressLabel]);
  const launch = launchAgentFlow(
    {
      worktree: { mode: "create", branch, baseBranch: env.baseBranch },
      repoPath: env.repoPath,
      automationDir: env.automationDir,
      name: workerName,
      agent: env.workerAgent,
      model: env.workerModel,
      level: "medium",
      uuid,
      promptFilePrefix: "worker-prompt",
      renderPrompt: ({ promiseFile }: { promiseFile: string }) =>
        renderIssueWorkerPrompt({
          launchReason: "deterministic issue coordinator launch",
          issueNumber: number,
          issueTitle: String(issue.title || "task"),
          issueUrl: String(issue.url || `https://github.com/${env.githubRepo}/issues/${number}`),
          githubRepo: env.githubRepo,
          workerInstructions: env.workerInstructions,
          checkCommand: env.checkCommand,
          promiseFile,
        }),
    },
    { mkdirSync: fs.mkdirSync, runner: herdrRunner(), runText, writeFileSync: fs.writeFileSync },
  );
  return { workerName, branch, ...launch };
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
- Render the Worker prompt with \`src/issue-coordinator-renderers.ts\` / \`renderIssueWorkerPrompt\` semantics, including promise file \`<worktreePath>/.deadloop/promise-<uuid>.json\`.
- Start the Worker only through \`node ${env.automationDir}/launch-agent.ts --agent "${env.workerAgent}" --name "$worker_name" --cwd "$worktree_path" --repo-path ${shellQuoteForDriver(env.repoPath)} --level "$level" --model "${env.workerModel}" --uuid "$uuid" --prompt-file "$prompt_file" --tab "$tab_id"\`.
- The promise file is the only completion authority. When \`complete\` or \`blocked\` appears, break polling immediately (\`complete|blocked) break\`). Do not use Herdr status as completion authority.
- After a complete promise, run validation including \`${env.checkCommand}\`, create a reviewable PR, add \`${env.reviewLabel}\`, and preserve existing safety rules.

Report only the resulting action and evidence.`;
}

function envConfig() {
  return {
    projectId: process.env.DEADLOOP_PROJECT_ID || "project",
    repoPath: process.env.DEADLOOP_REPO_PATH || ".",
    githubRepo: process.env.DEADLOOP_GITHUB_REPO || "",
    baseBranch: process.env.DEADLOOP_BASE_BRANCH || "origin/main",
    automationDir: SCRIPT_DIR,
    checkCommand: process.env.DEADLOOP_CHECK_COMMAND || "git diff --check",
    workerInstructions: process.env.DEADLOOP_WORKER_INSTRUCTIONS || "Read AGENTS.md and follow the issue contract.",
    workerAgent: process.env.DEADLOOP_WORKER_AGENT || "pi",
    workerModel: process.env.DEADLOOP_WORKER_MODEL || "",
    readyLabel: process.env.DEADLOOP_READY_LABEL || "ready-for-agent",
    implementLabel: process.env.DEADLOOP_IMPLEMENT_LABEL || "agent:implement",
    inProgressLabel: process.env.DEADLOOP_IN_PROGRESS_LABEL || "agent:in-progress",
    blockedLabel: process.env.DEADLOOP_BLOCKED_LABEL || "agent:blocked",
    reviewLabel: process.env.DEADLOOP_REVIEW_LABEL || "agent:review",
    humanLabel: process.env.DEADLOOP_HUMAN_LABEL || "ready-for-human",
    needsInfoLabel: process.env.DEADLOOP_NEEDS_INFO_LABEL || "needs-info",
    wontfixLabel: process.env.DEADLOOP_WONTFIX_LABEL || "wontfix",
    needsTriageLabel: process.env.DEADLOOP_NEEDS_TRIAGE_LABEL || "needs-triage",
    simulateLaunch: process.env.DEADLOOP_SIMULATE_LAUNCH === "1",
  };
}

function drive(fixturePath: string | undefined): DriverResult {
  const fixture = loadFixture(fixturePath);
  const env = envConfig();
  if (!env.githubRepo && !fixture) return driverResult("error", "DEADLOOP_GITHUB_REPO is required", { driverAction: "configuration_error" });

  const cleanup = cleanupPlan(fixture);
  const candidates = cleanup.candidates || [];
  if (candidates.length) {
    return driverResult("done", `completed worker cleanup: ${candidates.length} candidate(s)`, {
      driverAction: "cleanup_applied",
      cleanup: applyCleanup(cleanup, fixture),
    });
  }

  const issues = issueList(fixture, env.githubRepo);
  const decision = decisionForIssues(fixturePath, issues, env.githubRepo, env);
  const issuePlan = planIssueCoordinatorAction(issues, decision);
  if (issuePlan.kind === "skip_no_candidate") return driverResult("skip", "No target issue", { driverAction: "no_candidate", decision });

  const issue = issuePlan.issue;
  if (issuePlan.kind === "contract_missing") {
    applyContractMissing(issue, env, fixture);
    return driverResult("done", `Issue #${issue.number} is missing its contract; moved it to needs-triage`, {
      driverAction: "contract_missing",
      issueNumber: issue.number,
      comment: gateMissingContractComment(issue),
    });
  }

  if (issuePlan.kind === "planning_blocked") {
    const comment = blockedComment(issue, env, "Skipped automated implementation because this looks like a PRD, design, or parent issue.");
    applyBlocked(issue, env, comment, fixture);
    return driverResult("done", `Issue #${issue.number} is not an implementable unit; marked it blocked`, {
      driverAction: "blocked_comment",
      issueNumber: issue.number,
      comment,
    });
  }

  if (shouldDirectLaunch(fixture, env)) {
    const launch = launchIssueWorker(issue, env, fixture);
    return driverResult("needs_llm", `Launched Worker for Issue #${issue.number}`, {
      driverAction: "worker_monitor_request",
      issueNumber: issue.number,
      launch,
      prompt: issueMonitorPrompt(issue, env, launch),
    });
  }

  return driverResult("needs_llm", `Issue #${issue.number} needs Worker launch`, {
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
