import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

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
  startedAt: string;
  durationMs: number;
  logPath: string;
};

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function validSha(value: unknown): value is string {
  return nonEmpty(value) && /^[0-9a-f]{40}$/i.test(value);
}

function assertContract(value: unknown): asserts value is RequiredVerificationContract {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("required verification persisted contract is missing");
  }
  const contract = value as Record<string, unknown>;
  if (!nonEmpty(contract.command)) throw new Error("required verification blocked: zero_targets");
  if (!nonEmpty(contract.repository) || !validSha(contract.baseRevision)) {
    throw new Error("required verification persisted contract binding is invalid");
  }
  const source = contract.source;
  if (!source || typeof source !== "object" || Array.isArray(source)
    || !["local", "repo_policy"].includes(String((source as Record<string, unknown>).kind))
    || !nonEmpty((source as Record<string, unknown>).location)) {
    throw new Error("required verification persisted contract source is invalid");
  }
}

export function requiredVerificationBinding(
  contract: RequiredVerificationContract,
  targetCommit: string,
): RequiredVerificationBinding {
  assertContract(contract);
  if (!validSha(targetCommit)) throw new Error("required verification target commit is invalid");
  return {
    repository: contract.repository,
    targetCommit,
    command: contract.command,
    source: contract.source,
    baseRevision: contract.baseRevision,
  };
}

export const WORKER_REQUIRED_VERIFICATION_FILE = "required-verification.json";

export function workerRequiredVerificationPath(attemptRecordFile: string): string {
  return path.join(path.dirname(attemptRecordFile), WORKER_REQUIRED_VERIFICATION_FILE);
}

export function readRequiredVerificationRecord(file: string): RequiredVerificationRecord | undefined {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as RequiredVerificationRecord; }
  catch { return undefined; }
}

export function writeRequiredVerificationRecord(file: string, record: RequiredVerificationRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function git(repoPath: string, args: string[]): string {
  const result = childProcess.spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || "git command failed").trim());
  return String(result.stdout || "").trim();
}

/** Re-observes the trusted source instead of adopting a new contract mid-attempt. */
export function assertCurrentWorkerContract(
  attempt: AttemptRecord,
  projectRepo: string,
): RequiredVerificationContract {
  assertContract(attempt.requiredVerification);
  const contract = attempt.requiredVerification;
  const baseBranch = attempt.baseBranch || "origin/main";
  const currentBase = git(projectRepo, ["rev-parse", "--verify", `${baseBranch}^{commit}`]);
  if (currentBase.toLowerCase() !== contract.baseRevision.toLowerCase()) {
    throw new Error("required verification blocked: stale_policy; trusted base revision changed");
  }
  if (contract.source.kind === "repo_policy") {
    const policyText = git(projectRepo, ["show", `${contract.baseRevision}:${contract.source.location}`]);
    let policy: unknown;
    try { policy = JSON.parse(policyText); } catch { throw new Error("required verification blocked: stale_policy; trusted policy is malformed"); }
    const command = policy && typeof policy === "object" && !Array.isArray(policy)
      ? (policy as Record<string, unknown>).checkCommand
      : undefined;
    if (command !== contract.command) throw new Error("required verification blocked: stale_policy; trusted policy changed");
  } else {
    const configPath = contract.source.location.split("#", 1)[0];
    let config: unknown;
    try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); }
    catch { throw new Error("required verification blocked: stale_policy; local policy is unavailable"); }
    const projects = config && typeof config === "object" && Array.isArray((config as { projects?: unknown }).projects)
      ? (config as { projects: Array<Record<string, unknown>> }).projects
      : [];
    const selected = projects.find((project) => project.id === attempt.project || project.githubRepo === attempt.repository);
    if (selected?.checkCommand !== contract.command) throw new Error("required verification blocked: stale_policy; local policy changed");
  }
  return contract;
}

export function assertWorkerCompletionAuthorized(
  attempt: AttemptRecord,
  report: CompletionReportV1,
  record: RequiredVerificationRecord | undefined,
  currentContract: RequiredVerificationContract,
): { outputRevision: string; record: RequiredVerificationRecord } {
  if (attempt.role !== "worker" || report.role !== "worker" || report.status !== "complete") {
    throw new Error("Worker completion gate requires a complete Worker report");
  }
  assertContract(attempt.requiredVerification);
  assertContract(currentContract);
  if (!isDeepStrictEqual(attempt.requiredVerification, currentContract)) {
    throw new Error("required verification blocked: stale_policy; start a new attempt");
  }
  if (attempt.requiredVerification.repository !== attempt.repository) {
    throw new Error("required verification persisted contract repository does not match attempt");
  }
  if (!record || record.version !== 1) throw new Error("required verification passed record is missing");
  if (record.outcome !== "passed" || record.exitCode !== 0) {
    throw new Error("required verification record did not pass");
  }
  const expected = requiredVerificationBinding(attempt.requiredVerification, report.result.outputRevision);
  if (!isDeepStrictEqual(record.binding, expected)) {
    throw new Error("required verification record does not match the Worker output commit and fixed contract");
  }
  return { outputRevision: report.result.outputRevision, record };
}
