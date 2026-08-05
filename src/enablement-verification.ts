import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RequiredVerificationContract, RequiredVerificationResolution } from "./required-verification";

const ENABLEMENT_VERIFICATION_TIMEOUT_MS = 10 * 60_000;

const { runProjectCheck } = require("./project-check.ts") as {
  runProjectCheck: (input: {
    cwd: string;
    command: string;
    quarantineRoot: string;
    timeoutMs: number;
  }) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>;
};

type DependencyPreparation = {
  strategy: "npm-ci-ignore-scripts";
  command: string;
  artifactPath: string;
  state: "planned" | "installed" | "failed";
  cleanup?: "removed" | "absent" | "failed";
  cleanupReason?: string;
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
  dependencyPreparation?: DependencyPreparation;
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
  timeoutMs?: number;
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

function needsNpmDependencies(command: string): boolean {
  return /^\s*npm\s+run(?:\s|$)/.test(command);
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

function cleanupDependencyPreparation(journal: EnablementVerificationJournal): DependencyPreparation | undefined {
  const preparation = journal.dependencyPreparation;
  if (!preparation) return undefined;
  if (preparation.cleanup) return preparation;
  if (!fs.existsSync(preparation.artifactPath)) return { ...preparation, cleanup: "absent" };
  const expected = path.join(journal.worktreePath, "node_modules");
  if (path.resolve(preparation.artifactPath) !== path.resolve(expected)) {
    return { ...preparation, cleanup: "failed", cleanupReason: "dependency artifact path is outside the owned location" };
  }
  try {
    fs.rmSync(preparation.artifactPath, { recursive: true });
  } catch (error) {
    return {
      ...preparation,
      cleanup: "failed",
      cleanupReason: error instanceof Error ? error.message : String(error),
    };
  }
  return fs.existsSync(preparation.artifactPath)
    ? { ...preparation, cleanup: "failed", cleanupReason: "dependency artifact removal was not confirmed" }
    : { ...preparation, cleanup: "removed" };
}

function cleanupOwnedWorktree(journal: EnablementVerificationJournal): { cleanup: "removed" | "retained"; reason?: string } {
  if (journal.dependencyPreparation && !["removed", "absent"].includes(journal.dependencyPreparation.cleanup || "")) {
    return { cleanup: "retained", reason: journal.dependencyPreparation.cleanupReason || "dependency artifact cleanup was not confirmed" };
  }
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

  let preparationOutput = "";
  let check: { code: number; stdout: string; stderr: string; timedOut: boolean };
  if (needsNpmDependencies(contract.command)) {
    const artifactPath = path.join(worktreePath, "node_modules");
    journal = {
      ...journal,
      dependencyPreparation: {
        strategy: "npm-ci-ignore-scripts",
        command: "npm ci --ignore-scripts --no-audit --no-fund",
        artifactPath,
        state: "planned",
      },
    };
    writeJson(journalPath, journal);
    if (fs.existsSync(artifactPath)) {
      const reason = "dependency preparation refused a pre-existing node_modules artifact";
      check = { code: 1, stdout: "", stderr: `${reason}\n`, timedOut: false };
      journal = {
        ...journal,
        dependencyPreparation: { ...journal.dependencyPreparation, state: "failed", cleanup: "failed", cleanupReason: reason },
      };
    } else {
      const remainingMs = Math.max(1, timeoutMs - Math.max(0, now() - startedAtMs));
      let prepared: { code: number; stdout: string; stderr: string; timedOut: boolean };
      try {
        prepared = await runProjectCheck({
          cwd: worktreePath,
          command: journal.dependencyPreparation.command,
          quarantineRoot: path.join(input.stateDir, "check-quarantine"),
          timeoutMs: remainingMs,
        });
      } catch (error) {
        const message = error instanceof Error ? (error.stack || error.message) : String(error);
        prepared = { code: 1, stdout: "", stderr: `dependency preparation runner failed: ${message}\n`, timedOut: false };
      }
      preparationOutput = `${prepared.stdout}${prepared.stderr}`;
      journal = {
        ...journal,
        dependencyPreparation: { ...journal.dependencyPreparation, state: prepared.code === 0 ? "installed" : "failed" },
      };
      writeJson(journalPath, journal);
      check = prepared.code === 0
        ? { code: 0, stdout: "", stderr: "", timedOut: false }
        : { code: prepared.code, stdout: "", stderr: "dependency preparation failed\n", timedOut: prepared.timedOut };
    }
  } else {
    check = { code: 0, stdout: "", stderr: "", timedOut: false };
  }

  if (check.code === 0) {
    try {
      const remainingMs = Math.max(1, timeoutMs - Math.max(0, now() - startedAtMs));
      check = await runProjectCheck({
        cwd: worktreePath,
        command: contract.command,
        quarantineRoot: path.join(input.stateDir, "check-quarantine"),
        timeoutMs: remainingMs,
      });
    } catch (error) {
      const message = error instanceof Error ? (error.stack || error.message) : String(error);
      check = { code: 1, stdout: "", stderr: `required verification runner failed: ${message}\n`, timedOut: false };
    }
  }
  const finishedAtMs = now();
  const timeoutEvidence = check.timedOut ? `required verification timed out after ${timeoutMs}ms\n` : "";
  fs.writeFileSync(logPath, `${preparationOutput}${check.stdout}${check.stderr}${timeoutEvidence}`, { encoding: "utf8", mode: 0o600 });
  const outcome = check.code === 0 ? "passed" : "failed";
  writeJson(recordPath, {
    version: 1,
    attemptId,
    repository: input.repository,
    targetCommit: contract.baseRevision,
    contract,
    outcome,
    exitCode: check.code,
    timedOut: check.timedOut,
    timeoutMs,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    logPath,
  });
  journal = { ...journal, state: "checked", recordPath, logPath };
  writeJson(journalPath, journal);

  const dependencyPreparation = cleanupDependencyPreparation(journal);
  if (dependencyPreparation) {
    journal = { ...journal, dependencyPreparation };
    writeJson(journalPath, journal);
  }
  const cleanup = cleanupOwnedWorktree(journal);
  journal = cleanup.cleanup === "removed"
    ? { ...journal, state: "cleaned" }
    : { ...journal, state: "retained", retentionReason: cleanup.reason || "cleanup was not proven safe" };
  writeJson(journalPath, journal);

  return { outcome, exitCode: check.code, journalPath, logPath, recordPath, cleanup: cleanup.cleanup };
}
