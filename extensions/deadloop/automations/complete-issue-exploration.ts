#!/usr/bin/env node
const path = require("node:path") as typeof import("node:path");
const { hasUncommittedWork, UNCOMMITTED_WORK_STATUS_ARGS } = require("../../../src/agent-scratch-area.cjs");
const { createCommandRunner, createHerdrRunnerFromCommandRunner, driverResult } = require("../../../src/automation-driver-kit.ts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { createGithubOperations } = require("../../../src/github-operations.ts");
const { runHerdrPreflight } = require("../../../src/herdr-preflight.cjs");
const {
  readAttemptRecord,
  recordPersistedCompletionReport,
  transitionPersistedAttempt,
} = require("../../../src/attempt-lifecycle-runtime.cjs");
const {
  assertAttemptProjectBinding,
  assertWorktreeBelongsToProject,
  canonicalAttemptLocation,
} = require("../../../src/attempt-project-confinement.cjs");
const { persistSuccessfulExploration } = require("../../../src/issue-request-transition.ts");
const { validatePromise } = require("./extract-worker-promise.ts");
const { completeLocked } = require("./complete-attempt-workspace.ts");

import type { JsonObject } from "../../../src/automation-driver-kit";

function parseArgs(argv: string[]): JsonObject {
  const result: JsonObject = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    result[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const name of ["attemptRecord", "projectId", "projectRepo", "githubRepo", "stateDir", "enabledAt", "inProgressLabel"]) {
    if (!result[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return result;
}

function lines(title: string, values: unknown): string[] {
  const list = Array.isArray(values) ? values.map(String).filter(Boolean) : [];
  return [`### ${title}`, ...(list.length ? list.map((value) => `- ${value}`) : ["- None."])];
}

function renderExplorationResult(report: JsonObject): string {
  const result = report.result || {};
  return [
    "## deadloop exploration",
    "",
    String(report.summary || ""),
    "",
    `**Difficulty:** ${String(result.difficulty || "")}`,
    "",
    ...lines("Relevant files", result.relevantFiles),
    "",
    ...lines("Verified claims", result.verifiedClaims),
    "",
    ...lines("Disproved claims", result.disprovedClaims),
    "",
    ...lines("Open questions", result.openQuestions),
    ...(result.approach ? ["", "### Possible approach", String(result.approach)] : []),
  ].join("\n");
}

function assertOwnedExplorationWorkspace(record: JsonObject, runner: JsonObject): void {
  if (!record.workspaceId) throw new Error("exploration workspace identity is missing");
  const matches = runner.listWorkspaces().filter((workspace: JsonObject) => String(workspace.workspaceId) === String(record.workspaceId));
  if (matches.length !== 1 || !matches[0].worktreePath
    || path.resolve(matches[0].worktreePath) !== path.resolve(record.worktreePath)) {
    throw new Error("exploration workspace identity is not exact");
  }
}

function removeExplorationWorktree(record: JsonObject, repoPath: string, runner: JsonObject): void {
  const worktrees = runner.listWorktrees(repoPath);
  const expectedPath = path.resolve(record.worktreePath);
  const branchMatches = worktrees.filter((worktree: JsonObject) => String(worktree.branch || "") === String(record.branch));
  const pathMatches = worktrees.filter((worktree: JsonObject) => typeof worktree.path === "string" && path.resolve(worktree.path) === expectedPath);
  if (!branchMatches.length && !pathMatches.length) return;
  const exact = worktrees.filter((worktree: JsonObject) => String(worktree.branch || "") === String(record.branch)
    && typeof worktree.path === "string" && path.resolve(worktree.path) === expectedPath);
  if (exact.length !== 1 || branchMatches.length !== 1 || pathMatches.length !== 1) {
    throw new Error("exploration worktree identity is ambiguous");
  }
  runner.removeWorktree({ repoPath, branch: record.branch, worktreePath: record.worktreePath });
  const remaining = runner.listWorktrees(repoPath);
  if (remaining.some((worktree: JsonObject) => String(worktree.branch || "") === String(record.branch)
    || (typeof worktree.path === "string" && path.resolve(worktree.path) === expectedPath))) {
    throw new Error("exploration worktree removal could not be confirmed");
  }
}

function completeExplorationLocked(args: JsonObject, command: ReturnType<typeof createCommandRunner>, enabled: JsonObject, recheck: () => void) {
  const { attemptRecord, runDir } = canonicalAttemptLocation(args);
  let record = readAttemptRecord(runDir);
  assertAttemptProjectBinding(record, args);
  if (record.role !== "explorer" || record.target?.kind !== "issue" || !record.agentRequest
    || record.agentRequest.role !== "explorer") throw new Error("attempt is not a bound Issue exploration");

  const runner = createHerdrRunnerFromCommandRunner(command);
  if (record.phase !== "github_persisted" && record.phase !== "workspace_closed") {
    const validation = validatePromise(record.promiseFile, attemptRecord);
    if (validation.evidenceStrength !== "strong" || validation.status !== "complete") {
      throw new Error("a strongly bound successful explorer report is required");
    }
    const report = validation.promise;
    assertWorktreeBelongsToProject(command, record, args);
    assertOwnedExplorationWorkspace(record, runner);
    const head = command.runText(["git", "-C", record.worktreePath, "rev-parse", "--verify", "HEAD^{commit}"]).trim();
    const status = command.runText(["git", "-C", record.worktreePath, ...UNCOMMITTED_WORK_STATUS_ARGS]);
    if (head.toLowerCase() !== String(record.inputRevision.head).toLowerCase() || hasUncommittedWork(status)) {
      throw new Error("the read-only explorer changed repository HEAD or files");
    }
    if (record.phase === "agent_started") record = recordPersistedCompletionReport(runDir, report);
    if (record.phase !== "report_received") throw new Error(`exploration is not completable from ${record.phase}`);

    const github = createGithubOperations(command, recheck);
    persistSuccessfulExploration({
      github,
      repository: record.repository,
      issueNumber: record.target.number,
      requestLabel: record.agentRequest.label,
      requestEventId: record.agentRequest.eventId,
      inProgressLabel: String(args.inProgressLabel),
      automationLogin: String(enabled.automationLogin || ""),
      attemptId: record.attemptId,
      resultBody: renderExplorationResult(report),
      persistGithub: () => { record = transitionPersistedAttempt(runDir, "github_persisted"); },
    });
  }

  const completion = completeLocked(args, command, recheck);
  if (completion.driverAction !== "workspace_closed") return completion;
  record = readAttemptRecord(runDir);
  removeExplorationWorktree(record, String(args.projectRepo), runner);
  return driverResult("done", "exploration result persisted and owned runtime state cleaned up", {
    driverAction: "exploration_persisted",
    issueNumber: record.target.number,
  });
}

function complete(args: JsonObject) {
  const command = createCommandRunner();
  runHerdrPreflight({ run: (name: string, commandArgs: string[]) => command.runText([name, ...commandArgs]) });
  const project = {
    id: String(args.projectId),
    repoPath: path.resolve(String(args.projectRepo)),
    githubRepo: String(args.githubRepo),
    stateDir: path.resolve(String(args.stateDir)),
    enabledAt: Number(args.enabledAt),
  };
  return withEnabledDriverLock(project, (enabled: JsonObject, recheck: () => void) =>
    completeExplorationLocked(args, command, enabled, recheck));
}

function main(): void {
  Promise.resolve(complete(parseArgs(process.argv.slice(2))))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => process.stdout.write(`${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "exception" }))}\n`));
}

if (require.main === module) main();
module.exports = {
  assertOwnedExplorationWorkspace,
  complete,
  completeExplorationLocked,
  parseArgs,
  removeExplorationWorktree,
  renderExplorationResult,
};
