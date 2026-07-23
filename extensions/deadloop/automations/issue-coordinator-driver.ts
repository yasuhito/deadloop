#!/usr/bin/env node
// Deterministic issue-coordinator driver. CommonJS-shaped so it can run directly
// under this package's `type: commonjs`, matching launch-agent.ts.

const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");
const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
const { decisionForIssues, planIssueCoordinatorAction } = require("./issue-coordinator-flow.ts");
const { renderIssueBlockedComment, renderIssueWorkerPrompt } = require("../../../src/issue-coordinator-renderers.ts");
const { launchAgentFlow } = require("../../../src/agent-launch-flow.ts");
const { renderProjectCheckCommand } = require("../../../src/project-check.ts");
const { renderIssueMonitorPrompt } = require("../../../src/monitor-prompts.ts");
const {
  createCommandRunner,
  createHerdrRunnerFromCommandRunner,
  driverResult,
  loadFixture,
  parseFixtureArg,
} = require("../../../src/automation-driver-kit.ts");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { assertDriverEnabled } = require("../../../src/driver-enablement.cjs");

import type { DriverResult, JsonObject } from "../../../src/automation-driver-kit";

const SCRIPT_DIR = __dirname;
const CLEANUP_SCRIPT = path.join(SCRIPT_DIR, "cleanup-completed-worker-worktrees.ts");
const commandRunner = createCommandRunner();
const { runText, runJson } = commandRunner;

function herdrRunner() {
  return createHerdrRunnerFromCommandRunner(commandRunner);
}

function githubOperations() {
  return createGithubOperations(commandRunner);
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
  const github = githubOperations();
  assertDriverEnabled(env);
  github.moveIssueLabels(env.githubRepo, number, { remove: env.implementLabel, add: env.needsTriageLabel });
  assertDriverEnabled(env);
  github.commentIssue(env.githubRepo, number, gateMissingContractComment(issue));
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
  const github = githubOperations();
  assertDriverEnabled(env);
  github.moveIssueLabels(env.githubRepo, number, { remove: env.implementLabel, add: env.blockedLabel });
  assertDriverEnabled(env);
  github.commentIssue(env.githubRepo, number, comment);
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

function launchIssueWorker(issue: JsonObject, env: ReturnType<typeof envConfig>, fixture: JsonObject | null): JsonObject {
  const number = Number(issue.number || 0);
  const uuid = shouldSimulateLaunch(fixture) ? "fixture-worker-uuid" : randomUUID();
  const workerName = `${env.projectId}-issue-${number}-worker`;
  const branch = `agent/issue-${number}-${slugForBranch(issue.title)}`;
  const simulatedWorktreePath = `/worktrees/${env.projectId}/${branch.replace(/\//g, "-")}`;

  if (shouldSimulateLaunch(fixture)) {
    return {
      workerName,
      branch,
      workspaceId: "fixture-workspace",
      tabId: "fixture-tab",
      worktreePath: simulatedWorktreePath,
      promptFile: `${env.stateDir}/runs/${uuid}/worker-prompt.md`,
      promiseFile: `${env.stateDir}/runs/${uuid}/promise.json`,
      simulated: true,
    };
  }

  assertDriverEnabled(env);
  githubOperations().moveIssueLabels(env.githubRepo, number, { remove: env.implementLabel, add: env.inProgressLabel });
  assertDriverEnabled(env);
  const launch = launchAgentFlow(
    {
      worktree: { mode: "create", branch, baseBranch: env.baseBranch },
      repoPath: env.repoPath,
      automationDir: env.automationDir,
      stateDir: env.stateDir,
      name: workerName,
      agent: env.workerAgent,
      model: env.workerModel,
      level: "medium",
      uuid,
      promptFilePrefix: "worker-prompt",
      renderPrompt: ({ promiseFile, worktreePath }: { promiseFile: string; worktreePath: string }) =>
        renderIssueWorkerPrompt({
          launchReason: "deterministic issue coordinator launch",
          issueNumber: number,
          issueTitle: String(issue.title || "task"),
          issueUrl: String(issue.url || `https://github.com/${env.githubRepo}/issues/${number}`),
          githubRepo: env.githubRepo,
          workerInstructions: env.workerInstructions,
          checkCommand: env.checkCommand,
          validationCommand: renderProjectCheckCommand({
            automationDir: env.automationDir,
            stateDir: env.stateDir,
            cwd: worktreePath,
            command: env.checkCommand,
          }),
          promiseFile,
        }),
    },
    { mkdirSync: fs.mkdirSync, runner: herdrRunner(), runText, writeFileSync: fs.writeFileSync },
  );
  return { workerName, branch, ...launch };
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
  };
}

function drive(fixturePath: string | undefined): DriverResult {
  const fixture = loadFixture(fixturePath);
  const env = envConfig();
  if (!env.githubRepo && !fixture) return driverResult("error", "DEADLOOP_GITHUB_REPO is required", { driverAction: "configuration_error" });

  const cleanup = cleanupPlan(fixture);
  const candidates = cleanup.candidates || [];
  if (candidates.length) {
    if (!fixture) assertDriverEnabled(env);
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

  const launch = launchIssueWorker(issue, env, fixture);
  return driverResult("needs_llm", `Launched Worker for Issue #${issue.number}`, {
    driverAction: "worker_monitor_request",
    issueNumber: issue.number,
    launch,
    prompt: renderIssueMonitorPrompt({
      issueNumber: Number(issue.number || 0),
      automationDir: env.automationDir,
      promiseFile: String(launch.promiseFile || ""),
      actorName: "Worker",
      worktreePath: String(launch.worktreePath || ""),
      branch: String(launch.branch || ""),
      checkCommand: renderProjectCheckCommand({
        automationDir: env.automationDir,
        stateDir: env.stateDir,
        cwd: String(launch.worktreePath || ""),
        command: env.checkCommand,
      }),
      reviewLabel: env.reviewLabel,
      inProgressLabel: env.inProgressLabel,
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
