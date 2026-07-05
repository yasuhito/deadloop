const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EXTENSION_NAME = "pi-looper";
const STATUS_KEY = EXTENSION_NAME;
const TICK_MS = 30_000;
const {
  DEFAULT_TIMEZONE,
  automationStateKey,
  getDueSlot,
  nextSlotAfter,
  normalizeProject,
  renderTemplate,
  resolveConfigPath,
  sanitizeId,
  templateValues,
} = require("../../src/core.ts");
const {
  buildDoctorSnapshot,
  formatDoctorReport,
} = require("../../src/doctor.ts");
const {
  buildStatusSnapshot,
  formatStatusReport,
} = require("../../src/status.ts");

const CONFIG_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const STATE_DIR = path.join(CONFIG_DIR, EXTENSION_NAME);
const STATE_PATH = path.join(STATE_DIR, "state.json");

function resolveExtensionDir() {
  const candidates = [
    process.env.PI_LOOPER_EXTENSION_DIR,
    process.env.HERDR_LOOPER_EXTENSION_DIR,
    __dirname,
    path.join(CONFIG_DIR, "extensions", EXTENSION_NAME),
    path.join(os.homedir(), ".pi", "agent", "extensions", EXTENSION_NAME),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, "projects.json"))) return candidate;
    } catch {}
  }
  return __dirname;
}

const EXTENSION_DIR = resolveExtensionDir();
const CONFIG_PATH = resolveConfigPath({
  env: process.env,
  stateDir: STATE_DIR,
  extensionDir: EXTENSION_DIR,
  exists: fs.existsSync,
  joinPath: path.join,
});
const AUTOMATION_DIR = path.join(EXTENSION_DIR, "automations");

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function debugLog(...args) {
  if (process.env.PI_LOOPER_DEBUG === "1" || process.env.HERDR_LOOPER_DEBUG === "1") {
    console.warn(`[${EXTENSION_NAME}]`, ...args);
  }
}

function loadProjects() {
  const config = readJsonFile(CONFIG_PATH, { projects: [] });
  debugLog("config", CONFIG_PATH, "projects", (config.projects || []).map((project) => project.id || project.repoPath));
  const only = (process.env.PI_LOOPER_PROJECTS || process.env.HERDR_LOOPER_PROJECTS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => sanitizeId(value));
  return (config.projects || [])
    .map(normalizeProject)
    .filter((project) => project.enabled)
    .filter((project) => !only.length || only.includes(project.id));
}

function loadState() {
  const state = readJsonFile(STATE_PATH, { automations: {} });
  if (!state || typeof state !== "object") return { automations: {} };
  if (!state.automations || typeof state.automations !== "object") state.automations = {};
  return state;
}

