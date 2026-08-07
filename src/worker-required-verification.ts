import type { AttemptRecord, CompletionReportV1 } from "./attempt-lifecycle";
import type { RequiredVerificationContract } from "./required-verification";

export type RequiredVerificationBinding = {
  repository: string;
  targetCommit: string;
  command: string;
  source: RequiredVerificationContract["source"];
  baseRevision: string;
};

export type RequiredVerificationRecord = {
  version: 1;
  binding: RequiredVerificationBinding;
  outcome: "passed" | "failed" | "timed_out" | "interrupted";
  exitCode: number | null;
  terminationReason?: "timeout" | "interrupted" | "runner_failure" | "output_not_clean" | "artifact_restoration_failure" | "signal";
  terminationSignal?: string;
  startedAt: string;
  durationMs: number;
  logPath: string;
  provenance?: { kind: "host_gate_execution"; recordPath: string };
  artifactRestorationFailure?: { message: string; quarantinePath: string };
  restorationFailureRecordPath?: string;
};

type Runtime = {
  WORKER_REQUIRED_VERIFICATION_FILE: string;
  workerRequiredVerificationPath: (attemptRecordFile: string) => string;
  readRequiredVerificationRecord: (file: string) => RequiredVerificationRecord | undefined;
  writeRequiredVerificationRecord: (file: string, record: RequiredVerificationRecord) => void;
  requiredVerificationBinding: (
    contract: RequiredVerificationContract,
    targetCommit: string,
  ) => RequiredVerificationBinding;
  assertCurrentWorkerContract: (
    attempt: AttemptRecord,
    projectRepo: string,
    localConfigPath?: string,
  ) => RequiredVerificationContract;
  assertReviewApprovalAuthorized: (
    attempt: AttemptRecord,
    report: CompletionReportV1,
    record: RequiredVerificationRecord | undefined,
    currentContract: RequiredVerificationContract,
  ) => { reviewedHead: string; record: RequiredVerificationRecord };
  assertWorkerCompletionAuthorized: (
    attempt: AttemptRecord,
    report: CompletionReportV1,
    record: RequiredVerificationRecord | undefined,
    currentContract: RequiredVerificationContract,
  ) => { outputRevision: string; record: RequiredVerificationRecord };
};

const runtime = require("./worker-required-verification-runtime.cjs") as Runtime;

export const WORKER_REQUIRED_VERIFICATION_FILE = runtime.WORKER_REQUIRED_VERIFICATION_FILE;
export const workerRequiredVerificationPath = runtime.workerRequiredVerificationPath;
export const readRequiredVerificationRecord = runtime.readRequiredVerificationRecord;
export const writeRequiredVerificationRecord = runtime.writeRequiredVerificationRecord;
export const requiredVerificationBinding = runtime.requiredVerificationBinding;
export const assertCurrentWorkerContract = runtime.assertCurrentWorkerContract;
export const assertReviewApprovalAuthorized = runtime.assertReviewApprovalAuthorized;
export const assertWorkerCompletionAuthorized = runtime.assertWorkerCompletionAuthorized;
