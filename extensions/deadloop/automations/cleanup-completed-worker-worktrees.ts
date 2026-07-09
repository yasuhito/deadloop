#!/usr/bin/env node
// Deterministically clean completed deadloop Herdr worker worktrees.
// CommonJS-shaped so it can run directly with `node cleanup-completed-worker-worktrees.ts`.

const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { createHerdrRunner, normalizeHerdrWorktreeRecord } = require("../../../src/herdr-runner.ts");

type CleanupRecord = Record<string, any>;

type CleanupConfig = {
  repo: string;
  repoPath: string;
  worktreeRoot: string;
  reviewLabel: string;
  humanLabel: string;
};

const DEFAULT_REVIEW_LABEL = "agent:review";
const DEFAULT_HUMAN_LABEL = "ready-for-human";

function runCleanupText(args: string[], options: { cwd?: string; check?: boolean } = {}): string {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (options.check !== false && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `command failed: ${args.join(" ")}`).trim());
  }
  return result.stdout || "";
}

function runCleanupJson(args: string[], options: { cwd?: string } = {}): any {
  return JSON.parse(runCleanupText(args, options));
}

function cleanupHerdrRunner() {
  return createHerdrRunner({
    runText: (command: string, args: string[]) => runCleanupText([command, ...args]),
    runJson: (command: string, args: string[]) => runCleanupJson([command, ...args]),
  });
}

function workspaceIdForCleanup(worktree: CleanupRecord): string {
  return String(worktree.workspaceId || "");
}

function runCleanupCode(args: string[], options: { cwd?: string } = {}): number {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status ?? 127;
}

function labelsOfCleanup(item: CleanupRecord): Set<string> {
  const names = new Set<string>();
  for (const label of item.labels || []) {
    if (typeof label === "string") names.add(label);
    else if (label && typeof label === "object" && label.name) names.add(String(label.name));
  }
  return names;
}

function isMergedPrForCleanup(pr: CleanupRecord): boolean {
  return String(pr.state || "").toUpperCase() === "MERGED" || Boolean(pr.mergedAt);
}

function isClosedPrForCleanup(pr: CleanupRecord): boolean {
  const state = String(pr.state || "").toUpperCase();
  return ["CLOSED", "MERGED"].includes(state) || Boolean(pr.closedAt) || Boolean(pr.mergedAt);
}

function isPiLooperPrForCleanup(pr: CleanupRecord, config: CleanupConfig): boolean {
  const branch = String(pr.headRefName || "");
  return branch.startsWith("agent/issue-") || [config.reviewLabel, config.humanLabel].some((label) => labelsOfCleanup(pr).has(label));
}

