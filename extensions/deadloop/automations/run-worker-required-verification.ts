#!/usr/bin/env node
// Execute the immutable Worker verification contract and persist authoritative evidence.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { hasUncommittedWork, UNCOMMITTED_WORK_STATUS_ARGS } = require("../../../src/agent-scratch-area.ts");
const { readAttemptRecord, validateCompletionReportBinding } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { createCommandRunner } = require("../../../src/automation-driver-kit.ts");
const { assertAttemptProjectBinding, assertWorktreeBelongsToProject, canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");
const {
  assertCurrentWorkerContract,
  persistHostVerificationEvidence,
  requiredVerificationBinding,
  workerRequiredVerificationPath,
} = require("../../../src/worker-required-verification-runtime.cjs");
const {
  projectCheckRestorationFailureFrom,
  recordProjectCheckRestorationFailure,
  runProjectCheck,
} = require("../../../src/project-check.ts");

type Args = { attemptRecord: string; projectId: string; projectRepo: string; githubRepo: string; stateDir: string; enabledAt: number; worktree: string; quarantineRoot: string };
function parseArgs(argv: string[]): Args {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const field of ["attemptRecord", "projectId", "projectRepo", "githubRepo", "stateDir", "enabledAt", "worktree", "quarantineRoot"])  if (!values[field]) throw new Error(`--${field} is required`);
  const enabledAt = Number(values.enabledAt);
  if (!Number.isFinite(enabledAt)) throw new Error("--enabled-at is required");
  return { ...values, enabledAt } as Args;
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
  const flagged = gitText(worktree, ["ls-files", "-v"]).split(/\r?\n/).filter((line) => /^[a-zS]/.test(line));
  if (flagged.length) throw new Error("Worker output checkout has assume-unchanged or skip-worktree index flags");
  if (hasUncommittedWork(gitText(worktree, UNCOMMITTED_WORK_STATUS_ARGS))) {
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
function writeVerificationLog(logPath: string, contents: string): void {
  try {
    const existing = fs.lstatSync(logPath);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("required verification log path is not a regular file");
    fs.unlinkSync(logPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const descriptor = fs.openSync(logPath, flags, 0o600);
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error("required verification log is not a regular file");
    fs.writeFileSync(descriptor, contents, { encoding: "utf8" });
  } finally {
    fs.closeSync(descriptor);
  }
}
async function run(
  args: Args,
  signal?: AbortSignal,
  verificationRunner: typeof runWorkerProjectCheck = runWorkerProjectCheck,
  enabledResolver: (project: Record<string, unknown>) => { githubRepositoryId?: string } = require("../../../src/enabled-operation.cjs").assertLocallyEnabled,
) {
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
  const enabled = enabledResolver({ repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt });
  const contract = assertCurrentWorkerContract(attempt, args.projectRepo, process.env.DEADLOOP_CONFIG || path.join(args.stateDir, "projects.json"), enabled.githubRepositoryId);
  const outputRevision = report.result.outputRevision;
  assertCleanOutput(args.worktree, outputRevision);
  const recordFile = workerRequiredVerificationPath(args.attemptRecord);
  // Attempt-local files are Worker-writable, so they cannot authenticate host execution.
  // Always replace any existing record with evidence from a fresh fixed-command run.
  const logPath = path.join(runDir, "required-verification.log");
  const started = Date.now();
  let check;
  let restorationFailureRecordPath: string | undefined;
  let runnerFailure: unknown;
  try {
    ({ check, restorationFailureRecordPath } = await verificationRunner(
      { cwd: args.worktree, command: contract.command, quarantineRoot: args.quarantineRoot, timeoutMs: 10 * 60_000 },
      signal,
    ));
  } catch (error) {
    runnerFailure = error;
    check = {
      code: null,
      stdout: "",
      stderr: `required verification runner failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
      timedOut: false,
      interrupted: false,
      signal: null,
      ...(projectCheckRestorationFailureFrom(error) ? { restorationFailure: projectCheckRestorationFailureFrom(error) } : {}),
    };
  }
  let outputFailure: unknown;
  try {
    assertCleanOutput(args.worktree, outputRevision);
    const currentAfterCheck = assertCurrentWorkerContract(attempt, args.projectRepo, process.env.DEADLOOP_CONFIG || path.join(args.stateDir, "projects.json"), enabled.githubRepositoryId);
    if (JSON.stringify(currentAfterCheck) !== JSON.stringify(contract)) throw new Error("required verification blocked: stale_policy; policy changed during verification");
  } catch (error) { outputFailure = error; }
  const outcome = check.timedOut ? "timed_out" : check.interrupted ? "interrupted" : check.code === 0 && !check.restorationFailure && !outputFailure ? "passed" : "failed";
  const terminationReason = check.timedOut ? "timeout"
    : check.interrupted ? "interrupted"
      : runnerFailure ? "runner_failure"
        : outputFailure ? "output_not_clean"
          : check.restorationFailure ? "artifact_restoration_failure"
            : check.signal ? "signal" : undefined;
  const outputEvidence = outputFailure ? `required verification post-check binding failed: ${outputFailure instanceof Error ? outputFailure.message : String(outputFailure)}\n` : "";
  writeVerificationLog(logPath, `${check.stdout}${check.stderr}${outputEvidence}`);
  const record = {
    version: 1 as const,
    binding: requiredVerificationBinding(contract, outputRevision),
    outcome,
    exitCode: check.timedOut || check.interrupted || runnerFailure ? null : check.code,
    ...(terminationReason ? { terminationReason } : {}),
    ...(check.signal ? { terminationSignal: check.signal } : {}),
    startedAt: new Date(started).toISOString(),
    durationMs: Math.max(0, Date.now() - started),
    logPath,
    ...(check.restorationFailure ? { artifactRestorationFailure: check.restorationFailure, restorationFailureRecordPath } : {}),
  };
  persistHostVerificationEvidence(recordFile, record);
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
module.exports = { assertCleanOutput, parseArgs, run, runWorkerProjectCheck, writeVerificationLog };