function saveState(state) {
  try {
    writeJsonFile(STATE_PATH, state);
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] failed to save state:`, error?.message || error);
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLock(lockPath) {
  return readJsonFile(lockPath, null);
}

function projectLockPath(project) {
  return path.join(STATE_DIR, `scheduler.${sanitizeId(project.id)}.lock`);
}

function acquireSchedulerLock(project) {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const lockPath = projectLockPath(project);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, cwd: process.cwd(), projectId: project.id, startedAt: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return { acquired: true, owner: process.pid, lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lock = readLock(lockPath);
      const owner = Number(lock?.pid);
      if (owner === process.pid) return { acquired: true, owner, lockPath };
      if (isPidAlive(owner)) return { acquired: false, owner, lockPath };
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") return { acquired: false, owner, lockPath };
      }
    }
  }
  const lock = readLock(lockPath);
  return { acquired: false, owner: Number(lock?.pid) || null, lockPath };
}

function releaseSchedulerLock(project) {
  const lockPaths = [projectLockPath(project)];
  for (const lockPath of lockPaths) {
    const lock = readLock(lockPath);
    if (Number(lock?.pid) !== process.pid) continue;
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn(`[${EXTENSION_NAME}] failed to release lock:`, error?.message || error);
      }
    }
  }
}

function formatTime(ms) {
  try {
    return new Date(ms).toLocaleString("ja-JP", {
      timeZone: DEFAULT_TIMEZONE,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

function updateStatus(ctx, project, state) {
  const nextTimes = project.automations.map((automation) => {
    const entry = state.automations[automationStateKey(project, automation)] || {};
    const next = nextSlotAfter(entry, automation, Date.now());
    return next ? `${automation.name.replace(new RegExp(`^${project.id}\\s+`), "")}: ${formatTime(next)}` : null;
  }).filter(Boolean);
  const suffix = nextTimes.length ? `${project.id} next ${nextTimes.join(" / ")}` : `${project.id} on`;
  try {
    ctx.ui.setStatus(STATUS_KEY, suffix);
  } catch {}
}

function activeProject(cwd, projects) {
  let resolvedCwd;
  try {
    resolvedCwd = path.resolve(cwd);
  } catch {
    resolvedCwd = cwd;
  }
  return projects.find((project) => {
    try {
      const repoPath = path.resolve(project.repoPath);
      const matches = resolvedCwd === repoPath || resolvedCwd.startsWith(`${repoPath}${path.sep}`);
      debugLog("project candidate", project.id, "repoPath", repoPath, "cwd", resolvedCwd, "matches", matches);
      return matches;
    } catch (error) {
      debugLog("project candidate error", project.id, error?.message || error);
      return cwd === project.repoPath;
    }
  }) || null;
}

function automationEnv(project, automation) {
  const env = {
    ...process.env,
    PI_LOOPER_PROJECT_ID: project.id,
    PI_LOOPER_REPO_PATH: project.repoPath,
    PI_LOOPER_GITHUB_REPO: project.githubRepo,
    PI_LOOPER_BASE_BRANCH: project.baseBranch,
    PI_LOOPER_WORKTREE_ROOT: project.worktreeRoot || "",
    PI_LOOPER_CHECK_COMMAND: project.checkCommand || "git diff --check",
    PI_LOOPER_AUTO_MERGE: project.autoMerge ? "1" : "0",
    PI_LOOPER_READY_LABEL: project.labels.ready,
    PI_LOOPER_IMPLEMENT_LABEL: project.labels.implement,
    PI_LOOPER_IN_PROGRESS_LABEL: project.labels.inProgress,
    PI_LOOPER_BLOCKED_LABEL: project.labels.blocked,
    PI_LOOPER_REVIEW_LABEL: project.labels.review,
    PI_LOOPER_REVIEWING_LABEL: project.labels.reviewing,
    PI_LOOPER_HUMAN_LABEL: project.labels.human,
    PI_LOOPER_NEEDS_INFO_LABEL: project.labels.needsInfo,
    PI_LOOPER_WONTFIX_LABEL: project.labels.wontfix,
    PI_LOOPER_NEEDS_TRIAGE_LABEL: project.labels.needsTriage,
    PI_LOOPER_AUTOMATION_ID: automation.id,
    PI_LOOPER_AUTOMATION_NAME: automation.name,
  };

  // Backward-compatible aliases for older local prompts/prechecks.
  env.HEADR_PROJECT_ID = env.PI_LOOPER_PROJECT_ID;
  env.HEADR_REPO_PATH = env.PI_LOOPER_REPO_PATH;
  env.HEADR_GITHUB_REPO = env.PI_LOOPER_GITHUB_REPO;
  env.HEADR_BASE_BRANCH = env.PI_LOOPER_BASE_BRANCH;
  env.HEADR_WORKTREE_ROOT = env.PI_LOOPER_WORKTREE_ROOT;
  env.HEADR_CHECK_COMMAND = env.PI_LOOPER_CHECK_COMMAND;
  env.HEADR_AUTO_MERGE = env.PI_LOOPER_AUTO_MERGE;
  env.HEADR_READY_LABEL = env.PI_LOOPER_READY_LABEL;
  env.HEADR_IMPLEMENT_LABEL = env.PI_LOOPER_IMPLEMENT_LABEL;
  env.HEADR_IN_PROGRESS_LABEL = env.PI_LOOPER_IN_PROGRESS_LABEL;
  env.HEADR_BLOCKED_LABEL = env.PI_LOOPER_BLOCKED_LABEL;
  env.HEADR_REVIEW_LABEL = env.PI_LOOPER_REVIEW_LABEL;
  env.HEADR_REVIEWING_LABEL = env.PI_LOOPER_REVIEWING_LABEL;
  env.HEADR_HUMAN_LABEL = env.PI_LOOPER_HUMAN_LABEL;
  env.HEADR_NEEDS_INFO_LABEL = env.PI_LOOPER_NEEDS_INFO_LABEL;
  env.HEADR_WONTFIX_LABEL = env.PI_LOOPER_WONTFIX_LABEL;
  env.HEADR_NEEDS_TRIAGE_LABEL = env.PI_LOOPER_NEEDS_TRIAGE_LABEL;
  env.HEADR_AUTOMATION_ID = env.PI_LOOPER_AUTOMATION_ID;
  env.HEADR_AUTOMATION_NAME = env.PI_LOOPER_AUTOMATION_NAME;
  return env;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function runPrecheck(pi, project, automation) {
  const precheckPath = path.join(AUTOMATION_DIR, automation.precheckFile);
  const env = automationEnv(project, automation);
  const exports = Object.entries(env)
    .filter(([key]) => key.startsWith("PI_LOOPER_") || key.startsWith("HEADR_") || key.startsWith("HERDR_LOOPER_"))
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return await pi.exec("bash", ["-lc", `${exports} ${shellQuote(precheckPath)}`], {
    timeout: automation.precheckTimeoutSeconds * 1000,
  });
}

function readPrompt(project, automation) {
  const template = fs.readFileSync(path.join(AUTOMATION_DIR, automation.promptFile), "utf8");
  return renderTemplate(template, templateValues(project, automation, AUTOMATION_DIR));
}

async function execJson(pi, command, args, fallback, options = {}) {
  try {
    const result = await pi.exec(command, args, { timeout: options.timeout || 15_000 });
    if (result.code !== 0) return fallback;
    return JSON.parse(result.stdout || "null") ?? fallback;
  } catch (error) {
    debugLog("status query failed", command, args.join(" "), error?.message || error);
    return fallback;
  }
}

function uniquePrs(prs) {
  const seen = new Set();
  const unique = [];
  for (const pr of prs) {
    const number = Number(pr?.number || 0);
    if (number && seen.has(number)) continue;
    if (number) seen.add(number);
    unique.push(pr);
  }
  return unique;
}

function worktreesFromHerdrResult(data) {
  if (Array.isArray(data)) return data;
  return ((data?.result || {}).worktrees || []);
}

async function gitText(pi, args) {
  try {
    const result = await pi.exec("git", args, { timeout: 5_000 });
    if (result.code !== 0) return undefined;
    return result.stdout;
  } catch {
    return undefined;
  }
}

async function collectLiveSnapshotData(pi, cwd, options = {}) {
  const includeClosedPrs = options.includeClosedPrs === true;
  const includeIssueComments = options.includeIssueComments === true;

  const projects = loadProjects();
  const state = loadState();
  const project = activeProject(cwd, projects);
  if (!project) {
    return { cwd, projects, state };
  }

  const issueFields = includeIssueComments
    ? "number,title,labels,updatedAt,comments"
    : "number,title,labels,updatedAt";
  const issues = project.githubRepo
    ? await execJson(pi, "gh", [
        "issue",
        "list",
        "-R",
        project.githubRepo,
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        issueFields,
      ], [])
    : [];
  const openPrs = project.githubRepo
    ? await execJson(pi, "gh", [
        "pr",
        "list",
        "-R",
        project.githubRepo,
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        "number,title,labels,updatedAt,headRefName,headRefOid",
      ], [])
    : [];
  const mergedPrs = includeClosedPrs && project.githubRepo
    ? await execJson(pi, "gh", [
        "pr",
        "list",
        "-R",
        project.githubRepo,
        "--state",
        "merged",
        "--limit",
        "100",
        "--json",
        "number,title,state,mergedAt,closedAt,headRefName,headRefOid,labels",
      ], [])
    : [];
  const closedPrs = includeClosedPrs && project.githubRepo
    ? await execJson(pi, "gh", [
        "pr",
        "list",
        "-R",
        project.githubRepo,
        "--state",
        "closed",
        "--limit",
        "100",
        "--json",
        "number,title,state,mergedAt,closedAt,headRefName,headRefOid,labels",
      ], [])
    : [];

  const herdrData = project.repoPath
    ? await execJson(pi, "herdr", ["worktree", "list", "--cwd", project.repoPath, "--json"], { result: { worktrees: [] } })
    : { result: { worktrees: [] } };
  const worktrees = worktreesFromHerdrResult(herdrData);
  const gitStatuses = {};
  const gitHeads = {};
  for (const worktree of worktrees) {
    const worktreePath = String(worktree?.path || "");
    if (!worktreePath) continue;
    const status = await gitText(pi, ["-C", worktreePath, "status", "--short"]);
    if (status !== undefined) gitStatuses[worktreePath] = status;
    const head = await gitText(pi, ["-C", worktreePath, "rev-parse", "HEAD"]);
    if (head !== undefined) gitHeads[worktreePath] = head.trim();
  }

  return {
    cwd,
    projects,
    state,
    issues,
    openPrs,
    closedPrs: uniquePrs([...(mergedPrs || []), ...(closedPrs || [])]),
    worktrees,
    gitStatuses,
    gitHeads,
  };
}

async function buildLiveStatusReport(pi, cwd) {
  const data = await collectLiveSnapshotData(pi, cwd, { includeClosedPrs: true });
  return formatStatusReport(buildStatusSnapshot(data));
}

async function buildLiveDoctorReport(pi, cwd) {
  const data = await collectLiveSnapshotData(pi, cwd, { includeIssueComments: true });
  return formatDoctorReport(buildDoctorSnapshot(data));
}

async function runAutomation(pi, ctx, project, automation, dueSlot, state) {
  const now = Date.now();
  const key = automationStateKey(project, automation);
  const entry = state.automations[key] || {};
  state.automations[key] = entry;

  entry.lastScheduledAt = dueSlot;
  entry.lastAttemptAt = now;
  entry.updatedAt = now;
  entry.name = automation.name;
  entry.projectId = project.id;
  entry.schedule = automation.schedule;
  saveState(state);

  try {
    ctx.ui.setStatus(STATUS_KEY, `precheck: ${automation.name}`);
  } catch {}

  let result;
  try {
    result = await runPrecheck(pi, project, automation);
  } catch (error) {
    entry.lastResult = "precheck_error";
    entry.lastError = error?.message || String(error);
    entry.updatedAt = Date.now();
    saveState(state);
    try {
      ctx.ui.notify(`${EXTENSION_NAME} precheck failed: ${automation.name}`, "warning");
    } catch {}
    return;
  }

  if (result.code !== 0) {
    entry.lastResult = `precheck_skipped:${result.code}`;
    entry.lastSkippedAt = Date.now();
    entry.updatedAt = Date.now();
    saveState(state);
    return;
  }

  if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
    entry.lastResult = "deferred_busy_after_precheck";
    entry.updatedAt = Date.now();
    saveState(state);
    return;
  }

  try {
    const prompt = readPrompt(project, automation);
    pi.sendUserMessage(prompt);
    entry.lastResult = "queued";
    entry.lastQueuedAt = Date.now();
    entry.updatedAt = Date.now();
    saveState(state);
    try {
      ctx.ui.notify(`${EXTENSION_NAME} queued: ${automation.name}`, "info");
    } catch {}
  } catch (error) {
    entry.lastResult = "send_error";
    entry.lastError = error?.message || String(error);
    entry.updatedAt = Date.now();
    saveState(state);
    try {
      ctx.ui.notify(`${EXTENSION_NAME} send failed: ${automation.name}`, "error");
    } catch {}
  }
}

export default function (pi) {
  pi.registerCommand("pi-looper-status", {
    description: "Show the active pi-looper project, automations, GitHub queues, and Herdr worker worktrees",
    handler: async (_args, ctx) => {
      const report = await buildLiveStatusReport(pi, ctx.cwd);
      if (ctx.mode === "print" || ctx.mode === "json") {
        console.log(report);
      } else {
        pi.sendMessage({ customType: "pi-looper-status", content: report, display: true });
      }
    },
  });

  pi.registerCommand("pi-looper-doctor", {
    description: "Diagnose known pi-looper failure modes and show copy-paste recovery or inspection commands",
    handler: async (_args, ctx) => {
      const report = await buildLiveDoctorReport(pi, ctx.cwd);
      if (ctx.mode === "print" || ctx.mode === "json") {
        console.log(report);
      } else {
        pi.sendMessage({ customType: "pi-looper-doctor", content: report, display: true });
      }
    },
  });

  let timer = null;
  let running = false;
  let startupTick = null;
  let active = null;
  let ownsLock = false;

  async function tick(ctx) {
    if (!active?.project) return;
    if (running) return;
    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
    if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return;

    const project = active.project;
    const state = loadState();
    updateStatus(ctx, project, state);

    const now = Date.now();
    for (const automation of project.automations) {
      const key = automationStateKey(project, automation);
      const entry = state.automations[key] || {};
      state.automations[key] = entry;
      const dueSlot = getDueSlot(automation, entry, now);
      if (!dueSlot) continue;

      running = true;
      try {
        await runAutomation(pi, ctx, project, automation, dueSlot, state);
        updateStatus(ctx, project, state);
      } finally {
        running = false;
      }
      break;
    }

    saveState(state);
  }

  pi.on("session_start", async (_event, ctx) => {
    const projects = loadProjects();
    const project = activeProject(ctx.cwd, projects);
    debugLog("session_start", "cwd", ctx.cwd, "mode", ctx.mode, "project", project?.id || null);
    if (!project) return;
    if (ctx.mode === "print" || ctx.mode === "json") return;
    if (
      process.env.PI_LOOPER === "off" ||
      process.env.PI_LOOPER_AUTOMATIONS === "off" ||
      process.env.HERDR_LOOPER === "off" ||
      process.env.HERDR_LOOPER_AUTOMATIONS === "off"
    ) {
      return;
    }

    const lock = acquireSchedulerLock(project);
    ownsLock = lock.acquired;
    active = { project, lockPath: lock.lockPath };
    if (!ownsLock) {
      try {
        ctx.ui.setStatus(STATUS_KEY, `${project.id} standby: owner pid ${lock.owner ?? "unknown"}`);
      } catch {}
      return;
    }

    const state = loadState();
    updateStatus(ctx, project, state);

    if (timer) clearInterval(timer);
    if (startupTick) clearTimeout(startupTick);

    timer = setInterval(() => {
      tick(ctx).catch((error) => {
        console.warn(`[${EXTENSION_NAME}] tick failed:`, error?.message || error);
      });
    }, TICK_MS);
    timer.unref?.();

    startupTick = setTimeout(() => {
      tick(ctx).catch((error) => {
        console.warn(`[${EXTENSION_NAME}] startup tick failed:`, error?.message || error);
      });
    }, 3000);
    startupTick.unref?.();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (timer) clearInterval(timer);
    if (startupTick) clearTimeout(startupTick);
    timer = null;
    startupTick = null;
    if (ownsLock && active?.project) {
      releaseSchedulerLock(active.project);
      ownsLock = false;
    }
    active = null;
    try {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    } catch {}
  });
}
