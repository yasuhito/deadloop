#!/usr/bin/env node
// Execute the immutable Worker verification contract and persist authoritative evidence.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { readAttemptRecord, validateCompletionReportBinding } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { createCommandRunner } = require("../../../src/automation-driver-kit.ts");
const { assertAttemptProjectBinding, assertWorktreeBelongsToProject, canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");
const {
  assertCurrentWorkerContract,
  requiredVerificationBinding,
  workerRequiredVerificationPath,
  writeRequiredVerificationRecord,
} = require("../../../src/worker-required-verification-runtime.cjs");
const {
  projectCheckRestorationFailureFrom,
  recordProjectCheckRestorationFailure,
  runProjectCheck,
} = require("../../../src/project-check.ts");

type Args = { attemptRecord: string; projectId: string; projectRepo: string; githubRepo: string; stateDir: string; worktree: string; quarantineRoot: string };
function parseArgs(argv: string[]): Args {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const field of ["attemptRecord", "projectId", "projectRepo", "githubRepo", "stateDir", "worktree", "quarantineRoot"])  if (!values[field]) throw new Error(`--${field} is required`);
  return values as Args;
}
function gitText(worktree: string, args: string[]): string {
  const result = require("node:child_process").spawnSync("git", ["-C", worktree, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(String(result.stderr || "cannot inspect Worker checkout").trim());
  return String(result.stdout).trim();
}
function assertCleanOutput(worktree: string, outputRevision: string): void {
  if (gitText(worktree, ["rev-parse", "--verify", "HEAD^{commit}"]).toLowerCase() !== outputRevision.toLowerCase()) {
    throw new Error("Worker outputRevision does not match worktree HEAD");
  }
  if (gitText(worktree, [
    "status", "--porcelain", "--untracked-files=all", "--", ".",
    ":(exclude).deadloop", ":(exclude).deadloop/**",
    ":(exclude).pi-subagents", ":(exclude).pi-subagents/**",
  ])) {
    throw new Error("Worker output checkout must be clean before required verification");
  }
}
async function runWorkerProjectCheck(
  input: { cwd: string; command: string; quarantineRoot: string; timeoutMs: number },
  signal: AbortSignal | undefined,
  runner: typeof runProjectCheck = runProjectCheck,
) {
  const checkInput = { ...input, signal };
  let check;
  try {
    check = await runner(checkInput);
  } catch (error) {
    const failure = projectCheckRestorationFailureFrom(error);
    if (failure) recordProjectCheckRestorationFailure(checkInput, failure);
    throw error;
  }
  const restorationFailureRecordPath = check.restorationFailure
    ? recordProjectCheckRestorationFailure(checkInput, check.restorationFailure)
    : undefined;
  return { check, restorationFailureRecordPath };
}
async function run(args: Args, signal?: AbortSignal) {
  const location = canonicalAttemptLocation(args);
  const runDir = location.runDir;
  const attempt = readAttemptRecord(runDir);
  assertAttemptProjectBinding(attempt, args);
  const runner = createCommandRunner();
  const confinement = assertWorktreeBelongsToProject(runner, attempt, args);
  if (path.resolve(args.worktree) !== confinement.worktreePath) throw new Error("--worktree does not match the attempt worktree");
  const report = JSON.parse(fs.readFileSync(attempt.promiseFile, "utf8"));
  validateCompletionReportBinding(attempt, report);
  if (attempt.role !== "worker" || report.status !== "complete") throw new Error("complete Worker report is required");
  const contract = assertCurrentWorkerContract(attempt, args.projectRepo, process.env.DEADLOOP_CONFIG || path.join(args.stateDir, "projects.json"));
  const outputRevision = report.result.outputRevision;
  assertCleanOutput(args.worktree, outputRevision);
  const recordFile = workerRequiredVerificationPath(args.attemptRecord);
  const logPath = path.join(runDir, "required-verification.log");
  const started = Date.now();
  const { check, restorationFailureRecordPath } = await runWorkerProjectCheck(
    { cwd: args.worktree, command: contract.command, quarantineRoot: args.quarantineRoot, timeoutMs: 10 * 60_000 },
    signal,
  );
  const outcome = check.timedOut ? "timed_out" : check.interrupted ? "interrupted" : check.code === 0 && !check.restorationFailure ? "passed" : "failed";
  fs.writeFileSync(logPath, `${check.stdout}${check.stderr}`, { encoding: "utf8", mode: 0o600 });
  assertCleanOutput(args.worktree, outputRevision);
  const record = {
    version: 1 as const,
    binding: requiredVerificationBinding(contract, outputRevision),
    outcome,
    exitCode: check.timedOut || check.interrupted ? null : check.code,
    startedAt: new Date(started).toISOString(),
    durationMs: Math.max(0, Date.now() - started),
    logPath,
    ...(check.restorationFailure ? { artifactRestorationFailure: check.restorationFailure, restorationFailureRecordPath } : {}),
  };
  writeRequiredVerificationRecord(recordFile, record);
  if (outcome !== "passed") throw new Error(`required verification ${outcome}; log: ${logPath}`);
  return { status: "passed", outputRevision, recordFile, logPath };
}
async function main() {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try { process.stdout.write(`${JSON.stringify(await run(parseArgs(process.argv.slice(2)), controller.signal))}\n`); }
  catch (error) { console.error(`run-worker-required-verification.ts: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }
  finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
if (require.main === module) void main();
module.exports = { assertCleanOutput, parseArgs, run, runWorkerProjectCheck };
