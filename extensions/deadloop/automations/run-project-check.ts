#!/usr/bin/env node
// Run a project validation command while keeping deadloop's generated evidence
// out of recursive formatters. CommonJS-shaped so Node can execute this file.

const childProcess = require("node:child_process") as typeof import("node:child_process");
const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const crypto = require("node:crypto") as typeof import("node:crypto");

const ARTIFACT_DIRECTORIES = [".deadloop", ".pi-subagents"] as const;
const MANIFEST_PREFIX = ".deadloop-project-check-";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const TIMEOUT_EXIT_CODE = 124;

type ManifestEntry = {
  name: (typeof ARTIFACT_DIRECTORIES)[number];
  original: string;
  holding: string;
  existed: boolean;
};

type RecoveryManifest = {
  version: 1;
  worktree: string;
  pid: number;
  entries: ManifestEntry[];
};

type ParsedArguments = {
  cwd: string;
  timeoutMs: number;
  command: string | null;
  argv: string[];
};

function usage(): string {
  return [
    "Usage:",
    "  run-project-check.ts [--cwd PATH] [--timeout-ms MS] --command 'shell command'",
    "  run-project-check.ts [--cwd PATH] [--timeout-ms MS] -- executable [args...]",
  ].join("\n");
}

function parseArguments(argv: string[]): ParsedArguments {
  let cwd = process.cwd();
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let command: string | null = null;
  let index = 0;
  for (; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (token === "--cwd") {
      cwd = path.resolve(argv[++index] || "");
      continue;
    }
    if (token === "--timeout-ms") {
      timeoutMs = Number(argv[++index]);
      continue;
    }
    if (token === "--command") {
      command = argv[++index] ?? null;
      index += 1;
      break;
    }
    if (token === "--help" || token === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`unknown argument: ${token}`);
  }
  const directArgv = argv.slice(index);
  if ((!command && directArgv.length === 0) || (command !== null && directArgv.length > 0)) {
    throw new Error("provide exactly one of --command or -- executable [args...]");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer");
  return { cwd, timeoutMs, command, argv: directArgv };
}

function pathExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function durableWriteJson(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, file);
  fsyncDirectory(path.dirname(file));
}

function worktreeKey(worktree: string): string {
  return crypto.createHash("sha256").update(worktree).digest("hex").slice(0, 20);
}

function manifestPathFor(worktree: string): string {
  return path.join(path.dirname(worktree), `${MANIFEST_PREFIX}${worktreeKey(worktree)}.json`);
}

