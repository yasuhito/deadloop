const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { execFileSync, spawn } = require("node:child_process") as typeof import("node:child_process");
const crypto = require("node:crypto") as typeof import("node:crypto");
const { AGENT_SCRATCH_AREAS } = require("./agent-scratch-area.cjs");

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function renderProjectCheckCommand(input: {
  automationDir: string;
  stateDir: string;
  cwd: string;
  command: string;
}): string {
  return [
    "node",
    shellQuote(path.join(input.automationDir, "run-project-check.ts")),
    "--cwd",
    shellQuote(input.cwd),
    "--command",
    shellQuote(input.command),
    "--quarantine-root",
    shellQuote(path.join(input.stateDir, "check-quarantine")),
  ].join(" ");
}

type ProjectCheckInput = {
  cwd: string;
  command: string;
  quarantineRoot: string;
  timeoutMs?: number;
  terminationGraceMs?: number;
  signal?: AbortSignal;
  structuredResultPath?: string;
  /** Written at startup so a signaled parent can forward termination to this wrapper. */
  pidFile?: string;
};

type ScratchAreaRestorationFailure = {
  message: string;
  quarantinePath: string;
};

type RetainedProjectCheckFailure = ScratchAreaRestorationFailure & {
  recordPath: string;
  worktreePath: string;
  createdAt: string;
  attemptId?: string;
  project?: string;
  repository?: string;
  attemptRecordPath?: string;
};

type ProjectCheckResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  interrupted: boolean;
  signal: NodeJS.Signals | null;
  restorationFailure?: ScratchAreaRestorationFailure;
};

type HiddenArtifact = {
  original: string;
  quarantined: string;
};

function preservedPath(target: string): string {
  let suffix = 1;
  while (fs.existsSync(`${target}.deadloop-preserved-${suffix}`)) suffix += 1;
  return `${target}.deadloop-preserved-${suffix}`;
}

function mergeRestoredPath(source: string, target: string): void {
  if (!fs.existsSync(target)) {
    // A scratch area nests under the agent CLI's directory, which the check may
    // have removed while it was quarantined.
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
    return;
  }

  const sourceStat = fs.lstatSync(source);
  const targetStat = fs.lstatSync(target);
  if (sourceStat.isDirectory() && targetStat.isDirectory()) {
    for (const entry of fs.readdirSync(source)) mergeRestoredPath(path.join(source, entry), path.join(target, entry));
    fs.rmdirSync(source);
    return;
  }

  if (sourceStat.isFile() && targetStat.isFile() && fs.readFileSync(source).equals(fs.readFileSync(target))) {
    fs.unlinkSync(source);
    return;
  }

  fs.renameSync(source, preservedPath(target));
}

function trackedScratchAreaFiles(cwd: string): string[] {
  const output = execFileSync("git", ["-C", cwd, "ls-files", "-z", "--", ...AGENT_SCRATCH_AREAS], { encoding: "utf8" });
  return output.split("\0").filter(Boolean);
}

function hideAgentScratchAreas(cwd: string, quarantineRoot: string): { restore: () => ScratchAreaRestorationFailure | undefined } {
  const resolvedCwd = path.resolve(cwd);
  const resolvedRoot = path.resolve(quarantineRoot);
  if (resolvedRoot === resolvedCwd || resolvedRoot.startsWith(`${resolvedCwd}${path.sep}`)) {
    throw new Error("project-check quarantine root must be outside the project worktree");
  }

  fs.mkdirSync(resolvedRoot, { recursive: true });
  const quarantineDir = fs.mkdtempSync(path.join(resolvedRoot, "check-"));
  const hidden: HiddenArtifact[] = [];
  try {
    for (const scratchArea of AGENT_SCRATCH_AREAS) {
      const original = path.join(resolvedCwd, scratchArea);
      if (!fs.existsSync(original)) continue;
      const quarantined = path.join(quarantineDir, scratchArea);
      fs.mkdirSync(path.dirname(quarantined), { recursive: true });
      fs.renameSync(original, quarantined);
      hidden.push({ original, quarantined });
    }
  } catch (error) {
    let rollbackError: unknown;
    for (const artifact of hidden.reverse()) {
      try {
        mergeRestoredPath(artifact.quarantined, artifact.original);
      } catch (candidate) {
        rollbackError ||= candidate;
      }
    }
    if (!rollbackError) {
      fs.rmSync(quarantineDir, { recursive: true, force: true });
      throw error;
    }
    throw Object.assign(
      new Error(error instanceof Error ? error.message : String(error), { cause: error }),
      {
        restorationFailure: {
          message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          quarantinePath: quarantineDir,
        },
      },
    );
  }

  return {
    restore() {
      let restoreError: unknown;
      for (const artifact of hidden.reverse()) {
        try {
          mergeRestoredPath(artifact.quarantined, artifact.original);
        } catch (error) {
          restoreError ||= error;
        }
      }
      if (!restoreError) {
        try {
          fs.rmSync(quarantineDir, { recursive: true, force: true });
        } catch (error) {
          restoreError = error;
        }
      }
      if (!restoreError) return undefined;
      return {
        message: restoreError instanceof Error ? restoreError.message : String(restoreError),
        quarantinePath: quarantineDir,
      };
    },
  };
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number | undefined,
  terminationGraceMs: number,
  signal: AbortSignal | undefined,
): Promise<ProjectCheckResult> {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn("bash", ["-lc", command], {
      cwd,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = false;
    let escalationTimer: NodeJS.Timeout | undefined;
    let terminationStarted = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    const kill = (killSignal: NodeJS.Signals) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, killSignal);
        else child.kill(killSignal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const terminate = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      kill("SIGTERM");
      escalationTimer = setTimeout(() => kill("SIGKILL"), terminationGraceMs);
    };
    const interrupt = () => {
      if (terminationStarted) return;
      interrupted = true;
      terminate();
    };
    signal?.addEventListener("abort", interrupt, { once: true });
    if (signal?.aborted) interrupt();
    const timer = timeoutMs
      ? setTimeout(() => {
          if (terminationStarted) return;
          timedOut = true;
          terminate();
        }, timeoutMs)
      : undefined;
    child.once("close", (code, closeSignal) => {
      if (timer) clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      signal?.removeEventListener("abort", interrupt);
      resolve({
        code: timedOut ? 124 : interrupted ? 130 : code,
        stdout,
        stderr,
        timedOut,
        interrupted,
        signal: closeSignal,
      });
    });
  });
}

