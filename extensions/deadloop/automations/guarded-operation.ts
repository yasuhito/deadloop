#!/usr/bin/env node
// Run one monitor-side mutation while holding the enablement lock shared with
// /deadloop-disable. A disabled repository never starts the command.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");

const GUARDED_OPERATION_TIMEOUT_MS = MAX_GUARDED_OPERATION_MS;

type Args = { projectRepo: string; githubRepo: string; stateDir: string; enabledAt: number; command: string[] };

function parseArgs(argv: string[]): Args {
  const separator = argv.indexOf("--");
  if (separator < 0 || separator === argv.length - 1) throw new Error("a command is required after --");
  const values: Record<string, string> = {};
  for (let index = 0; index < separator; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs before --");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  const enabledAt = Number(values.enabledAt);
  if (!values.projectRepo || !values.githubRepo || !values.stateDir || !Number.isFinite(enabledAt)) {
    throw new Error("--project-repo, --github-repo, --state-dir, and --enabled-at are required");
  }
  return { projectRepo: values.projectRepo, githubRepo: values.githubRepo, stateDir: values.stateDir, enabledAt, command: argv.slice(separator + 1) };
}

function runGuarded(args: Args, spawn = spawnSync): number {
  if (/(^|[/\\])git(?:\.exe)?$/.test(args.command[0]) && args.command.slice(1).includes("push")) {
    throw new Error("git push must use guarded-push.ts");
  }
  return withEnabledProjectLock(
    { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt },
    () => {
      const result = spawn(args.command[0], args.command.slice(1), {
        stdio: "inherit",
        timeout: GUARDED_OPERATION_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      if (result.error) throw result.error;
      return result.status ?? 1;
    },
  );
}

function main(): void {
  try {
    process.exitCode = runGuarded(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`guarded-operation.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();
module.exports = { GUARDED_OPERATION_TIMEOUT_MS, parseArgs, runGuarded };
