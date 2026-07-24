#!/usr/bin/env node
// Run one monitor-side mutation while holding the enablement lock shared with
// /deadloop-disable. A disabled repository never starts the command.

const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");

const GUARDED_OPERATION_TIMEOUT_MS = MAX_GUARDED_OPERATION_MS;

type Args = { projectRepo: string; githubRepo: string; stateDir: string; enabledAt: number; command: string[] };

type ApprovedOperation = { positional: number; valueFlags: Set<string> };

const APPROVED_GH_OPERATIONS = new Map<string, ApprovedOperation>([
  ["issue edit", { positional: 1, valueFlags: new Set(["--add-label", "--remove-label"]) }],
  ["issue comment", { positional: 1, valueFlags: new Set(["--body", "--body-file"]) }],
  ["pr create", { positional: 0, valueFlags: new Set(["--base", "--head", "--title", "--body", "--body-file"]) }],
  ["pr edit", { positional: 1, valueFlags: new Set(["--add-label", "--remove-label"]) }],
  ["pr comment", { positional: 1, valueFlags: new Set(["--body", "--body-file"]) }],
]);

function assertApprovedCommand(command: string[], githubRepo: string): void {
  if (!/(^|[/\\])gh(?:\.exe)?$/.test(command[0] || "")) {
    throw new Error("guarded-operation.ts accepts only approved gh mutations; use dedicated helpers for push or branch operations");
  }
  const approved = APPROVED_GH_OPERATIONS.get(`${command[1] || ""} ${command[2] || ""}`);
  if (!approved) {
    throw new Error("GitHub operation is not approved; merge and branch deletion require dedicated helpers");
  }

  const positional: string[] = [];
  let repository = "";
  let repositoryTargets = 0;
  for (let index = 3; index < command.length; index += 1) {
    const token = command[index];
    const equals = token.match(/^(--repo)=([\s\S]+)$/);
    if (token === "-R" || token === "--repo") {
      const value = command[index + 1];
      if (!value) throw new Error("GitHub repository target is missing");
      repository = value;
      repositoryTargets += 1;
      index += 1;
    } else if (equals) {
      repository = equals[2];
      repositoryTargets += 1;
    } else if (approved.valueFlags.has(token)) {
      if (command[index + 1] === undefined) throw new Error(`value is missing for ${token}`);
      index += 1;
    } else if ([...approved.valueFlags].some((flag) => token.startsWith(`${flag}=`))) {
      continue;
    } else if (token.startsWith("-")) {
      throw new Error(`option is not approved for guarded GitHub mutation: ${token}`);
    } else {
      positional.push(token);
    }
  }
  if (repositoryTargets !== 1 || repository !== githubRepo) {
    throw new Error("GitHub repository target does not match enabled repository");
  }
  if (positional.length !== approved.positional || positional.some((value) => !/^\d+$/.test(value))) {
    throw new Error("guarded GitHub mutation has an invalid target");
  }
}

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
  assertApprovedCommand(args.command, args.githubRepo);
  return withEnabledProjectLock(
    { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt },
    (_enabled: unknown, recheck: () => void) => {
      recheck();
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
module.exports = { GUARDED_OPERATION_TIMEOUT_MS, assertApprovedCommand, parseArgs, runGuarded };