async function runProjectCheck(input: ProjectCheckInput): Promise<ProjectCheckResult> {
  let tracked: string[];
  try {
    tracked = trackedScratchAreaFiles(input.cwd);
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: `project-check could not inspect the agent scratch areas: ${error instanceof Error ? error.message : String(error)}\n`,
      timedOut: false,
      interrupted: false,
      signal: null,
    };
  }
  if (tracked.length) {
    return {
      code: 1,
      stdout: "",
      stderr: `project-check refuses to hide tracked files in an agent scratch area: ${tracked.join(", ")}\n`,
      timedOut: false,
      interrupted: false,
      signal: null,
    };
  }

  const hidden = hideAgentScratchAreas(input.cwd, input.quarantineRoot);
  let result: ProjectCheckResult;
  try {
    result = await runShell(input.command, input.cwd, input.timeoutMs, input.terminationGraceMs ?? 1000, input.signal);
  } catch (error) {
    const restorationFailure = hidden.restore();
    if (restorationFailure) {
      throw Object.assign(
        new Error(error instanceof Error ? error.message : String(error), { cause: error }),
        { restorationFailure },
      );
    }
    throw error;
  }
  const restorationFailure = hidden.restore();
  return restorationFailure ? { ...result, restorationFailure } : result;
}

function projectCheckRestorationFailureFrom(error: unknown): ScratchAreaRestorationFailure | undefined {
  const candidate = (error as { restorationFailure?: unknown } | null)?.restorationFailure;
  if (!candidate || typeof candidate !== "object") return undefined;
  const value = candidate as Record<string, unknown>;
  if (typeof value.message !== "string" || typeof value.quarantinePath !== "string") return undefined;
  return { message: value.message, quarantinePath: value.quarantinePath };
}

function matchingAttempt(stateDir: string, worktreePath: string): {
  attemptId: string;
  project: string;
  repository: string;
  attemptRecordPath: string;
} | undefined {
  const runsDir = path.join(stateDir, "runs");
  let entries: import("node:fs").Dirent[];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const matches = entries.flatMap((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) return [];
    const attemptRecordPath = path.join(runsDir, entry.name, "attempt.json");
    try {
      const record = JSON.parse(fs.readFileSync(attemptRecordPath, "utf8"));
      if (path.resolve(String(record.worktreePath || "")) !== worktreePath
        || typeof record.attemptId !== "string" || typeof record.project !== "string"
        || typeof record.repository !== "string") return [];
      return [{
        attemptId: record.attemptId,
        project: record.project,
        repository: record.repository,
        attemptRecordPath,
        active: !["workspace_closed", "abandoned"].includes(String(record.phase || "")),
        modifiedAtMs: fs.statSync(attemptRecordPath).mtimeMs,
      }];
    } catch {
      return [];
    }
  });
  const active = matches.filter((match) => match.active);
  const candidates = active.length ? active : matches;
  const selected = candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)[0];
  if (!selected) return undefined;
  return {
    attemptId: selected.attemptId,
    project: selected.project,
    repository: selected.repository,
    attemptRecordPath: selected.attemptRecordPath,
  };
}

