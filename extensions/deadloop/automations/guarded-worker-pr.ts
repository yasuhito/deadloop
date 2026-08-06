#!/usr/bin/env node
// Create the Worker PR only after authoritative output-commit verification.

const fs = require("node:fs") as typeof import("node:fs");
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { withEnabledProjectLock, MAX_GUARDED_OPERATION_MS } = require("../../../src/enabled-operation.cjs");
const { resolveVerifiedPushDestination } = require("./verified-push-destination.ts");
const { readAttemptRecord, validateCompletionReportBinding } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { createCommandRunner } = require("../../../src/automation-driver-kit.ts");
const { assertAttemptProjectBinding, assertWorktreeBelongsToProject, canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");
const {
  assertCurrentWorkerContract,
  assertWorkerCompletionAuthorized,
  readRequiredVerificationRecord,
  workerRequiredVerificationPath,
} = require("../../../src/worker-required-verification-runtime.cjs");

type Args = { attemptRecord: string; projectId: string; projectRepo: string; githubRepo: string; stateDir: string; enabledAt: number; title: string; reviewLabel: string };
function parseArgs(argv: string[]): Args {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  const enabledAt = Number(values.enabledAt);
  for (const field of ["attemptRecord", "projectId", "projectRepo", "githubRepo", "stateDir", "title", "reviewLabel"]) if (!values[field]) throw new Error(`--${field} is required`);
  if (!Number.isFinite(enabledAt)) throw new Error("--enabled-at is required");
  return { ...values, enabledAt } as Args;
}
function command(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: MAX_GUARDED_OPERATION_MS });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || `${command} failed`).trim());
  return String(result.stdout || "").trim();
}
function gh(args: string[], json = false): any {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: MAX_GUARDED_OPERATION_MS });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "GitHub operation failed").trim());
  return json ? JSON.parse(String(result.stdout || "null")) : String(result.stdout || "").trim();
}
function assertWorkerPrBinding(attempt: { project: string; repository: string }, args: Pick<Args, "projectId" | "githubRepo">): void {
  if (attempt.project !== args.projectId) throw new Error("attempt project does not match Worker PR project");
  if (attempt.repository !== args.githubRepo) throw new Error("attempt repository does not match Worker PR repository");
}
type WorkerPrOps = {
  remoteHead: () => string;
  gh: (args: string[], json?: boolean) => any;
  recheck: () => void;
};
function ensureWorkerPr(
  attempt: { branch: string; baseBranch?: string; target: { number: number } },
  outputRevision: string,
  args: Pick<Args, "githubRepo" | "title">,
  ops: WorkerPrOps,
): number {
  if (ops.remoteHead().toLowerCase() !== outputRevision.toLowerCase()) throw new Error("remote Worker branch is not the verified output commit");
  const existing = ops.gh(["pr", "list", "-R", args.githubRepo, "--state", "open", "--head", attempt.branch, "--json", "number,headRefOid"], true);
  if (Array.isArray(existing) && existing.length === 1) {
    if (String(existing[0].headRefOid).toLowerCase() !== outputRevision.toLowerCase()) throw new Error("existing Worker PR head is not the verified output commit");
    return Number(existing[0].number);
  }
  if (!Array.isArray(existing) || existing.length !== 0) throw new Error("Worker branch must have zero or one open PR");
  ops.recheck();
  if (ops.remoteHead().toLowerCase() !== outputRevision.toLowerCase()) throw new Error("remote Worker branch changed at the PR creation boundary");
  const url = ops.gh(["pr", "create", "-R", args.githubRepo, "--base", String(attempt.baseBranch || "origin/main").replace(/^origin\//, ""), "--head", attempt.branch, "--title", args.title, "--body", `Closes #${attempt.target.number}`]);
  const match = String(url).match(/\/(\d+)\/?$/);
  if (!match) throw new Error("created Worker PR number was not returned");
  const number = Number(match[1]);
  const created = ops.gh(["pr", "view", String(number), "-R", args.githubRepo, "--json", "headRefOid"], true);
  if (String(created.headRefOid).toLowerCase() !== outputRevision.toLowerCase()) {
    ops.gh(["pr", "close", String(number), "-R", args.githubRepo]);
    throw new Error("created Worker PR head is not the verified output commit; PR closed");
  }
  return number;
}
function verified(args: Args) {
  const location = canonicalAttemptLocation(args);
  const attempt = readAttemptRecord(location.runDir);
  assertWorkerPrBinding(attempt, args);
  assertAttemptProjectBinding(attempt, args);
  assertWorktreeBelongsToProject(createCommandRunner(), attempt, args);
  const report = JSON.parse(fs.readFileSync(attempt.promiseFile, "utf8"));
  validateCompletionReportBinding(attempt, report);
  const current = assertCurrentWorkerContract(attempt, args.projectRepo);
  const record = readRequiredVerificationRecord(workerRequiredVerificationPath(args.attemptRecord));
  assertWorkerCompletionAuthorized(attempt, report, record, current);
  return { attempt, report };
}
function run(args: Args): number {
  verified(args);
  return withEnabledProjectLock(
    { repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt },
    (enabled: { githubRepositoryId: string }, recheck: () => void) => {
      const { attempt, report } = verified(args);
      const destination = resolveVerifiedPushDestination(
        { run: (argv: string[]) => { const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: MAX_GUARDED_OPERATION_MS }); return { status: result.status ?? 1, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") }; } },
        args.projectRepo,
        "origin",
        args.githubRepo,
        enabled.githubRepositoryId,
        MAX_GUARDED_OPERATION_MS,
      );
      const remoteHead = () => command("git", ["ls-remote", "--heads", destination, `refs/heads/${attempt.branch}`]).split(/\s+/, 1)[0] || "";
      const number = ensureWorkerPr(attempt, report.result.outputRevision, args, { remoteHead, gh, recheck });
      const observedBeforeLabel = gh(["pr", "view", String(number), "-R", args.githubRepo, "--json", "headRefOid"], true);
      if (String(observedBeforeLabel.headRefOid).toLowerCase() !== report.result.outputRevision.toLowerCase()) {
        throw new Error("Worker PR head changed before the success label");
      }
      recheck();
      gh(["pr", "edit", String(number), "-R", args.githubRepo, "--add-label", args.reviewLabel]);
      const observedAfterLabel = gh(["pr", "view", String(number), "-R", args.githubRepo, "--json", "headRefOid"], true);
      if (String(observedAfterLabel.headRefOid).toLowerCase() !== report.result.outputRevision.toLowerCase()) {
        gh(["pr", "edit", String(number), "-R", args.githubRepo, "--remove-label", args.reviewLabel]);
        throw new Error("Worker PR head changed while adding the success label; label removed");
      }
      return 0;
    },
  );
}
function main() { try { process.exitCode = run(parseArgs(process.argv.slice(2))); } catch (error) { console.error(`guarded-worker-pr.ts: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; } }
if (require.main === module) main();
module.exports = { assertWorkerPrBinding, ensureWorkerPr, parseArgs, run, verified };
