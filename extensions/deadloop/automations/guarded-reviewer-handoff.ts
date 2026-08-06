#!/usr/bin/env node
// Replace reviewer workflow labels with the human-handoff label only while the
// reviewed PR still points at the approved head.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
const { readAttemptRecord, validateCompletionReportBinding } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { MAX_GUARDED_OPERATION_MS, withEnabledProjectLock } = require("../../../src/enabled-operation.cjs");
const {
  assertCurrentWorkerContract,
  assertWorkerCompletionAuthorized,
  readRequiredVerificationRecord,
  workerRequiredVerificationPath,
} = require("../../../src/worker-required-verification-runtime.cjs");
const { validatePromise } = require("./extract-worker-promise.ts");

type Args = {
  projectRepo: string; githubRepo: string; stateDir: string; enabledAt: number;
  pr: string; expectedHead: string; reviewPromise: string;
  reviewLabel: string; reviewingLabel: string; blockedLabel: string; humanLabel: string;
};
type CommandResult = { status: number; stdout: string; stderr: string };
type Ops = {
  run: (args: string[]) => CommandResult;
  validateReviewPromise?: (file: string) => { status?: unknown; promise?: Record<string, any>; evidenceStrength?: unknown };
  authorizeVerification?: (args: Args) => void;
  withLock?: (project: Pick<Args, "projectRepo" | "githubRepo" | "stateDir" | "enabledAt">, operation: (_enabled: unknown, recheck: () => void) => number) => number;
};