function expandHomeForCleanup(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function normPathForCleanup(value: string): string {
  return path.resolve(expandHomeForCleanup(value));
}

function isUnderRootForCleanup(candidatePath: string, root: string): boolean {
  if (!root) return true;
  const absolutePath = normPathForCleanup(candidatePath);
  const absoluteRoot = normPathForCleanup(root);
  const relative = path.relative(absoluteRoot, absolutePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isCleanStatusForCleanup(status: unknown): boolean {
  return String(status || "").trim() === "";
}

function localHeadMatchesClosedPr(
  worktree: CleanupRecord,
  pr: CleanupRecord,
  gitHeads: Record<string, string>,
  live: boolean,
): boolean {
  const headOid = String(pr.headRefOid || "");
  if (!headOid) return false;
  const worktreePath = String(worktree.path || "");
  let localHead = gitHeads[worktreePath];
  if (localHead === undefined && live) {
    localHead = runCleanupText(["git", "-C", worktreePath, "rev-parse", "HEAD"], { check: false }).trim();
  }
  if (!localHead) return false;
  if (localHead === headOid) return true;
  if (!live) return false;
  return runCleanupCode(["git", "-C", worktreePath, "merge-base", "--is-ancestor", localHead, headOid]) === 0;
}

function skipCleanup(reason: string, pr: CleanupRecord, worktree: CleanupRecord): CleanupRecord {
  return {
    reason,
    prNumber: pr.number,
    branch: worktree.branch || pr.headRefName,
    path: worktree.path,
    workspaceId: workspaceIdForCleanup(worktree),
  };
}

function cleanupCandidate(pr: CleanupRecord, worktree: CleanupRecord, reason: string): CleanupRecord {
  return {
    prNumber: pr.number,
    branch: worktree.branch,
    path: worktree.path,
    workspaceId: workspaceIdForCleanup(worktree),
    reason,
  };
}

function selectCleanupPlan({
  config,
  prs,
  worktrees,
  gitStatuses,
  gitHeads = {},
  live = false,
}: {
  config: CleanupConfig;
  prs: CleanupRecord[];
  worktrees: CleanupRecord[];
  gitStatuses: Record<string, string>;
  gitHeads?: Record<string, string>;
  live?: boolean;
}): { candidates: CleanupRecord[]; skipped: CleanupRecord[] } {
  const byBranch = new Map<string, CleanupRecord>();
  for (const worktree of worktrees) if (worktree.branch) byBranch.set(String(worktree.branch), worktree);
  const candidates: CleanupRecord[] = [];
  const skipped: CleanupRecord[] = [];
  const selectedPaths = new Set<string>();

  for (const pr of [...prs].sort((left, right) => Number(left.number || 0) - Number(right.number || 0))) {
    const branch = String(pr.headRefName || "");
    if (!branch || !isClosedPrForCleanup(pr) || !isPiLooperPrForCleanup(pr, config)) continue;
    const worktree = byBranch.get(branch);
    if (!worktree) continue;

    const worktreePath = String(worktree.path || "");
    if (!worktreePath) {
      skipped.push(skipCleanup("missing_path", pr, worktree));
      continue;
    }
    if (normPathForCleanup(worktreePath) === normPathForCleanup(config.repoPath)) {
      skipped.push(skipCleanup("main_workspace", pr, worktree));
      continue;
    }
    if (worktree.is_linked_worktree === false) {
      skipped.push(skipCleanup("not_linked_worktree", pr, worktree));
      continue;
    }
    if (!workspaceIdForCleanup(worktree)) {
      skipped.push(skipCleanup("missing_workspace_id", pr, worktree));
      continue;
    }
    if (!isUnderRootForCleanup(worktreePath, config.worktreeRoot)) {
      skipped.push(skipCleanup("outside_worktree_root", pr, worktree));
      continue;
    }

    let status = gitStatuses[worktreePath];
    if (status === undefined && live) {
      try {
        status = runCleanupText(["git", "-C", worktreePath, "status", "--short"]);
      } catch {
        skipped.push(skipCleanup("status_unavailable", pr, worktree));
        continue;
      }
    }
    if (status === undefined) {
      skipped.push(skipCleanup("status_unavailable", pr, worktree));
      continue;
    }
    if (!isCleanStatusForCleanup(status)) {
      skipped.push(skipCleanup("dirty_worktree", pr, worktree));
      continue;
    }

    let reason: string;
    if (isMergedPrForCleanup(pr)) {
      reason = "merged_pr";
    } else if (localHeadMatchesClosedPr(worktree, pr, gitHeads, live)) {
      reason = "closed_pr_head_preserved";
    } else {
      skipped.push(skipCleanup("closed_pr_head_not_verified", pr, worktree));
      continue;
    }

    if (selectedPaths.has(worktreePath)) continue;
    selectedPaths.add(worktreePath);
    candidates.push(cleanupCandidate(pr, worktree, reason));
  }

  return { candidates, skipped };
}

function cleanupConfigFromEnv(): CleanupConfig {
  return {
    repo: process.env.DEADLOOP_GITHUB_REPO || "",
    repoPath: process.env.DEADLOOP_REPO_PATH || "",
    worktreeRoot: process.env.DEADLOOP_WORKTREE_ROOT || "",
    reviewLabel: process.env.DEADLOOP_REVIEW_LABEL || DEFAULT_REVIEW_LABEL,
    humanLabel: process.env.DEADLOOP_HUMAN_LABEL || DEFAULT_HUMAN_LABEL,
  };
}

function cleanupConfigFromFixture(data: CleanupRecord): CleanupConfig {
  return {
    repo: String(data.repo || "owner/repo"),
    repoPath: String(data.repoPath || "/repo"),
    worktreeRoot: String(data.worktreeRoot || ""),
    reviewLabel: String(data.reviewLabel || DEFAULT_REVIEW_LABEL),
    humanLabel: String(data.humanLabel || DEFAULT_HUMAN_LABEL),
  };
}

function loadLiveCleanupPlan(config: CleanupConfig): { candidates: CleanupRecord[]; skipped: CleanupRecord[] } {
  const prs: CleanupRecord[] = [];
  const seen = new Set<number>();
  for (const state of ["merged", "closed"]) {
    let batch: CleanupRecord[] = [];
    try {
      batch = runCleanupJson([
        "gh",
        "pr",
        "list",
        "-R",
        config.repo,
        "--state",
        state,
        "--limit",
        "100",
        "--json",
        "number,state,mergedAt,closedAt,headRefName,headRefOid,labels",
      ]);
    } catch {
      batch = [];
    }
    for (const pr of batch) {
      const number = Number(pr.number || 0);
      if (seen.has(number)) continue;
      seen.add(number);
      prs.push(pr);
    }
  }

  const worktrees = cleanupHerdrRunner().listWorktrees(config.repoPath);
  return selectCleanupPlan({ config, prs, worktrees, gitStatuses: {}, live: true });
}

function loadFixtureCleanupPlan(file: string): { candidates: CleanupRecord[]; skipped: CleanupRecord[] } {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return selectCleanupPlan({
    config: cleanupConfigFromFixture(data),
    prs: data.prs || [],
    worktrees: (data.worktrees || []).map(normalizeHerdrWorktreeRecord),
    gitStatuses: data.git?.statuses || {},
    gitHeads: data.git?.heads || {},
  });
}

function applyCleanupPlan(plan: { candidates: CleanupRecord[]; skipped: CleanupRecord[] }, config: CleanupConfig): CleanupRecord {
  runCleanupText(["git", "-C", config.repoPath, "fetch", "--prune"], { check: false });
  const removed: CleanupRecord[] = [];
  const failed: CleanupRecord[] = [];

  for (const item of plan.candidates) {
    const workspaceId = item.workspaceId;
    try {
      if (!workspaceId) throw new Error("missing Herdr workspace id; refusing direct git worktree removal");
      cleanupHerdrRunner().removeWorktree(String(workspaceId));
      removed.push(item);
    } catch (error) {
      failed.push({ ...item, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { ...plan, removed, failed };
}

function requiredCleanupValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseCleanupArgs(argv: string[]): CleanupRecord {
  const parsed: CleanupRecord = { apply: false, plan: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--apply") {
      parsed.apply = true;
      continue;
    }
    if (token === "--plan") {
      parsed.plan = true;
      continue;
    }
    if (token === "--json") {
      parsed.json = true;
      continue;
    }
    if (token === "--fixture") {
      parsed.fixture = requiredCleanupValue(argv, index, token);
      index += 1;
      continue;
    }
    if (token.startsWith("--fixture=")) {
      parsed.fixture = token.slice("--fixture=".length);
      continue;
    }
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown flag: ${token}`);
  }
  return parsed;
}

function cleanupHelp(): string {
  return "Usage: cleanup-completed-worker-worktrees.ts [--plan|--apply] [--json] [--fixture FILE]";
}

function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseCleanupArgs(argv);
  if (args.help) {
    process.stdout.write(`${cleanupHelp()}\n`);
    return 0;
  }

  let result: CleanupRecord;
  if (args.fixture) {
    result = loadFixtureCleanupPlan(args.fixture);
  } else {
    const config = cleanupConfigFromEnv();
    if (!config.repo || !config.repoPath) throw new Error("DEADLOOP_GITHUB_REPO and DEADLOOP_REPO_PATH are required");
    const plan = loadLiveCleanupPlan(config);
    result = args.apply ? applyCleanupPlan(plan, config) : plan;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(`cleanup candidates: ${(result.candidates || []).length}\n`);
    if (result.removed !== undefined) process.stdout.write(`removed: ${(result.removed || []).length}\n`);
    if (result.failed?.length) process.stdout.write(`failed: ${result.failed.length}\n`);
  }
  return result.failed?.length ? 1 : 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`cleanup-completed-worker-worktrees.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

module.exports = {
  applyCleanupPlan,
  loadFixtureCleanupPlan,
  selectCleanupPlan,
};
