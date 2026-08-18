// Shared required-verification capability for mutation finalizers.
// A finalizer may reuse only an exact authenticated passed record; every other
// record shape is diagnostic evidence and causes the fixed contract to run.

const { spawn } = require("node:child_process") as typeof import("node:child_process");
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
  execute: () => Promise<JsonObject>;
  validate?: (record: JsonObject) => void;
  persist: (record: JsonObject) => Promise<JsonObject>;
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

async function ensureRequiredVerificationRecord(input: Input, operations: Operations): Promise<JsonObject> {
  assertFixedContract(input);
  if (isExactPassedRecord(input, input.record)) {
    try {
      operations.authenticate(input.record as JsonObject);
      return { record: input.record, reused: true };
    } catch {}
  }
  const executed = await operations.execute();
  try {
    operations.validate?.(executed);
  } catch (error) {
    const failed = { ...executed, outcome: "failed", postCheckFailure: error instanceof Error ? error.message : String(error) };
    await operations.persist(failed);
    throw error;
  }
  const persisted = await operations.persist(executed);
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

type FinalizerSignal = "SIGINT" | "SIGTERM";
const FINALIZER_SIGNALS: readonly FinalizerSignal[] = ["SIGINT", "SIGTERM"];

type CheckProcess = {
  kill: (signal: FinalizerSignal) => void;
  exited: Promise<CommandResult>;
};

type CheckProcessOps = {
  start: (args: string[], timeoutMs: number) => CheckProcess;
  on: (signal: FinalizerSignal, handler: () => void) => void;
  off: (signal: FinalizerSignal, handler: () => void) => void;
};

function startCheckProcess(args: string[], timeoutMs: number): CheckProcess {
  const child = spawn(args[0], args.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  const exited = new Promise<CommandResult>((resolve) => {
    const settle = (status: number | null, signal: NodeJS.Signals | null, failure?: Error) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr: failure ? `${stderr}${failure.message}\n` : stderr, signal, timedOut });
    };
    child.once("error", (failure: Error) => settle(null, null, failure));
    child.once("close", (status: number | null, signal: NodeJS.Signals | null) => settle(status, signal));
  });
  return { kill: (signal) => { child.kill(signal); }, exited };
}

function defaultCheckProcessOps(): CheckProcessOps {
  return {
    start: startCheckProcess,
    on: (signal, handler) => { process.on(signal, handler); },
    off: (signal, handler) => { process.removeListener(signal, handler); },
  };
}

type FinalizerInterruption = {
  runCheck: (args: string[], timeoutMs: number) => Promise<CommandResult>;
  observe: () => Promise<FinalizerSignal | null>;
};

/**
 * Hold SIGINT and SIGTERM for the whole verification, from before the checker starts until the
 * typed record is durable.
 *
 * Installing the handlers replaces the default termination, so a signal can no longer kill the
 * finalizer between the checker's exit and the persisted evidence. Node dispatches a handler only
 * when the event loop turns, and the post-check runs synchronous children, so a signal delivered
 * there stays pending: `observe` turns the loop before reporting, and every decision that could
 * authorize a push is taken after that report.
 */
async function withFinalizerInterruption<T>(
  ops: CheckProcessOps,
  verify: (interruption: FinalizerInterruption) => Promise<T>,
): Promise<T> {
  let signalled: FinalizerSignal | null = null;
  let running: CheckProcess | null = null;
  const handlers = FINALIZER_SIGNALS.map((signal) => {
    const handler = () => {
      signalled ||= signal;
      running?.kill(signal);
    };
    ops.on(signal, handler);
    return { signal, handler };
  });
  try {
    return await verify({
      runCheck: async (args, timeoutMs) => {
        running = ops.start(args, timeoutMs);
        // A signal seen while the checker was starting had no child to reach; deliver it now.
        if (signalled) running.kill(signalled);
        try {
          return await running.exited;
        } finally {
          running = null;
        }
      },
      observe: async () => {
        await new Promise((resolve) => { setImmediate(resolve); });
        return signalled;
      },
    });
  } finally {
    for (const { signal, handler } of handlers) ops.off(signal, handler);
  }
}

