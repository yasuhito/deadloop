// Shared required-verification capability for mutation finalizers.
// A finalizer may reuse only an exact authenticated passed record; every other
// record shape is diagnostic evidence and causes the fixed contract to run.

const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { isDeepStrictEqual } = require("node:util") as typeof import("node:util");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");
const { hasUncommittedWork, UNCOMMITTED_WORK_STATUS_ARGS } = require("../../../src/agent-scratch-area.cjs");
const { writeVerificationLog } = require("./run-worker-required-verification.ts");
const {
  assertCurrentWorkerContract,
  assertRequiredVerificationAuthorized,
  persistHostVerificationEvidence,
  readRequiredVerificationRecord,
  requiredVerificationBinding,
  workerRequiredVerificationPath,
} = require("../../../src/worker-required-verification-runtime.cjs");

type JsonObject = Record<string, any>;
type Input = {
  attempt: JsonObject;
  currentContract: JsonObject;
  targetCommit: string;
  record: JsonObject | undefined;
};
type Operations = {
  execute: () => JsonObject;
  validate?: (record: JsonObject) => void;
  persist: (record: JsonObject) => JsonObject;
  authenticate: (record: JsonObject) => void;
};

const FINALIZER_ROLES = new Set(["review-repair", "branch-update"]);

function isExactPassedRecord(input: Input, record: JsonObject | undefined): boolean {
  return Boolean(
    record
    && record.version === 1
    && record.outcome === "passed"
    && record.exitCode === 0
    && typeof record.startedAt === "string"
    && record.startedAt.length > 0
    && Number.isFinite(record.durationMs)
    && record.durationMs >= 0
    && typeof record.logPath === "string"
    && record.logPath.length > 0
    && isDeepStrictEqual(record.binding, requiredVerificationBinding(input.currentContract, input.targetCommit)),
  );
}

function assertFixedContract(input: Input): void {
  if (!FINALIZER_ROLES.has(input.attempt.role)) throw new Error("required verification finalizer role is invalid");
  if (!isDeepStrictEqual(input.attempt.requiredVerification, input.currentContract)) {
    throw new Error("required verification blocked: stale_policy; start a new attempt");
  }
  if (input.currentContract.repository !== input.attempt.repository) {
    throw new Error("required verification persisted contract repository does not match attempt");
  }
}

function ensureRequiredVerificationRecord(input: Input, operations: Operations): JsonObject {
  assertFixedContract(input);
  if (isExactPassedRecord(input, input.record)) {
    try {
      operations.authenticate(input.record as JsonObject);
      return { record: input.record, reused: true };
    } catch {}
  }
  const executed = operations.execute();
  try {
    operations.validate?.(executed);
  } catch (error) {
    const failed = { ...executed, outcome: "failed", postCheckFailure: error instanceof Error ? error.message : String(error) };
    operations.persist(failed);
    throw error;
  }
  const persisted = operations.persist(executed);
  if (!isExactPassedRecord(input, persisted)) throw new Error("required verification execution did not produce a matching passed record");
  operations.authenticate(persisted);
  return { record: persisted, reused: false };
}

type FinalizerArgs = {
  attemptRecord: string;
  projectId: string;
  projectRepo: string;
  githubRepo: string;
  repo: string;
  branch: string;
  stateDir: string;
  automationDir: string;
};
type FinalizerIdentityArgs = Omit<FinalizerArgs, "automationDir">;
type CommandResult = { status: number | null; stdout: string; stderr: string; signal?: NodeJS.Signals | null; timedOut?: boolean };

const FINALIZER_VERIFICATION_TIMEOUT_MS = 10 * 60_000;
const FINALIZER_VERIFICATION_SUBPROCESS_TIMEOUT_MS = FINALIZER_VERIFICATION_TIMEOUT_MS + 25_000;

type StructuredCheckResult = {
  version: 1;
  code: number | null;
  timedOut: boolean;
  interrupted: boolean;
  signal: string | null;
  restorationFailure?: boolean;
};

function readStructuredCheckResult(file: string): StructuredCheckResult | undefined {
  let value: Partial<StructuredCheckResult>;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (value?.version !== 1 || typeof value.timedOut !== "boolean" || typeof value.interrupted !== "boolean") return undefined;
  return value as StructuredCheckResult;
}

function verificationRecordForResult(
  input: Input,
  targetCommit: string,
  result: CommandResult,
  started: number,
  logPath: string,
  structured?: StructuredCheckResult,
): JsonObject {
  // The structured channel is authoritative: a configured check that merely
  // exits 124 or 130 stays an ordinary failed command with its real exit code.
  // Without a structured result the executor never completed, so the wrapper
  // process outcome (timeout kill, signal kill) is the only trusted evidence.
  const timedOut = structured ? structured.timedOut : result.timedOut === true;
  const interrupted = structured
    ? structured.interrupted
    : result.status === null && (result.signal === "SIGINT" || result.signal === "SIGTERM");
  const restorationFailed = structured?.restorationFailure === true;
  const code = structured ? structured.code : result.status;
  const outcome = timedOut
    ? "timed_out"
    : interrupted
      ? "interrupted"
      : structured && !restorationFailed && code === 0
        ? "passed"
        : "failed";
  const signal = structured ? structured.signal : result.signal;
  const terminationReason = timedOut ? "timeout" : interrupted ? "interrupted" : signal ? "signal" : undefined;
  return {
    version: 1,
    binding: requiredVerificationBinding(input.currentContract, targetCommit),
    outcome,
    exitCode: timedOut || interrupted || !structured || code === null ? null : code,
    ...(terminationReason ? { terminationReason } : {}),
    ...(signal ? { terminationSignal: signal } : {}),
    ...(restorationFailed ? { restorationFailure: true } : {}),
    startedAt: new Date(started).toISOString(),
    durationMs: Math.max(0, Date.now() - started),
    logPath,
  };
}

