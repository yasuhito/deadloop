#!/usr/bin/env node
// Close the still-open workspace of a settled attempt (journal released or monitored PR closed).
// The ownership proof and the exactly-once cleanup receipt live in the shared closure module;
// this command only binds them to the enabled project lock and prints a driver result.

const path = require("node:path") as typeof import("node:path");

const { createCommandRunner, driverResult } = require("../../../src/automation-driver-kit.cts");
const { withEnabledDriverLock } = require("../../../src/driver-enablement.cjs");
const { runHerdrPreflight } = require("../../../src/herdr-preflight.cjs");
const { closeSettledAttemptWorkspace } = require("../../../src/settled-workspace-closure.cts");

type JsonObject = Record<string, any>;

function parseArgs(argv: string[]): JsonObject {
  const values: JsonObject = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const name of ["attemptRecord", "projectId", "projectRepo", "githubRepo", "stateDir", "enabledAt"]) {
    if (!values[name]) throw new Error(`--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)} is required`);
  }
  return values;
}

function close(args: JsonObject): JsonObject {
  const commandRunner = createCommandRunner();
  runHerdrPreflight({ run: (command: string, commandArgs: string[]) => commandRunner.runText([command, ...commandArgs]) });
  const project = {
    id: String(args.projectId),
    repoPath: path.resolve(String(args.projectRepo)),
    githubRepo: String(args.githubRepo),
    stateDir: path.resolve(String(args.stateDir)),
    enabledAt: Number(args.enabledAt),
  };
  return withEnabledDriverLock(project, () => {
    const closure = closeSettledAttemptWorkspace({
      attemptRecord: String(args.attemptRecord),
      projectId: String(args.projectId),
      projectRepo: String(args.projectRepo),
      githubRepo: String(args.githubRepo),
      stateDir: String(args.stateDir),
      enabledAt: String(args.enabledAt),
    }, commandRunner);
    return closure.closed
      ? driverResult("done", "settled attempt workspace closed", { driverAction: "workspace_closed" })
      : driverResult("done", `settled attempt workspace closure is pending: ${closure.detail}`, {
          driverAction: "cleanup_pending", detail: closure.detail,
        });
  });
}

function main(): void {
  try { process.stdout.write(`${JSON.stringify(close(parseArgs(process.argv.slice(2))))}\n`); }
  catch (error) {
    process.stdout.write(`${JSON.stringify(driverResult("error", error instanceof Error ? error.message : String(error), { driverAction: "exception" }))}\n`);
  }
}

if (require.main === module) main();
module.exports = { close, parseArgs };