function defaultRun(args: string[]): CommandResult {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", timeout: MAX_GUARDED_OPERATION_MS, killSignal: "SIGKILL" });
  return { status: result.status ?? 1, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}
function runChecked(ops: Ops, args: string[]): string {
  const result = ops.run(args);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${args[0]} failed`).trim());
  return result.stdout;
}
function livePr(args: Args, ops: Ops): Record<string, any> {
  try {
    return JSON.parse(runChecked(ops, ["gh", "pr", "view", args.pr, "-R", args.githubRepo, "--json", "state,isDraft,headRefOid,labels"]));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("PR state response was invalid; human handoff stopped");
    throw error;
  }
}
function labelsOf(pr: Record<string, any>): Set<string> {
  return new Set(Array.isArray(pr.labels) ? pr.labels.map((label: any) => label?.name).filter((name: unknown): name is string => typeof name === "string") : []);
}
function assertApprovedReview(args: Args, ops: Ops): void {
  const validation = ops.validateReviewPromise ? ops.validateReviewPromise(args.reviewPromise) : validatePromise(args.reviewPromise);
  const promise = validation.promise;
  if (validation.evidenceStrength !== "strong") throw new Error("reviewer completion is not strongly bound to its attempt; human handoff stopped");
  if (validation.status !== "complete" || !promise || promise.status !== "complete") throw new Error("validated reviewer completion is missing; human handoff stopped");
  if (String(promise.outcome || "approved") !== "approved") throw new Error("review result is not approved; human handoff stopped");
  if (promise.target?.repository !== args.githubRepo || promise.target?.kind !== "pull-request" || String(promise.target?.number) !== args.pr) {
    throw new Error("review result target does not match the guarded pull request");
  }
  if (String(promise.reviewedHead || "").toLowerCase() !== args.expectedHead.toLowerCase()) throw new Error("reviewed head does not match the guarded handoff head");
  if (Array.isArray(promise.findings) && promise.findings.length !== 0) throw new Error("approved review has findings; human handoff stopped");
}
function readJsonFile(file: string, description: string): Record<string, any> {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("root must be an object");
    return value;
  } catch (error) {
    throw new Error(`${description} is missing, unreadable, or malformed`, { cause: error });
  }
}
function assertCurrentHeadVerification(args: Args): void {
  const runsDir = path.join(args.stateDir, "runs");
  let entries: import("node:fs").Dirent[];
  try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); }
  catch (error) { throw new Error("required verification evidence store is missing or unreadable; human handoff stopped", { cause: error }); }

  const attempts: Array<{ attempt: Record<string, any>; attemptRecord: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const attemptRecord = path.join(runsDir, entry.name, "attempt.json");
    if (!fs.existsSync(attemptRecord)) continue;
    try { attempts.push({ attempt: readAttemptRecord(path.dirname(attemptRecord)), attemptRecord }); }
    catch (error) { throw new Error("required verification evidence store contains a malformed attempt; human handoff stopped", { cause: error }); }
  }

  const authorize = (head: string, visited: Set<string>): Record<string, any> => {
    const normalizedHead = head.toLowerCase();
    if (visited.has(normalizedHead)) throw new Error("required verification provenance contains a cycle");
    const candidates = attempts.filter(({ attempt }) => attempt.repository === args.githubRepo
      && String(attempt.outputRevision || "").toLowerCase() === normalizedHead
      && (attempt.role === "worker" || attempt.role === "review-repair" || attempt.role === "branch-update"));
    if (candidates.length !== 1) {
      throw new Error(candidates.length ? "required verification provenance is ambiguous" : "authoritative current-head verification is missing");
    }
    const { attempt, attemptRecord } = candidates[0];
    if (attempt.role === "worker") {
      const current = assertCurrentWorkerContract(attempt, args.projectRepo, process.env.DEADLOOP_CONFIG || path.join(args.stateDir, "projects.json"));
      const report = readJsonFile(attempt.promiseFile, "Worker completion report");
      validateCompletionReportBinding(attempt, report);
      const record = readRequiredVerificationRecord(workerRequiredVerificationPath(attemptRecord));
      assertWorkerCompletionAuthorized(attempt, report, record, current);
      return current;
    }
    if (attempt.target?.kind !== "pull-request" || String(attempt.target.number) !== args.pr) {
      throw new Error("current-head verification provenance targets another pull request");
    }
    const nextVisited = new Set(visited); nextVisited.add(normalizedHead);
    const current = authorize(String(attempt.inputRevision?.head || ""), nextVisited);
    const report = readJsonFile(attempt.promiseFile, "current-head verification completion report");
    validateCompletionReportBinding(attempt, report);
    const expectedOutcome = attempt.role === "review-repair" ? "repair_pushed" : "branch_update_pushed";
    if (report.status !== "complete" || report.result?.outcome !== expectedOutcome
      || String(report.result?.outputRevision || "").toLowerCase() !== normalizedHead) {
      throw new Error("current-head verification completion report is not a successful bound push");
    }
    const checks = report.evidence?.finalizer?.checks;
    if (!Array.isArray(checks) || checks.length !== 1 || checks[0]?.result !== "passed" || checks[0]?.command !== current.command) {
      throw new Error("current-head verification does not match the trusted contract");
    }
    return current;
  };

  try { authorize(args.expectedHead, new Set()); }
  catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}; human handoff stopped`, { cause: error }); }
}
function assertEligible(args: Args, pr: Record<string, any>): Set<string> {
  const labels = labelsOf(pr);
  if (pr.state !== "OPEN" || pr.isDraft !== false) throw new Error("PR is not an open non-draft PR; human handoff stopped");
  if (String(pr.headRefOid || "").toLowerCase() !== args.expectedHead.toLowerCase()) throw new Error("PR head changed; human handoff stopped");
  if (!labels.has(args.reviewLabel) || !labels.has(args.reviewingLabel) || labels.has(args.blockedLabel)) throw new Error("review workflow labels do not authorize human handoff");
  return labels;
}
function handoffReviewedPr(args: Args, ops: Ops = { run: defaultRun }): number {
  assertApprovedReview(args, ops);
  const authorizeVerification = ops.authorizeVerification || assertCurrentHeadVerification;
  authorizeVerification(args);
  const project = { projectRepo: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt };
  const operation = (_enabled: unknown, recheck: () => void) => {
    assertEligible(args, livePr(args, ops));
    recheck();
    assertEligible(args, livePr(args, ops));
    authorizeVerification(args);
    const boundaryLabels = assertEligible(args, livePr(args, ops));
    runChecked(ops, ["gh", "pr", "edit", args.pr, "-R", args.githubRepo,
      "--remove-label", args.reviewLabel, "--remove-label", args.reviewingLabel,
      "--add-label", args.humanLabel]);
    const after = livePr(args, ops);
    const finalLabels = labelsOf(after);
    const headChanged = String(after.headRefOid || "").toLowerCase() !== args.expectedHead.toLowerCase();
    const managed = [args.reviewLabel, args.reviewingLabel, args.blockedLabel].filter((label) => finalLabels.has(label));
    if (headChanged || !finalLabels.has(args.humanLabel) || managed.length) {
      const rollback = ["gh", "pr", "edit", args.pr, "-R", args.githubRepo, "--remove-label", args.humanLabel];
      for (const label of [args.reviewLabel, args.reviewingLabel]) {
        if (boundaryLabels.has(label) && !finalLabels.has(label)) rollback.push("--add-label", label);
      }
      runChecked(ops, rollback);
      if (headChanged) throw new Error("PR head changed during human handoff; reviewer labels restored");
      if (finalLabels.has(args.blockedLabel)) throw new Error("PR became blocked during human handoff; blocker preserved and reviewer labels restored");
      throw new Error("human handoff labels were not persisted exactly; reviewer labels restored");
    }
    return 0;
  };
  return ops.withLock
    ? ops.withLock(project, operation)
    : withEnabledProjectLock({ repoPath: args.projectRepo, githubRepo: args.githubRepo, stateDir: args.stateDir, enabledAt: args.enabledAt }, operation);
}
function parseArgs(argv: string[]): Args {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("expected flag/value pairs");
    values[flag.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())] = value;
  }
  const enabledAt = Number(values.enabledAt);
  for (const field of ["projectRepo", "githubRepo", "stateDir", "pr", "expectedHead", "reviewPromise", "reviewLabel", "reviewingLabel", "blockedLabel", "humanLabel"]) if (!values[field]) throw new Error(`--${field} is required`);
  if (!Number.isFinite(enabledAt)) throw new Error("--enabled-at is required");
  return { ...values, enabledAt } as Args;
}
function main(): void {
  try { process.exitCode = handoffReviewedPr(parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(`guarded-reviewer-handoff.ts: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }
}
if (require.main === module) main();
module.exports = { assertCurrentHeadVerification, handoffReviewedPr, parseArgs };
