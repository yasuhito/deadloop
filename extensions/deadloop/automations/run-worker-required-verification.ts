#!/usr/bin/env node
// Execute the immutable Worker verification contract and persist authoritative evidence.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { readAttemptRecord, validateCompletionReportBinding } = require("../../../src/attempt-lifecycle-runtime.cjs");
const {
  assertCurrentWorkerContract,
  requiredVerificationBinding,
  workerRequiredVerificationPath,
  writeRequiredVerificationRecord,
} = require("../../../src/worker-required-verification-runtime.cjs");
const { runProjectCheck } = require("../../../src/project-check.ts");

type Args = { attemptRecord: string; projectRepo: string; worktree: string; quarantineRoot: string };
function parseArgs(argv: string[]): Args {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  for (const field of ["attemptRecord", "projectRepo", "worktree", "quarantineRoot"]) if (!values[field]) throw new Error(`--${field} is required`);
  return values as Args;
}
function gitHead(worktree: string): string {
  const result = require("node:child_process").spawnSync("git", ["-C", worktree, "rev-parse", "--verify", "HEAD^{commit}"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(String(result.stderr || "cannot resolve Worker HEAD").trim());
  return String(result.stdout).trim();
}
async function run(args: Args) {
  const runDir = path.dirname(args.attemptRecord);
  const attempt = readAttemptRecord(runDir);
  const report = JSON.parse(fs.readFileSync(attempt.promiseFile, "utf8"));
  validateCompletionReportBinding(attempt, report);
  if (attempt.role !== "worker" || report.status !== "complete") throw new Error("complete Worker report is required");
  const contract = assertCurrentWorkerContract(attempt, args.projectRepo);
  const outputRevision = report.result.outputRevision;
  if (gitHead(args.worktree).toLowerCase() !== outputRevision.toLowerCase()) throw new Error("Worker outputRevision does not match worktree HEAD");
  const recordFile = workerRequiredVerificationPath(args.attemptRecord);
  const logPath = path.join(runDir, "required-verification.log");
  const started = Date.now();
  const check = await runProjectCheck({ cwd: args.worktree, command: contract.command, quarantineRoot: args.quarantineRoot, timeoutMs: 10 * 60_000 });
  const outcome = check.timedOut ? "timed_out" : check.interrupted ? "interrupted" : check.code === 0 && !check.restorationFailure ? "passed" : "failed";
  fs.writeFileSync(logPath, `${check.stdout}${check.stderr}`, { encoding: "utf8", mode: 0o600 });
  const record = {
    version: 1 as const,
    binding: requiredVerificationBinding(contract, outputRevision),
    outcome,
    exitCode: check.timedOut || check.interrupted ? null : check.code,
    startedAt: new Date(started).toISOString(),
    durationMs: Math.max(0, Date.now() - started),
    logPath,
  };
  writeRequiredVerificationRecord(recordFile, record);
  if (outcome !== "passed") throw new Error(`required verification ${outcome}; log: ${logPath}`);
  return { status: "passed", outputRevision, recordFile, logPath };
}
async function main() {
  try { process.stdout.write(`${JSON.stringify(await run(parseArgs(process.argv.slice(2))))}\n`); }
  catch (error) { console.error(`run-worker-required-verification.ts: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }
}
if (require.main === module) void main();
module.exports = { parseArgs, run };