function recordProjectCheckRestorationFailure(input: ProjectCheckInput, failure: ScratchAreaRestorationFailure): string {
  const stateDir = path.dirname(path.resolve(input.quarantineRoot));
  const worktreePath = path.resolve(input.cwd);
  const directory = path.join(stateDir, "project-check-restoration-failures");
  fs.mkdirSync(directory, { recursive: true });
  const recordPath = path.join(directory, `${Date.now()}-${crypto.randomUUID()}.json`);
  const temporary = `${recordPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({
    version: 1,
    worktreePath,
    quarantinePath: path.resolve(failure.quarantinePath),
    message: failure.message,
    createdAt: new Date().toISOString(),
    ...matchingAttempt(stateDir, worktreePath),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, recordPath);
  return recordPath;
}

function inspectRetainedProjectCheckFailures(
  stateDir: string,
  project?: { id: string; githubRepo: string },
): RetainedProjectCheckFailure[] {
  const directory = path.join(stateDir, "project-check-restoration-failures");
  let entries: import("node:fs").Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) return [];
    const recordPath = path.join(directory, entry.name);
    try {
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      if (record.version !== 1 || typeof record.worktreePath !== "string"
        || typeof record.quarantinePath !== "string" || typeof record.message !== "string"
        || typeof record.createdAt !== "string") return [];
      if (project && (record.project !== project.id || record.repository !== project.githubRepo)) return [];
      return [{ ...record, recordPath } as RetainedProjectCheckFailure];
    } catch {
      return [];
    }
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function inspectUnresolvedProjectCheckFailures(stateDir: string): RetainedProjectCheckFailure[] {
  return inspectRetainedProjectCheckFailures(stateDir).filter((failure) =>
    typeof failure.attemptId !== "string"
    || typeof failure.project !== "string"
    || typeof failure.repository !== "string"
    || typeof failure.attemptRecordPath !== "string"
  );
}

function parseCliArgs(argv: string[]): ProjectCheckInput {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("expected --cwd, --command, and --quarantine-root values");
    values[key.slice(2)] = value;
  }
  if (!values.cwd || !values.command || !values["quarantine-root"]) {
    throw new Error("--cwd, --command, and --quarantine-root are required");
  }
  const timeoutMs = values["timeout-ms"] ? Number(values["timeout-ms"]) : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new Error("--timeout-ms must be positive");
  return {
    cwd: values.cwd,
    command: values.command,
    quarantineRoot: values["quarantine-root"],
    timeoutMs,
    ...(values["structured-result"] ? { structuredResultPath: values["structured-result"] } : {}),
    ...(values["pid-file"] ? { pidFile: values["pid-file"] } : {}),
  };
}

function writeStructuredProjectCheckResult(file: string | undefined, result: ProjectCheckResult): void {
  if (!file) return;
  const payload = {
    version: 1,
    code: result.code,
    timedOut: result.timedOut,
    interrupted: result.interrupted,
    signal: result.signal,
    ...(result.restorationFailure ? { restorationFailure: true } : {}),
  };
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`);
  fs.renameSync(temporary, file);
}

async function projectCheckMain(
  argv: string[] = process.argv.slice(2),
  runner: typeof runProjectCheck = runProjectCheck,
): Promise<void> {
  const input = parseCliArgs(argv);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  // A parent blocked in a synchronous wait cannot see this process; the published pid is how it
  // forwards its own termination here so the checks stop and the scratch areas are restored.
  if (input.pidFile) fs.writeFileSync(input.pidFile, `${process.pid}\n`, { mode: 0o600 });
  try {
    let result: ProjectCheckResult;
    try {
      result = await runner({ ...input, signal: controller.signal });
    } catch (error) {
      const failure = projectCheckRestorationFailureFrom(error);
      if (failure) recordProjectCheckRestorationFailure(input, failure);
      throw error;
    }
    writeStructuredProjectCheckResult(input.structuredResultPath, result);
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.restorationFailure) {
      const recordPath = recordProjectCheckRestorationFailure(input, result.restorationFailure);
      process.stderr.write(`project-check could not restore the agent scratch areas; retained quarantine: ${result.restorationFailure.quarantinePath}; record: ${recordPath}; ${result.restorationFailure.message}\n`);
    }
    process.exitCode = result.restorationFailure && result.code === 0 ? 1 : result.code ?? 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (input.pidFile) fs.rmSync(input.pidFile, { force: true });
  }
}

module.exports = {
  inspectRetainedProjectCheckFailures,
  projectCheckRestorationFailureFrom,
  recordProjectCheckRestorationFailure,
  inspectUnresolvedProjectCheckFailures,
  projectCheckMain,
  renderProjectCheckCommand,
  runProjectCheck,
};

if (require.main === module) {
  projectCheckMain().catch((error) => {
    console.error(`project-check.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
