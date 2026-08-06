import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { RequiredVerificationContract, RequiredVerificationResolution } from "./required-verification";

const ENABLEMENT_VERIFICATION_TIMEOUT_MS = 10 * 60_000;

const { runProjectCheck } = require("./project-check.ts") as {
  runProjectCheck: (input: {
    cwd: string;
    command: string;
    quarantineRoot: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }) => Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    interrupted: boolean;
    signal: NodeJS.Signals | null;
  }>;
};

type EnablementVerificationJournal = {
  version: 1;
  attemptId: string;
  state: "prepared" | "created" | "checked" | "cleaned" | "retained" | "creation_failed";
  repository: string;
  primaryRepoPath: string;
  worktreePath: string;
  targetRevision: string;
  contract: RequiredVerificationContract;
  createdAt: string;
  recordPath?: string;
  logPath?: string;
  retentionReason?: string;
};

export type EnablementVerificationResult = {
  outcome: "passed" | "failed" | "timed_out" | "interrupted";
  exitCode: number | null;
  journalPath: string;
  logPath: string;
  recordPath: string;
  cleanup: "removed" | "retained";
  reused: boolean;
};

export type RetainedEnablementVerification = {
  attemptId: string;
  repository: string;
  primaryRepoPath: string;
  worktreePath: string;
  targetRevision: string;
  journalPath: string;
  recordPath?: string;
  logPath?: string;
  retentionReason: string;
};