function validateManifest(manifest: RecoveryManifest, worktree: string): void {
  if (manifest.version !== 1 || manifest.worktree !== worktree || !Array.isArray(manifest.entries)) {
    throw new Error("recovery manifest does not match this worktree");
  }
  const expectedNames = [...ARTIFACT_DIRECTORIES];
  const holdingPrefix = path.join(path.dirname(worktree), `.deadloop-project-check-hold-${worktreeKey(worktree)}-`);
  if (manifest.entries.length !== expectedNames.length) throw new Error("recovery manifest has invalid entries");
  for (const [index, entry] of manifest.entries.entries()) {
    const name = expectedNames[index];
    const expectedOriginal = path.join(worktree, name);
    if (
      entry.name !== name ||
      entry.original !== expectedOriginal ||
      !entry.holding.startsWith(holdingPrefix) ||
      path.dirname(entry.holding) !== path.dirname(worktree) ||
      typeof entry.existed !== "boolean"
    ) {
      throw new Error(`recovery manifest has unsafe entry for ${name}`);
    }
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function restoreManifest(manifestPath: string, manifest: RecoveryManifest): void {
  for (const entry of manifest.entries) {
    const originalExists = pathExists(entry.original);
    const holdingExists = pathExists(entry.holding);
    if (holdingExists && originalExists) {
      throw new Error(`restoration conflict: both ${entry.original} and ${entry.holding} exist`);
    }
    if (holdingExists) fs.renameSync(entry.holding, entry.original);
    if (entry.existed && !holdingExists && !originalExists) {
      throw new Error(`restoration evidence is missing for ${entry.original}`);
    }
  }
  fs.unlinkSync(manifestPath);
  fsyncDirectory(path.dirname(manifestPath));
}

function recoverAbandonedManifest(manifestPath: string, worktree: string): void {
  if (!pathExists(manifestPath)) return;
  let manifest: RecoveryManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read recovery manifest ${manifestPath}: ${(error as Error).message}`);
  }
  validateManifest(manifest, worktree);
  if (manifest.pid !== process.pid && processIsAlive(manifest.pid)) {
    throw new Error(`project check ${manifest.pid} is still active; refusing concurrent recovery`);
  }
  restoreManifest(manifestPath, manifest);
}

function createManifest(worktree: string, manifestPath: string): RecoveryManifest {
  const runId = crypto.randomUUID();
  const parent = path.dirname(worktree);
  const key = worktreeKey(worktree);
  const entries = ARTIFACT_DIRECTORIES.map((name) => ({
    name,
    original: path.join(worktree, name),
    holding: path.join(parent, `.deadloop-project-check-hold-${key}-${name.slice(1)}-${runId}`),
    existed: pathExists(path.join(worktree, name)),
  }));
  const manifest: RecoveryManifest = { version: 1, worktree, pid: process.pid, entries };
  durableWriteJson(manifestPath, manifest);
  return manifest;
}

function isolate(manifest: RecoveryManifest): void {
  for (const entry of manifest.entries) {
    if (entry.existed) fs.renameSync(entry.original, entry.holding);
  }
}

function killChild(child: import("node:child_process").ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function runCommand(parsed: ParsedArguments): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; parentSignal: NodeJS.Signals | null }> {
  const executable = parsed.command === null ? parsed.argv[0] : process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
  const args = parsed.command === null ? parsed.argv.slice(1) : process.platform === "win32" ? ["/d", "/s", "/c", parsed.command] : ["-c", parsed.command];
  let child: import("node:child_process").ChildProcess;
  try {
    child = childProcess.spawn(executable, args, {
      cwd: parsed.cwd,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
  } catch (error) {
    throw new Error(`cannot spawn project check: ${(error as Error).message}`);
  }

  return await new Promise((resolve, reject) => {
    let timedOut = false;
    let parentSignal: NodeJS.Signals | null = null;
    let forceTimer: NodeJS.Timeout | undefined;
    const onSignal = (signal: NodeJS.Signals) => {
      if (parentSignal) return;
      parentSignal = signal;
      killChild(child, signal);
      forceTimer = setTimeout(() => killChild(child, "SIGKILL"), 1000);
      forceTimer.unref();
    };
    const onSigint = () => onSignal("SIGINT");
    const onSigterm = () => onSignal("SIGTERM");
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    const timeout = setTimeout(() => {
      timedOut = true;
      killChild(child, "SIGTERM");
      forceTimer = setTimeout(() => killChild(child, "SIGKILL"), 1000);
      forceTimer.unref();
    }, parsed.timeoutMs);
    timeout.unref();

    const finish = () => {
      clearTimeout(timeout);
      if (forceTimer) clearTimeout(forceTimer);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    child.once("error", (error) => {
      finish();
      reject(new Error(`cannot spawn project check: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      finish();
      resolve({ code, signal, timedOut, parentSignal });
    });
  });
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const worktree = fs.realpathSync(parsed.cwd);
  const manifestPath = manifestPathFor(worktree);
  recoverAbandonedManifest(manifestPath, worktree);
  const manifest = createManifest(worktree, manifestPath);
  let result: Awaited<ReturnType<typeof runCommand>> | null = null;
  let commandError: Error | null = null;
  try {
    isolate(manifest);
    result = await runCommand({ ...parsed, cwd: worktree });
  } catch (error) {
    commandError = error as Error;
  }

  try {
    restoreManifest(manifestPath, manifest);
  } catch (error) {
    throw new Error(`project check cleanup failed: ${(error as Error).message}`);
  }
  if (commandError) throw commandError;
  if (!result) throw new Error("project check produced no result");
  if (result.parentSignal) {
    process.kill(process.pid, result.parentSignal);
    return;
  }
  if (result.timedOut) {
    process.stderr.write(`project check timed out after ${parsed.timeoutMs}ms\n`);
    process.exitCode = TIMEOUT_EXIT_CODE;
    return;
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exitCode = result.code ?? 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`run-project-check: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { manifestPathFor, parseArguments, recoverAbandonedManifest, restoreManifest };
