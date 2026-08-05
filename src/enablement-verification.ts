import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RequiredVerificationContract, RequiredVerificationResolution } from "./required-verification";

const { runProjectCheck } = require("./project-check.ts") as {
  runProjectCheck: (input: {
    cwd: string;
    command: string;
    quarantineRoot: string;
  }) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;
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
  outcome: "passed" | "failed";
  exitCode: number;
  journalPath: string;
  logPath: string;
  recordPath: string;
  cleanup: "removed" | "retained";
};

export type EnablementVerificationInput = {
  stateDir: string;
  primaryRepoPath: string;
  repository: string;
  resolution: RequiredVerificationResolution;
  beforeWorktreeCreate?: (journalPath: string) => Promise<void> | void;
  now?: () => number;
};

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

  const attemptId = crypto.randomUUID();
  const attemptDir = path.join(input.stateDir, "required-verification", "enablement", attemptId);
  const worktreePath = path.join(input.stateDir, "required-verification", "worktrees", attemptId);
  const journalPath = path.join(attemptDir, "journal.json");
  const logPath = path.join(attemptDir, "check.log");
  const recordPath = path.join(attemptDir, "record.json");
  const now = input.now || Date.now;
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

  let check: { code: number; stdout: string; stderr: string; timedOut: boolean };
  try {
    check = await runProjectCheck({
      cwd: worktreePath,
      command: contract.command,
      quarantineRoot: path.join(input.stateDir, "check-quarantine"),
    });
  } catch (error) {
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    check = { code: 1, stdout: "", stderr: `required verification runner failed: ${message}\n`, timedOut: false };
  }
  const finishedAtMs = now();
  fs.writeFileSync(logPath, `${check.stdout}${check.stderr}`, { encoding: "utf8", mode: 0o600 });
  const outcome = check.code === 0 ? "passed" : "failed";
  writeJson(recordPath, {
    version: 1,
    attemptId,
    repository: input.repository,
    targetCommit: contract.baseRevision,
    contract,
    outcome,
    exitCode: check.code,
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

  return { outcome, exitCode: check.code, journalPath, logPath, recordPath, cleanup: cleanup.cleanup };
}