export type EnablementVerificationInput = {
  stateDir: string;
  primaryRepoPath: string;
  repository: string;
  resolution: RequiredVerificationResolution;
  beforeWorktreeCreate?: (journalPath: string) => Promise<void> | void;
  now?: () => number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

function verificationRoot(stateDir: string): string {
  return path.join(stateDir, "required-verification", "enablement");
}

function readJson(file: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function attemptDirectories(stateDir: string): string[] {
  const root = verificationRoot(stateDir);
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function bindingFor(contract: RequiredVerificationContract) {
  return {
    repository: contract.repository,
    targetCommit: contract.baseRevision,
    command: contract.command,
    source: contract.source,
    baseRevision: contract.baseRevision,
    ...(contract.override ? { override: contract.override } : {}),
  };
}

function reusableSuccess(
  stateDir: string,
  contract: RequiredVerificationContract,
): EnablementVerificationResult | undefined {
  const expected = bindingFor(contract);
  const candidates = attemptDirectories(stateDir)
    .map((directory) => ({ directory, record: readJson(path.join(directory, "record.json")) }))
    .filter(({ record }) => record?.version === 1 && record.outcome === "passed")
    .sort((left, right) => String(right.record.startedAt || "").localeCompare(String(left.record.startedAt || "")));

  for (const { directory, record } of candidates) {
    const actual = record.binding || {
      repository: record.repository,
      targetCommit: record.targetCommit,
      command: record.contract?.command,
      source: record.contract?.source,
      baseRevision: record.contract?.baseRevision,
      ...(record.contract?.override ? { override: record.contract.override } : {}),
    };
    if (!isDeepStrictEqual(actual, expected)) continue;
    if (
      record.attemptId !== path.basename(directory) || record.exitCode !== 0 || record.timedOut !== false
      || record.terminationReason !== undefined || typeof record.startedAt !== "string"
      || !Number.isFinite(record.durationMs) || record.durationMs < 0
    ) continue;
    const logPath = record.logPath;
    if (logPath !== path.join(directory, "check.log") || !fs.existsSync(logPath)) continue;
    const journalPath = path.join(directory, "journal.json");
    const journal = readJson(journalPath);
    if (!journal || !["cleaned", "retained"].includes(journal.state)) continue;
    return {
      outcome: "passed",
      exitCode: 0,
      journalPath,
      logPath,
      recordPath: path.join(directory, "record.json"),
      cleanup: journal?.state === "cleaned" ? "removed" : "retained",
      reused: true,
    };
  }
  return undefined;
}

export function inspectRetainedEnablementVerifications(
  stateDir: string,
  primaryRepoPath?: string,
): RetainedEnablementVerification[] {
  const expectedPath = primaryRepoPath ? path.resolve(primaryRepoPath) : undefined;
  const findings: RetainedEnablementVerification[] = [];
  for (const directory of attemptDirectories(stateDir)) {
    const journalPath = path.join(directory, "journal.json");
    const journal = readJson(journalPath);
    if (journal?.version !== 1 || !["prepared", "created", "checked", "retained"].includes(journal.state)) continue;
    if (typeof journal.primaryRepoPath !== "string" || (expectedPath && path.resolve(journal.primaryRepoPath) !== expectedPath)) continue;
    if (typeof journal.worktreePath !== "string" || (!fs.existsSync(journal.worktreePath) && journal.state !== "retained")) continue;
    findings.push({
      attemptId: String(journal.attemptId || path.basename(directory)),
      repository: String(journal.repository || "unknown"),
      primaryRepoPath: journal.primaryRepoPath,
      worktreePath: journal.worktreePath,
      targetRevision: String(journal.targetRevision || "unknown"),
      journalPath,
      ...(typeof journal.recordPath === "string" ? { recordPath: journal.recordPath } : {}),
      ...(typeof journal.logPath === "string" ? { logPath: journal.logPath } : {}),
      retentionReason: String(journal.retentionReason || `cleanup result is unknown after journal state ${journal.state}`),
    });
  }
  return findings.sort((left, right) => left.attemptId.localeCompare(right.attemptId));
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

function git(repoPath: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = childProcess.spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || result.error?.message || ""),
  };
}

function exactRegisteredWorktree(primaryRepoPath: string, worktreePath: string): boolean {
  const listed = git(primaryRepoPath, ["worktree", "list", "--porcelain"]);
  if (listed.status !== 0) return false;
  const expected = path.resolve(worktreePath);
  return listed.stdout
    .split(/\n\n+/)
    .map((entry) => entry.match(/^worktree (.+)$/m)?.[1])
    .filter(Boolean)
    .some((entry) => path.resolve(entry!) === expected);
}

function safeToRemove(journal: EnablementVerificationJournal): { safe: boolean; reason?: string } {
  if (!fs.existsSync(journal.worktreePath)) return { safe: false, reason: "owned worktree path is missing" };
  if (!exactRegisteredWorktree(journal.primaryRepoPath, journal.worktreePath)) {
    return { safe: false, reason: "worktree registration does not prove ownership" };
  }
  const head = git(journal.worktreePath, ["rev-parse", "HEAD"]);
  if (head.status !== 0 || head.stdout.trim() !== journal.targetRevision) {
    return { safe: false, reason: "worktree revision changed" };
  }
  const status = git(journal.worktreePath, ["status", "--porcelain", "--untracked-files=all", "--ignored"]);
  if (status.status !== 0 || status.stdout.trim()) return { safe: false, reason: "worktree is not clean" };
  return { safe: true };
}

function cleanupOwnedWorktree(journal: EnablementVerificationJournal): { cleanup: "removed" | "retained"; reason?: string } {
  const safety = safeToRemove(journal);
  if (!safety.safe) return { cleanup: "retained", reason: safety.reason };
  const removed = git(journal.primaryRepoPath, ["worktree", "remove", journal.worktreePath]);
  if (removed.status !== 0 || fs.existsSync(journal.worktreePath)) {
    return { cleanup: "retained", reason: (removed.stderr || removed.stdout || "worktree removal was not confirmed").trim() };
  }
  return { cleanup: "removed" };
}

export async function runEnablementVerification(input: EnablementVerificationInput): Promise<EnablementVerificationResult> {
  if (input.resolution.status !== "resolved") {
    throw new Error(`required verification blocked: ${input.resolution.reason}`);
  }
  const contract = input.resolution.contract;
  if (contract.repository !== input.repository) throw new Error("required verification repository binding does not match enablement identity");
  const reused = reusableSuccess(input.stateDir, contract);
  if (reused) return reused;

  const attemptId = crypto.randomUUID();
  const attemptDir = path.join(verificationRoot(input.stateDir), attemptId);
  const worktreePath = path.join(input.stateDir, "required-verification", "worktrees", attemptId);
  const journalPath = path.join(attemptDir, "journal.json");
  const logPath = path.join(attemptDir, "check.log");
  const recordPath = path.join(attemptDir, "record.json");
  const now = input.now || Date.now;
  const timeoutMs = input.timeoutMs ?? ENABLEMENT_VERIFICATION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("enablement verification timeout must be positive");
  const startedAtMs = now();
  let journal: EnablementVerificationJournal = {
    version: 1,
    attemptId,
    state: "prepared",
    repository: input.repository,
    primaryRepoPath: path.resolve(input.primaryRepoPath),
    worktreePath,
    targetRevision: contract.baseRevision,
    contract,
    createdAt: new Date(startedAtMs).toISOString(),
  };
  writeJson(journalPath, journal);
  await input.beforeWorktreeCreate?.(journalPath);

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const added = git(input.primaryRepoPath, ["worktree", "add", "--detach", worktreePath, contract.baseRevision]);
  if (added.status !== 0) {
    journal = { ...journal, state: "creation_failed", logPath };
    fs.writeFileSync(logPath, `${added.stdout}${added.stderr}`, { encoding: "utf8", mode: 0o600 });
    writeJson(journalPath, journal);
    throw new Error(`required verification worktree creation failed; log: ${logPath}`);
  }
  journal = { ...journal, state: "created" };
  writeJson(journalPath, journal);
  const checkedHead = git(worktreePath, ["rev-parse", "HEAD"]);
  if (checkedHead.status !== 0 || checkedHead.stdout.trim() !== contract.baseRevision) {
    const reason = "created worktree does not match the trusted base revision";
    fs.writeFileSync(logPath, `${reason}\n${checkedHead.stdout}${checkedHead.stderr}`, { encoding: "utf8", mode: 0o600 });
    journal = { ...journal, state: "retained", logPath, retentionReason: reason };
    writeJson(journalPath, journal);
    throw new Error(`required verification worktree revision mismatch; log: ${logPath}; retained worktree journal: ${journalPath}`);
  }

  let check: {
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    interrupted: boolean;
    signal: NodeJS.Signals | null;
  };
  let runnerFailed = false;
  try {
    const remainingMs = Math.max(1, timeoutMs - Math.max(0, now() - startedAtMs));
    check = await runProjectCheck({
      cwd: worktreePath,
      command: contract.command,
      quarantineRoot: path.join(input.stateDir, "check-quarantine"),
      timeoutMs: remainingMs,
      signal: input.signal,
    });
  } catch (error) {
    runnerFailed = true;
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    check = {
      code: null,
      stdout: "",
      stderr: `required verification runner failed: ${message}\n`,
      timedOut: false,
      interrupted: false,
      signal: null,
    };
  }
  const finishedAtMs = now();
  const terminationEvidence = check.timedOut
    ? `required verification timed out after ${timeoutMs}ms\n`
    : check.interrupted ? "required verification was interrupted\n" : "";
  fs.writeFileSync(logPath, `${check.stdout}${check.stderr}${terminationEvidence}`, { encoding: "utf8", mode: 0o600 });
  const outcome: EnablementVerificationResult["outcome"] = check.timedOut
    ? "timed_out"
    : check.interrupted ? "interrupted" : check.code === 0 ? "passed" : "failed";
  const terminationReason = check.timedOut
    ? "timeout"
    : check.interrupted
      ? "interrupted"
      : runnerFailed
        ? "runner_failure"
        : check.signal
          ? "signal"
          : undefined;
  const exitCode = terminationReason ? null : check.code;
  writeJson(recordPath, {
    version: 1,
    attemptId,
    binding: bindingFor(contract),
    repository: input.repository,
    targetCommit: contract.baseRevision,
    contract,
    outcome,
    exitCode,
    terminationReason,
    ...(check.signal ? { terminationSignal: check.signal } : {}),
    timedOut: check.timedOut,
    timeoutMs,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    logPath,
  });
  journal = { ...journal, state: "checked", recordPath, logPath };
  writeJson(journalPath, journal);

  const cleanup = cleanupOwnedWorktree(journal);
  journal = cleanup.cleanup === "removed"
    ? { ...journal, state: "cleaned" }
    : { ...journal, state: "retained", retentionReason: cleanup.reason || "cleanup was not proven safe" };
  writeJson(journalPath, journal);

  return { outcome, exitCode, journalPath, logPath, recordPath, cleanup: cleanup.cleanup, reused: false };
}
