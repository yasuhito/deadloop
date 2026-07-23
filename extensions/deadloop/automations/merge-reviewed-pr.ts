#!/usr/bin/env node
// Merge one reviewed PR only if GitHub still reports the reviewed head commit.
// The mutation is serialized with /deadloop-disable through the enablement lock.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");

type MergeArgs = {
  projectRepo: string;
  githubRepo: string;
  stateDir: string;
  enabledAt: number;
  pr: string;
  expectedHead: string;
};
type CommandResult = { status: number; stdout: string; stderr: string };
type MergeOps = {
  run(args: string[], timeoutMs?: number): CommandResult;
  isAutoMergeEnabled?: (args: MergeArgs) => boolean;
  withLock?: (project: { repoPath: string; githubRepo: string; stateDir: string; enabledAt: number }, operation: () => number) => number;
};

function defaultRun(args: string[], timeoutMs?: number): CommandResult {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: "SIGKILL" }),
  });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function currentAutoMergeEnabled(args: MergeArgs): boolean {
  const configPath = process.env.DEADLOOP_CONFIG || path.join(args.stateDir, "projects.json");
  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(`projects.json read error: ${error instanceof Error ? error.message : String(error)}`);
  }
  let config: unknown;
  try {
    config = JSON.parse(text || "{}");
  } catch (error) {
    throw new Error(`projects.json parse error: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("projects.json must contain an object; automatic merge stopped");
  }
  const configuredProjects = (config as { projects?: unknown }).projects;
  if (configuredProjects !== undefined && !Array.isArray(configuredProjects)) {
    throw new Error("projects.json projects must be an array; automatic merge stopped");
  }
  const rawProjects: unknown[] = Array.isArray(configuredProjects) ? configuredProjects : [];
  const selectedIds = new Set(String(process.env.DEADLOOP_PROJECTS || "").split(",").map((value) => value.trim()).filter(Boolean));
  const matches = rawProjects.filter((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("projects.json contains an invalid project; automatic merge stopped");
    }
    const project = candidate as { id?: unknown; repoPath?: unknown; githubRepo?: unknown };
    const projectId = String(project.id || project.githubRepo || project.repoPath || "project")
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
    if (selectedIds.size > 0 && !selectedIds.has(projectId)) return false;
    return typeof project.repoPath === "string"
      && path.resolve(project.repoPath) === path.resolve(args.projectRepo)
      && project.githubRepo === args.githubRepo;
  }) as Array<{ autoMerge?: unknown }>;
  if (matches.length > 1) throw new Error("current project configuration is ambiguous; automatic merge stopped");
  if (matches.length !== 1) return false;
  if (matches[0].autoMerge !== undefined && typeof matches[0].autoMerge !== "boolean") {
    throw new Error("current autoMerge setting is invalid; automatic merge stopped");
  }
  return matches[0].autoMerge === true;
}

function mergeReviewedPr(args: MergeArgs, ops: MergeOps = { run: defaultRun }): number {
  const project = { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt };
  const operation = () => {
    const autoMergeEnabled = ops.isAutoMergeEnabled ? ops.isAutoMergeEnabled(args) : currentAutoMergeEnabled(args);
    if (!autoMergeEnabled) throw new Error("autoMerge is not currently enabled; automatic merge stopped");
    const result = ops.run([
      "gh", "pr", "merge", args.pr, "-R", args.githubRepo,
      "--squash", "--delete-branch", "--match-head-commit", args.expectedHead,
    ], MAX_GUARDED_OPERATION_MS);
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "guarded PR merge failed").trim());
    return 0;
  };
  return ops.withLock ? ops.withLock(project, operation) : withEnabledProjectLock(project, operation);
}

function parseArgs(argv: string[]): MergeArgs {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  const enabledAt = Number(values.enabledAt);
  if (!values.projectRepo || !values.githubRepo || !values.stateDir || !values.pr || !values.expectedHead || !Number.isFinite(enabledAt)) {
    throw new Error("--project-repo, --github-repo, --state-dir, --enabled-at, --pr, and --expected-head are required");
  }
  return { projectRepo: values.projectRepo, githubRepo: values.githubRepo, stateDir: values.stateDir, enabledAt, pr: values.pr, expectedHead: values.expectedHead };
}

function main(): void {
  try {
    process.exitCode = mergeReviewedPr(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`merge-reviewed-pr.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();
module.exports = { currentAutoMergeEnabled, mergeReviewedPr, parseArgs };
