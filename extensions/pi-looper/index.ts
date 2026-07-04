const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EXTENSION_NAME = "pi-looper";
const STATUS_KEY = EXTENSION_NAME;
const TICK_MS = 30_000;
const DEFAULT_TIMEZONE = "Asia/Tokyo";

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
const CONFIG_PATH = process.env.PI_LOOPER_CONFIG || process.env.HERDR_LOOPER_CONFIG || path.join(EXTENSION_DIR, "projects.json");
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

function sanitizeId(value) {
  return String(value || "project")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

function normalizeLabels(labels = {}) {
  return {
    ready: labels.ready || "ready-for-agent",
    implement: labels.implement || "agent:implement",
    inProgress: labels.inProgress || "agent:in-progress",
    blocked: labels.blocked || "agent:blocked",
    review: labels.review || "agent:review",
    reviewing: labels.reviewing || "agent:reviewing",
    human: labels.human || "ready-for-human",
    needsInfo: labels.needsInfo || "needs-info",
    wontfix: labels.wontfix || "wontfix",
    needsTriage: labels.needsTriage || "needs-triage",
  };
}

function normalizeAutomation(project, automation) {
  const id = automation.id || `${project.id}:${automation.name || automation.promptFile || "automation"}`;
  return {
    id,
    name: automation.name || id,
    schedule: automation.schedule || "*/10 * * * *",
    timezone: automation.timezone || DEFAULT_TIMEZONE,
    graceMinutes: Number.isFinite(automation.graceMinutes) ? automation.graceMinutes : 720,
    promptFile: automation.promptFile,
    precheckFile: automation.precheckFile,
    precheckTimeoutSeconds: Number.isFinite(automation.precheckTimeoutSeconds)
      ? automation.precheckTimeoutSeconds
      : 60,
    initialLastScheduledAt: Number.isFinite(automation.initialLastScheduledAt)
      ? automation.initialLastScheduledAt
      : 0,
  };
}

function normalizeProject(raw) {
  const id = sanitizeId(raw.id || raw.githubRepo || raw.repoPath);
  const project = {
    id,
    enabled: raw.enabled !== false,
    repoPath: raw.repoPath,
    githubRepo: raw.githubRepo,
    baseBranch: raw.baseBranch || "origin/main",
    worktreeRoot: raw.worktreeRoot || "",
    checkCommand: raw.checkCommand || "git diff --check",
    workerInstructions: raw.workerInstructions || "AGENTS.md、CONTEXT.md、関連 docs/adr/ を読んでから作業する。",
    workerLaunchPolicy: raw.workerLaunchPolicy || "Worker 起動時は issue の難易度を見て Pi の起動オプションを自分で選ぶ。原則としてモデル名は変更せず、--thinking で調整する。単純なドキュメント修正・小さなテスト修正・局所的な実装は --thinking low、通常の実装は --thinking medium、複数コンポーネント・設計判断・データ移行・難しい不具合修正は --thinking high。プロジェクト設定で明示的に低コストモデルが許可されている場合だけ --model を付けてよい。判断理由を worker prompt に1行で残す。",
    labels: normalizeLabels(raw.labels || {}),
    automations: [],
  };
  project.automations = (raw.automations || []).map((automation) => normalizeAutomation(project, automation));
  return project;
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

function parseEveryMinutes(schedule) {
  const match = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(String(schedule || "").trim());
  if (!match) return null;
  const minutes = Number(match[1]);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return minutes;
}

function cronSlotAt(nowMs, intervalMinutes) {
  const intervalMs = intervalMinutes * 60_000;
  return Math.floor(nowMs / intervalMs) * intervalMs;
}

function automationStateKey(project, automation) {
  return `${project.id}:${automation.id}`;
}

function getDueSlot(automation, entry, nowMs) {
  const intervalMinutes = parseEveryMinutes(automation.schedule);
  if (!intervalMinutes) return null;

  const latestSlot = cronSlotAt(nowMs, intervalMinutes);
  const lastScheduledAt = Number.isFinite(entry.lastScheduledAt)
    ? entry.lastScheduledAt
    : automation.initialLastScheduledAt;

  if (latestSlot <= lastScheduledAt) return null;

  const graceMs = automation.graceMinutes * 60_000;
  if (nowMs - latestSlot > graceMs) {
    entry.lastScheduledAt = latestSlot;
    entry.lastResult = "missed_outside_grace";
    entry.updatedAt = nowMs;
    return null;
  }

  return latestSlot;
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

function nextSlotAfter(entry, automation, nowMs) {
  const intervalMinutes = parseEveryMinutes(automation.schedule);
  if (!intervalMinutes) return null;
  const intervalMs = intervalMinutes * 60_000;
  const lastScheduledAt = Number.isFinite(entry.lastScheduledAt)
    ? entry.lastScheduledAt
    : automation.initialLastScheduledAt;
  const candidate = lastScheduledAt + intervalMs;
  if (candidate > nowMs) return candidate;
  return cronSlotAt(nowMs, intervalMinutes) + intervalMs;
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

function templateValues(project, automation) {
  return {
    projectId: project.id,
    repoPath: project.repoPath,
    githubRepo: project.githubRepo,
    baseBranch: project.baseBranch,
    worktreeRoot: project.worktreeRoot || "",
    checkCommand: project.checkCommand || "git diff --check",
    workerInstructions: project.workerInstructions || "",
    workerLaunchPolicy: project.workerLaunchPolicy || "",
    readyLabel: project.labels.ready,
    implementLabel: project.labels.implement,
    inProgressLabel: project.labels.inProgress,
    blockedLabel: project.labels.blocked,
    reviewLabel: project.labels.review,
    reviewingLabel: project.labels.reviewing,
    humanLabel: project.labels.human,
    needsInfoLabel: project.labels.needsInfo,
    wontfixLabel: project.labels.wontfix,
    needsTriageLabel: project.labels.needsTriage,
    automationId: automation.id,
    automationName: automation.name,
    automationDir: AUTOMATION_DIR,
  };
}

function renderTemplate(text, values) {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => {
    const value = values[key];
    return value == null ? "" : String(value);
  });
}

function readPrompt(project, automation) {
  const template = fs.readFileSync(path.join(AUTOMATION_DIR, automation.promptFile), "utf8");
  return renderTemplate(template, templateValues(project, automation));
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
