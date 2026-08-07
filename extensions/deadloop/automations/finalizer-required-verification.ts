// Shared required-verification capability for mutation finalizers.
// A finalizer may reuse only an exact authenticated passed record; every other
// record shape is diagnostic evidence and causes the fixed contract to run.

const path = require("node:path") as typeof import("node:path");
const { isDeepStrictEqual } = require("node:util") as typeof import("node:util");
const { readAttemptRecord } = require("../../../src/attempt-lifecycle-runtime.cjs");
const { canonicalAttemptLocation } = require("../../../src/attempt-project-confinement.cjs");
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
  const persisted = operations.persist(operations.execute());
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
type CommandResult = { status: number; stdout: string; stderr: string };

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
      const result = run([
        "node",
        path.join(args.automationDir, "run-project-check.ts"),
        "--cwd",
        args.repo,
        "--command",
        input.currentContract.command,
        "--quarantine-root",
        path.join(args.stateDir, "check-quarantine"),
      ]);
      const logPath = path.join(location.runDir, "required-verification.log");
      writeVerificationLog(logPath, `${result.stdout || ""}${result.stderr || ""}`);
      const record = {
        version: 1,
        binding: requiredVerificationBinding(input.currentContract, targetCommit),
        outcome: result.status === 0 ? "passed" : "failed",
        exitCode: result.status,
        startedAt: new Date(started).toISOString(),
        durationMs: Math.max(0, Date.now() - started),
        logPath,
      };
      if (result.status !== 0) {
        persistHostVerificationEvidence(recordFile, record);
        throw new Error(`required verification failed; log: ${logPath}`);
      }
      return record;
    },
    persist: (record: JsonObject) => persistHostVerificationEvidence(recordFile, record),
  });
}

module.exports = { authorizeFinalizerRequiredVerification, ensureFinalizerRequiredVerification, ensureRequiredVerificationRecord, isExactPassedRecord };