/**
 * A signaled finalizer discards the checker's own verdict.
 *
 * The checks may well have finished while this process was already terminating; what deadloop can
 * prove is the interruption, so the record must say interrupted rather than reuse a passed exit.
 */
function finalizerResultForSignal(result: CommandResult, signalled: FinalizerSignal | null): CommandResult {
  return signalled ? { ...result, status: null, signal: signalled } : result;
}

/**
 * The evidence for a run that was signaled before its record became durable.
 *
 * A post-check or a persistence step reached while this process was already terminating proves
 * nothing about the target, so the stored outcome is the interruption rather than the verdict.
 */
function interruptedVerificationRecord(record: JsonObject, signalled: FinalizerSignal): JsonObject {
  return {
    ...record,
    outcome: "interrupted",
    exitCode: null,
    terminationReason: "interrupted",
    terminationSignal: signalled,
  };
}

function ensureFinalizerRequiredVerification(
  args: FinalizerArgs,
  role: "review-repair" | "branch-update",
  targetCommit: string,
  repositoryId: string,
  run: (args: string[], timeoutMs?: number) => CommandResult,
  checkOps: CheckProcessOps = defaultCheckProcessOps(),
): Promise<JsonObject> {
  return withFinalizerInterruption(checkOps, async (interruption) => {
    const location = canonicalAttemptLocation({ attemptRecord: args.attemptRecord, stateDir: args.stateDir });
    const { input, recordFile } = finalizerVerificationInput(args, role, targetCommit, repositoryId);
    const authenticate = (record: JsonObject) => {
      assertRequiredVerificationAuthorized(input.attempt, targetCommit, record, input.currentContract, [role]);
    };
    /**
     * Persist this attempt's evidence.
     *
     * Every write goes through here, so a signal observed anywhere up to the durable record turns
     * the stored outcome into an interruption; an interrupted run can never authorize a push, so
     * persisting one also stops the finalizer.
     */
    const persistEvidence = async (record: JsonObject) => {
      const signalled = await interruption.observe();
      if (!signalled) return persistHostVerificationEvidence(recordFile, record);
      const interrupted = persistHostVerificationEvidence(recordFile, interruptedVerificationRecord(record, signalled));
      throw new Error(`required verification ${interrupted.outcome}; log: ${interrupted.logPath}`);
    };
    const verification = await ensureRequiredVerificationRecord(input, {
      authenticate,
      execute: async () => {
        const started = Date.now();
        const structuredResultPath = path.join(location.runDir, "required-verification-check-result.json");
        fs.rmSync(structuredResultPath, { force: true });
        const result = await interruption.runCheck([
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
        const signalled = await interruption.observe();
        const logPath = path.join(location.runDir, "required-verification.log");
        writeVerificationLog(logPath, `${result.stdout || ""}${result.stderr || ""}`);
        const record = verificationRecordForResult(
          input,
          targetCommit,
          finalizerResultForSignal(result, signalled),
          started,
          logPath,
          signalled ? undefined : readStructuredCheckResult(structuredResultPath),
        );
        if (record.outcome !== "passed") {
          await persistEvidence(record);
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
      persist: persistEvidence,
    });
    // The record is durable and authenticated by now; a signal seen in that last window still means
    // this finalizer is terminating, so persisting the interruption stops it instead of pushing.
    if (await interruption.observe()) await persistEvidence(verification.record);
    return verification;
  });
}

module.exports = {
  authorizeFinalizerRequiredVerification,
  ensureFinalizerRequiredVerification,
  finalizerResultForSignal,
  ensureRequiredVerificationRecord,
  withFinalizerInterruption,
  isExactPassedRecord,
  verificationRecordForResult,
};