function finalizerVerificationInput(
  args: FinalizerIdentityArgs,
  role: "review-repair" | "branch-update",
  targetCommit: string,
  repositoryId: string,
): { input: Input; recordFile: string } {
  const location = canonicalAttemptLocation({ attemptRecord: args.attemptRecord, stateDir: args.stateDir });
  const attempt = readAttemptRecord(location.runDir);
  if (attempt.role !== role || attempt.project !== args.projectId || attempt.repository !== args.githubRepo) {
    throw new Error("required verification attempt identity does not match finalizer");
  }
  if (attempt.branch !== args.branch || path.resolve(attempt.worktreePath) !== path.resolve(args.repo)) {
    throw new Error("required verification attempt source does not match finalizer");
  }
  const configFile = process.env.DEADLOOP_CONFIG || path.join(args.stateDir, "projects.json");
  const currentContract = assertCurrentWorkerContract(attempt, args.projectRepo, configFile, repositoryId);
  const recordFile = workerRequiredVerificationPath(args.attemptRecord);
  return { input: { attempt, currentContract, targetCommit, record: readRequiredVerificationRecord(recordFile) }, recordFile };
}

function authorizeFinalizerRequiredVerification(
  args: FinalizerIdentityArgs,
  role: "review-repair" | "branch-update",
  targetCommit: string,
  repositoryId: string,
): JsonObject {
  const { input } = finalizerVerificationInput(args, role, targetCommit, repositoryId);
  assertFixedContract(input);
  return assertRequiredVerificationAuthorized(input.attempt, targetCommit, input.record, input.currentContract, [role]);
}

function ensureFinalizerRequiredVerification(
  args: FinalizerArgs,
  role: "review-repair" | "branch-update",
  targetCommit: string,
  repositoryId: string,
  run: (args: string[], timeoutMs?: number) => CommandResult,
): JsonObject {
  const location = canonicalAttemptLocation({ attemptRecord: args.attemptRecord, stateDir: args.stateDir });
  const { input, recordFile } = finalizerVerificationInput(args, role, targetCommit, repositoryId);
  const authenticate = (record: JsonObject) => {
    assertRequiredVerificationAuthorized(input.attempt, targetCommit, record, input.currentContract, [role]);
  };
  return ensureRequiredVerificationRecord(input, {
    authenticate,
    execute: () => {
      const started = Date.now();
      const structuredResultPath = path.join(location.runDir, "required-verification-check-result.json");
      fs.rmSync(structuredResultPath, { force: true });
      const result = run([
        "node",
        path.join(args.automationDir, "run-project-check.ts"),
        "--cwd",
        args.repo,
        "--timeout-ms",
        String(FINALIZER_VERIFICATION_TIMEOUT_MS),
        "--command",
        input.currentContract.command,
        "--quarantine-root",
        path.join(args.stateDir, "check-quarantine"),
        "--structured-result",
        structuredResultPath,
      ], FINALIZER_VERIFICATION_SUBPROCESS_TIMEOUT_MS);
      const logPath = path.join(location.runDir, "required-verification.log");
      writeVerificationLog(logPath, `${result.stdout || ""}${result.stderr || ""}`);
      const record = verificationRecordForResult(input, targetCommit, result, started, logPath, readStructuredCheckResult(structuredResultPath));
      if (record.outcome !== "passed") {
        persistHostVerificationEvidence(recordFile, record);
        throw new Error(`required verification ${record.outcome}; log: ${logPath}`);
      }
      return record;
    },
    validate: () => {
      const status = run(["git", "-C", args.repo, ...UNCOMMITTED_WORK_STATUS_ARGS]);
      if (status.status !== 0 || hasUncommittedWork(status.stdout)) {
        throw new Error("required verification post-check failed: worktree is dirty after checks");
      }
      const head = run(["git", "-C", args.repo, "rev-parse", "HEAD"]);
      if (head.status !== 0 || head.stdout.trim().toLowerCase() !== targetCommit.toLowerCase()) {
        throw new Error("required verification post-check failed: HEAD changed during checks");
      }
      const current = finalizerVerificationInput(args, role, targetCommit, repositoryId).input;
      assertFixedContract(current);
      if (!isDeepStrictEqual(current.currentContract, input.currentContract)) {
        throw new Error("required verification post-check failed: contract changed during checks");
      }
    },
    persist: (record: JsonObject) => persistHostVerificationEvidence(recordFile, record),
  });
}

module.exports = { authorizeFinalizerRequiredVerification, ensureFinalizerRequiredVerification, ensureRequiredVerificationRecord, isExactPassedRecord, verificationRecordForResult };
