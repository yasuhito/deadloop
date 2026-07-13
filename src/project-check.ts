const fs = require("node:fs") as typeof import("node:fs");
const path = require("node:path") as typeof import("node:path");
const { execFileSync, spawn } = require("node:child_process") as typeof import("node:child_process");

const RUNTIME_PATHS = [".deadloop", ".pi-subagents"];

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
};

type ProjectCheckResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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

function trackedRuntimeFiles(cwd: string): string[] {
  const output = execFileSync("git", ["-C", cwd, "ls-files", "-z", "--", ...RUNTIME_PATHS], { encoding: "utf8" });
  return output.split("\0").filter(Boolean);
}

function hideRuntimeArtifacts(cwd: string, quarantineRoot: string): { restore: () => void } {
  const resolvedCwd = path.resolve(cwd);
  const resolvedRoot = path.resolve(quarantineRoot);
  if (resolvedRoot === resolvedCwd || resolvedRoot.startsWith(`${resolvedCwd}${path.sep}`)) {
    throw new Error("project-check quarantine root must be outside the project worktree");
  }

  fs.mkdirSync(resolvedRoot, { recursive: true });
  const quarantineDir = fs.mkdtempSync(path.join(resolvedRoot, "check-"));
  const hidden: HiddenArtifact[] = [];
  try {
    for (const name of RUNTIME_PATHS) {
      const original = path.join(resolvedCwd, name);
      if (!fs.existsSync(original)) continue;
      const quarantined = path.join(quarantineDir, name);
      fs.renameSync(original, quarantined);
      hidden.push({ original, quarantined });
    }
  } catch (error) {
    for (const artifact of hidden.reverse()) mergeRestoredPath(artifact.quarantined, artifact.original);
    fs.rmSync(quarantineDir, { recursive: true, force: true });
    throw error;
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
      if (!restoreError) fs.rmSync(quarantineDir, { recursive: true, force: true });
      if (restoreError) throw restoreError;
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
      interrupted = true;
      terminate();
    };
    signal?.addEventListener("abort", interrupt, { once: true });
    if (signal?.aborted) interrupt();
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, timeoutMs)
      : undefined;
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      signal?.removeEventListener("abort", interrupt);
      resolve({ code: timedOut ? 124 : interrupted ? 130 : (code ?? 1), stdout, stderr, timedOut });
    });
  });
}

async function runProjectCheck(input: ProjectCheckInput): Promise<ProjectCheckResult> {
  let tracked: string[];
  try {
    tracked = trackedRuntimeFiles(input.cwd);
  } catch (error) {
    return {
      code: 1,
      stdout: "",
      stderr: `project-check could not inspect tracked runtime paths: ${error instanceof Error ? error.message : String(error)}\n`,
      timedOut: false,
    };
  }
  if (tracked.length) {
    return {
      code: 1,
      stdout: "",
      stderr: `project-check refuses to hide tracked runtime paths: ${tracked.join(", ")}\n`,
      timedOut: false,
    };
  }

  const hidden = hideRuntimeArtifacts(input.cwd, input.quarantineRoot);
  try {
    return await runShell(input.command, input.cwd, input.timeoutMs, input.terminationGraceMs ?? 1000, input.signal);
  } finally {
    hidden.restore();
  }
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
  return { cwd: values.cwd, command: values.command, quarantineRoot: values["quarantine-root"], timeoutMs };
}

async function projectCheckMain(argv: string[] = process.argv.slice(2)): Promise<void> {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const result = await runProjectCheck({ ...parseCliArgs(argv), signal: controller.signal });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

module.exports = { projectCheckMain, renderProjectCheckCommand, runProjectCheck };

if (require.main === module) {
  projectCheckMain().catch((error) => {
    console.error(`project-check.ts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
