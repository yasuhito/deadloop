import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_TIMEZONE,
  REPO_POLICY_FILE,
  automationEnvironment,
  automationStateKey,
  codeFreshnessWarning,
  getDueSlot,
  isLinkedGitWorktree,
  nextSlotAfter,
  parseProjectsConfig,
  renderTemplate,
  resolveAutomationFile,
  resolveConfigPath,
  sanitizeId,
  templateValues,
} from "../../src/core";
import { buildDoctorSnapshot, formatDoctorReport } from "../../src/doctor";
import { buildStatusSnapshot, formatStatusReport, type RepositoryEnablement } from "../../src/status";
import { readClaudeConfig } from "../../src/agent-trust.cjs";
import { deliverPendingDriverHandoff, runScheduledAutomation } from "../../src/automation-runner";
const { createAsyncHerdrRunner } = require("../../src/herdr-runner.ts");
const { loadAutomationState, saveAutomationState } = require("../../src/automation-state.cjs");
const { acquireLock, releaseOwned } = require("../../src/enablement-lock.cjs");
const {
  DISABLE_LOCK_ATTEMPTS,
  DISABLE_LOCK_DELAY_MS,
} = require("../../src/driver-enablement.cjs");
const { assertEnabled, withEnabledProjectLock } = require("../../src/enabled-operation.cjs");
const {
  acquireSchedulerLock: acquireSchedulerFileLock,
  releaseSchedulerLock: releaseSchedulerFileLock,
} = require("../../src/scheduler-lock.cjs");
import { inferredProjectId, schedulerLockName } from "../../src/project-identity";
import {
  findEnabledProject,
  normalizeEnablementState,
  observeAutoMerge,
  removeEnabledProject,
  removeEnabledProjectAtPath,
  removeEnabledProjectAttempt,
  removeEnabledProjectGeneration,
  upsertEnabledProject,
} from "../../src/enablement";

const EXTENSION_NAME = "deadloop";
const STATUS_KEY = EXTENSION_NAME;
const TICK_MS = 30_000;
const MODULE_LOAD_TIME_MS = Date.now();

const CONFIG_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const STATE_DIR = path.join(CONFIG_DIR, EXTENSION_NAME);
const STATE_PATH = path.join(STATE_DIR, "state.json");
const ENABLEMENT_PATH = path.join(STATE_DIR, "enabled-projects.json");

function resolveExtensionDir() {
  const candidates = [
    process.env.DEADLOOP_EXTENSION_DIR,
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
const CODE_FRESHNESS_SOURCE_PATHS = [
  __filename,
  path.resolve(__dirname, "../../src/core.ts"),
  path.resolve(__dirname, "../../src/automation-runner.ts"),
];
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
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function debugLog(...args) {
  if (process.env.DEADLOOP_DEBUG === "1") {
    console.warn(`[${EXTENSION_NAME}]`, ...args);
  }
}

function readConfigText() {
  try {
    return fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "{}";
    throw error;
  }
}

function gitSync(repoPath, args, timeout = 30_000) {
  return childProcess.spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
  });
}

function trustedRepoPolicyProvider(project, options: { fetch?: boolean } = {}) {
  const repoPath = project.repoPath;
  if (!repoPath) return { status: "missing" as const };
  const baseBranch = project.baseBranch || "origin/main";

  if (options.fetch !== false) {
    const fetch = gitSync(repoPath, ["fetch", "--quiet"], 30_000);
    if (fetch.status !== 0) {
      const reason = (fetch.stderr || fetch.stdout || fetch.error?.message || "git fetch failed").trim();
      return { status: "error" as const, reason: `trusted repo policy fetch failed for ${baseBranch}: ${reason}` };
    }
  }

  const show = gitSync(repoPath, ["show", `${baseBranch}:${REPO_POLICY_FILE}`], 10_000);
  if (show.status === 0) return { status: "loaded" as const, text: show.stdout || "{}" };
  debugLog("trusted repo policy missing", repoPath, baseBranch, String(show.stderr || show.stdout || "").trim());
  return { status: "missing" as const };
}

function projectFilter() {
  return process.env.DEADLOOP_PROJECTS || "";
}

function gitOutput(repoPath, args, timeout = 10_000) {
  const result = gitSync(repoPath, args, timeout);
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function inferBaseBranch(repoPath) {
  return gitOutput(repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) || "origin/main";
}

function githubRepoFromRemote(remote) {
  const match = /^(?:git@github\.com:|https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(String(remote || ""));
  return match ? match[1] : "";
}

function inferGithubRepo(repoPath) {
  return githubRepoFromRemote(gitOutput(repoPath, ["remote", "get-url", "origin"]));
}

function implicitProjectFromCwd(cwd, options: { fetchPolicy?: boolean } = {}) {
  const repoPath = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (!repoPath) return null;
  const gitDir = gitOutput(cwd, ["rev-parse", "--git-dir"]);
  const gitCommonDir = gitOutput(cwd, ["rev-parse", "--git-common-dir"]);
  if (!gitDir || !gitCommonDir || isLinkedGitWorktree(cwd, gitDir, gitCommonDir)) return null;
  const enabledIdentity = loadEnablementState().projects.find((project) =>
    project.enabled !== false && path.resolve(project.repoPath) === path.resolve(repoPath)
  );
  const githubRepo = enabledIdentity?.githubRepo || inferGithubRepo(repoPath);
  if (!githubRepo) return null;
  const id = inferredProjectId(repoPath, githubRepo);
  const raw = {
    id,
    enabled: true,
    repoPath,
    githubRepo,
    baseBranch: enabledIdentity?.baseBranch || inferBaseBranch(repoPath),
    worktreeRoot: path.join(os.homedir(), ".herdr", "worktrees", id),
    autoMerge: false,
  };
  const policy = trustedRepoPolicyProvider(raw, { fetch: options.fetchPolicy });
  if (policy.status === "error") return null;
  const result = parseProjectsConfig(JSON.stringify({ projects: [raw] }), projectFilter(), {
    configPath: `${repoPath}${path.sep}${REPO_POLICY_FILE}`,
    repoPolicyProvider: () => policy,
  });
  if (!result.ok) return null;
  return result.projects[0] || null;
}

function addImplicitProject(cwd, result, options: { fetchPolicy?: boolean } = {}) {
  if (!result.ok || !cwd) return result;
  const implicit = implicitProjectFromCwd(cwd, options);
  if (!implicit || !isProjectEnabled(implicit)) return result;
  const implicitPath = path.resolve(implicit.repoPath || "");
  const duplicate = result.projects.some((project) => {
    if (!project.repoPath) return false;
    try {
      return path.resolve(project.repoPath) === implicitPath;
    } catch {
      return project.repoPath === implicit.repoPath;
    }
  });
  if (duplicate) return result;
  return { ...result, projects: [...result.projects, implicit] };
}

function overlayEnableIdentityDefaults(text, identity) {
  const config = JSON.parse(text || "{}");
  if (!Array.isArray(config?.projects)) return text;
  const repoPath = path.resolve(identity.repoPath);
  return JSON.stringify({
    ...config,
    projects: config.projects.map((project) => {
      try {
        if (path.resolve(project?.repoPath) !== repoPath || project?.githubRepo !== identity.githubRepo) return project;
      } catch {
        return project;
      }
      return {
        ...project,
        ...(Object.hasOwn(project, "baseBranch") ? {} : { baseBranch: identity.baseBranch }),
        ...(Object.hasOwn(project, "worktreeRoot") ? {} : { worktreeRoot: identity.worktreeRoot }),
      };
    }),
  });
}

function loadProjectsResult(
  cwd,
  options: {
    includeDisabled?: boolean;
    fetchPolicy?: boolean;
    enableIdentity?: { repoPath: string; githubRepo: string; baseBranch: string; worktreeRoot: string };
  } = {},
) {
  let text;
  try {
    text = readConfigText();
    let enableIdentity = options.enableIdentity;
    if (!enableIdentity && cwd) {
      const repoPath = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
      const enabled = loadEnablementState().projects.find((project) =>
        project.enabled !== false && path.resolve(project.repoPath) === path.resolve(repoPath)
      );
      if (enabled) {
        const id = inferredProjectId(repoPath, enabled.githubRepo);
        enableIdentity = {
          repoPath,
          githubRepo: enabled.githubRepo,
          baseBranch: enabled.baseBranch || inferBaseBranch(repoPath),
          worktreeRoot: path.join(os.homedir(), ".herdr", "worktrees", id),
        };
      }
    }
    if (enableIdentity) text = overlayEnableIdentityDefaults(text, enableIdentity);
  } catch (error) {
    return { ok: false, reason: `projects.json read error: ${error?.message || error}` };
  }
  const parsed = parseProjectsConfig(text, projectFilter(), {
    configPath: CONFIG_PATH,
    repoPolicyProvider: (project) => trustedRepoPolicyProvider(project, { fetch: options.fetchPolicy }),
  });
  const result = addImplicitProject(cwd, parsed, options);
  if (result.ok) {
    if (!options.includeDisabled) result.projects = result.projects.filter((project) => isProjectEnabled(project));
    debugLog(
      "config",
      CONFIG_PATH,
      "projects",
      result.projects.map((project) => project.id || project.repoPath),
    );
  } else {
    debugLog("config", CONFIG_PATH, result.reason);
  }
  return result;
}

function loadProjects(cwd) {
  const result = loadProjectsResult(cwd);
  if (!result.ok) throw new Error(result.reason);
  return result.projects;
}

function resolveEnableProject(cwd, identity) {
  const result = loadProjectsResult(cwd, { includeDisabled: true, enableIdentity: identity });
  if (!result.ok) throw new Error(result.reason);
  const repoPath = path.resolve(identity.repoPath);
  const configuredAtPath = result.projects.filter((project) => {
    try {
      return path.resolve(project.repoPath) === repoPath;
    } catch {
      return false;
    }
  });
  if (configuredAtPath.length > 0) {
    const exact = configuredAtPath.filter((project) => project.githubRepo === identity.githubRepo);
    if (exact.length !== 1 || configuredAtPath.length !== 1) {
      throw new Error("configured repository identity does not match the canonical checkout identity");
    }
    return exact[0];
  }
  const raw = { ...identity, enabled: true, autoMerge: false };
  const policy = trustedRepoPolicyProvider(raw);
  if (policy.status === "error") throw new Error(policy.reason);
  const implicit = parseProjectsConfig(JSON.stringify({ projects: [raw] }), projectFilter(), {
    configPath: `${repoPath}${path.sep}${REPO_POLICY_FILE}`,
    repoPolicyProvider: () => policy,
  });
  if (!implicit.ok || implicit.projects.length !== 1) {
    throw new Error("repository configuration could not be resolved safely");
  }
  return implicit.projects[0];
}

function loadEnablementState() {
  try {
    const text = fs.readFileSync(ENABLEMENT_PATH, "utf8");
    const state = normalizeEnablementState(JSON.parse(text));
    if (!state) throw new Error("schema is invalid");
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return { projects: [] };
    throw new Error(`enablement state is invalid at ${ENABLEMENT_PATH}: ${error?.message || error}. Inspect and move the file aside, then run /deadloop-enable again to recover.`);
  }
}

function saveEnablementState(state) {
  writeJsonFile(ENABLEMENT_PATH, state);
}

async function withEnablementStateLock(operation) {
  const lockPath = `${ENABLEMENT_PATH}.lock`;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const lock = await acquireLock(lockPath, {
    attempts: DISABLE_LOCK_ATTEMPTS,
    delayMs: DISABLE_LOCK_DELAY_MS,
    busyMessage: "enablement state is busy; retry the command",
  });
  try {
    return await operation();
  } finally {
    releaseOwned(lockPath, lock.token);
  }
}

async function updateEnablementState(update) {
  return await withEnablementStateLock(async () => {
    const next = await update(loadEnablementState());
    saveEnablementState(next);
    return next;
  });
}

async function applyFirstEnableAutoMergeGate(project) {
  let forceAutoMergeOff = false;
  let enabledAt;
  await updateEnablementState((state) => {
    const enabled = findEnabledProject(state, project);
    if (!enabled) return state;
    enabledAt = enabled.enabledAt;
    if (enabled.firstStartPending) forceAutoMergeOff = true;
    if (enabled.firstEnableAutoMerge !== true || enabled.autoMergeAcknowledged) return state;

    const observed = observeAutoMerge(state, project, project.autoMerge);
    if (!findEnabledProject(observed, project)?.autoMergeAcknowledged) forceAutoMergeOff = true;
    return observed;
  });
  if (enabledAt === undefined) return null;
  return { ...project, enabledAt, ...(forceAutoMergeOff ? { autoMerge: false } : {}) };
}

async function completeFirstSchedulerStart(project) {
  await updateEnablementState((state) => ({
    projects: state.projects.map((candidate) =>
      candidate.repoPath === path.resolve(project.repoPath)
      && candidate.githubRepo === project.githubRepo
      && candidate.enabledAt === project.enabledAt
        ? { ...candidate, firstStartPending: false }
        : candidate,
    ),
  }));
}

async function disableEnablementAttempt(identity, enabledAt, enableAttemptToken) {
  await updateEnablementState((state) => removeEnabledProjectAttempt(state, identity, enabledAt, enableAttemptToken));
}

async function rollbackFailedEnablementAttempt(identity, enabledAt, repoPath, enableAttemptToken) {
  await updateEnablementState((state) => ownsEnableAttempt(repoPath, enableAttemptToken)
    ? removeEnabledProjectGeneration(state, identity, enabledAt)
    : state);
}

function isProjectEnabled(project) {
  if (!project.repoPath || !project.githubRepo) return false;
  try {
    assertEnabled({ repoPath: project.repoPath, githubRepo: project.githubRepo, stateDir: STATE_DIR, enabledAt: project.enabledAt });
    return true;
  } catch {
    return false;
  }
}

function extensionCodeWarning() {
  const sources = [];
  for (const sourcePath of CODE_FRESHNESS_SOURCE_PATHS) {
    try {
      sources.push({ path: sourcePath, mtimeMs: fs.statSync(sourcePath).mtimeMs });
    } catch (error) {
      debugLog("code freshness stat failed", sourcePath, error?.message || error);
    }
  }
  return codeFreshnessWarning(MODULE_LOAD_TIME_MS, sources);
}

function ownsSchedulerLock(project, token = null) {
  const lock = readLock(projectLockPath(project));
  return Number(lock?.pid) === process.pid && (!token || lock?.token === token);
}

function statusWarnings(extraWarnings = [], project = null) {
  const freshnessWarning = project && ownsSchedulerLock(project) ? extensionCodeWarning() : null;
  return [freshnessWarning, ...extraWarnings].filter(Boolean);
}

function statusText(text) {
  return text;
}

function setLooperStatus(ctx, text) {
  try {
    ctx.ui.setStatus(STATUS_KEY, text == null ? undefined : statusText(text));
  } catch {}
}

function loadState() {
  return loadAutomationState(STATE_PATH);
}

function saveState(state) {
  try {
    return saveAutomationState(STATE_PATH, state);
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] failed to save state:`, error?.message || error);
    return state;
  }
}

function readLock(lockPath) {
  return readJsonFile(lockPath, null);
}

function projectLockPath(project) {
  return path.join(STATE_DIR, schedulerLockName(project));
}

function acquireSchedulerLock(project) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const lockPath = projectLockPath(project);
  return acquireSchedulerFileLock(lockPath, {
    cwd: process.cwd(),
    projectId: project.id,
    startedAt: Date.now(),
  });
}

function releaseSchedulerLock(lockPath, token) {
  try {
    releaseSchedulerFileLock(lockPath, token);
  } catch (error) {
    console.warn(`[${EXTENSION_NAME}] failed to release lock:`, error?.message || error);
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
  const nextTimes = project.automations
    .map((automation) => {
      const entry = state.automations[automationStateKey(project, automation)] || {};
      const next = nextSlotAfter(entry, automation, Date.now());
      return next ? `${automation.name.replace(new RegExp(`^${project.id}\\s+`), "")}: ${formatTime(next)}` : null;
    })
    .filter(Boolean);
  const suffix = nextTimes.length ? `${project.id} next ${nextTimes.join(" / ")}` : `${project.id} on`;
  setLooperStatus(ctx, suffix);
}

function activeProject(cwd, projects) {
  let resolvedCwd;
  try {
    resolvedCwd = path.resolve(cwd);
  } catch {
    resolvedCwd = cwd;
  }
  const project = projects.find((candidate) => {
    try {
      const repoPath = path.resolve(candidate.repoPath);
      const matches = resolvedCwd === repoPath || resolvedCwd.startsWith(`${repoPath}${path.sep}`);
      debugLog("project candidate", candidate.id, "repoPath", repoPath, "cwd", resolvedCwd, "matches", matches);
      return matches;
    } catch (error) {
      debugLog("project candidate error", candidate.id, error?.message || error);
      return cwd === candidate.repoPath;
    }
  });
  return project || null;
}

async function activeSchedulerProject(cwd, projects) {
  const project = activeProject(cwd, projects);
  return project ? await applyFirstEnableAutoMergeGate(project) : null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function resolveAutomationFileInDir(_kind, _automation, requested) {
  return resolveAutomationFile(requested, (fileName) => fs.existsSync(path.join(AUTOMATION_DIR, fileName)));
}

async function runAutomationScript(pi, project, automation, automationFile) {
  const scriptPath = path.join(AUTOMATION_DIR, automationFile);
  const env = {
    ...automationEnvironment(project, automation),
    DEADLOOP_STATE_DIR: STATE_DIR,
    DEADLOOP_ENABLED_AT: String(project.enabledAt),
  };
  const exports = Object.entries(env)
    .filter(([key]) => key.startsWith("DEADLOOP_"))
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  return await pi.exec("bash", ["-lc", `${exports} ${shellQuote(scriptPath)}`], {
    timeout: automation.precheckTimeoutSeconds * 1000,
  });
}

function readPrompt(project, automation, promptFile) {
  const template = fs.readFileSync(path.join(AUTOMATION_DIR, promptFile), "utf8");
  return renderTemplate(template, templateValues(project, automation, AUTOMATION_DIR));
}

async function execJson(pi, command, args, fallback, options: { timeout?: number } = {}) {
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

async function gitText(pi, args) {
  try {
    const result = await pi.exec("git", args, { timeout: 5_000 });
    if (result.code !== 0) return undefined;
    return result.stdout;
  } catch {
    return undefined;
  }
}

async function collectLiveSnapshotData(
  pi,
  cwd,
  options: { includeClosedPrs?: boolean; includeIssueComments?: boolean; includeAgents?: boolean } = {},
) {
  const includeClosedPrs = options.includeClosedPrs === true;
  const includeIssueComments = options.includeIssueComments === true;
  const includeAgents = options.includeAgents === true;

  const projectsResult = loadProjectsResult(cwd, { fetchPolicy: false });
  const projects = projectsResult.ok ? projectsResult.projects : [];
  const state = loadState();
  const project = activeProject(cwd, projects);
  const repositoryRoot = !project
    ? (await gitText(pi, ["-C", cwd, "rev-parse", "--show-toplevel"]))?.trim()
    : undefined;
  const repositoryEnablement: RepositoryEnablement = project ? "enabled" : repositoryRoot ? "disabled" : "unavailable";
  const diagnosticWarnings = projectsResult.ok
    ? [...projectsResult.warnings, ...(repositoryEnablement === "unavailable" ? ["current directory is not inside a Git repository"] : [])]
    : [projectsResult.reason, ...(repositoryEnablement === "unavailable" ? ["current directory is not inside a Git repository"] : [])];
  const warnings = statusWarnings(diagnosticWarnings, project);
  if (!project) {
    return { cwd, projects, state, repositoryEnablement, warnings };
  }

  const issueFields = includeIssueComments
    ? "number,title,labels,updatedAt,comments"
    : "number,title,labels,updatedAt";
  const issues = project.githubRepo
    ? await execJson(
        pi,
        "gh",
        [
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
        ],
        [],
      )
    : [];
  const openPrs = project.githubRepo
    ? await execJson(
        pi,
        "gh",
        [
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
        ],
        [],
      )
    : [];
  const mergedPrs = includeClosedPrs && project.githubRepo
    ? await execJson(
        pi,
        "gh",
        [
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
        ],
        [],
      )
    : [];
  const closedPrs = includeClosedPrs && project.githubRepo
    ? await execJson(
        pi,
        "gh",
        [
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
        ],
        [],
      )
    : [];

  const herdrRunner = createAsyncHerdrRunner({
    runJson: async (command, args) => await execJson(pi, command, args, null),
  });
  const worktrees = project.repoPath ? await herdrRunner.listWorktrees(project.repoPath) : [];
  const claudeConfig =
    project.workerAgent === "claude" ? readClaudeConfig() : undefined;
  const agents = includeAgents ? await herdrRunner.listAgents() : [];
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
    agents,
    gitStatuses,
    gitHeads,
    automationDir: AUTOMATION_DIR,
    statePath: STATE_PATH,
    claudeConfig,
    repositoryEnablement,
    warnings,
  };
}

async function buildLiveStatusReport(pi, cwd) {
  const data = await collectLiveSnapshotData(pi, cwd, { includeClosedPrs: true });
  return formatStatusReport(buildStatusSnapshot(data));
}

async function buildLiveDoctorReport(pi, cwd) {
  const data = await collectLiveSnapshotData(pi, cwd, { includeIssueComments: true, includeAgents: true });
  return formatDoctorReport(buildDoctorSnapshot(data));
}

const STANDARD_LABELS = [
  ["ready-for-agent", "0e8a16"],
  ["agent:implement", "1d76db"],
  ["agent:in-progress", "fbca04"],
  ["agent:review", "5319e7"],
  ["agent:reviewing", "c2e0c6"],
  ["agent:blocked", "b60205"],
  ["ready-for-human", "d93f0b"],
  ["needs-info", "fef2c0"],
  ["needs-triage", "f9d0c4"],
];

async function commandExec(pi, command, args, timeout = 15_000) {
  const result = await pi.exec(command, args, { timeout });
  if (result.code !== 0) throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
  return result;
}

function findCheckoutPointingToGitDir(commonDir) {
  const absoluteCommonDir = path.resolve(commonDir);
  try {
    for (const entry of fs.readdirSync(path.dirname(absoluteCommonDir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const checkout = path.join(path.dirname(absoluteCommonDir), entry.name);
      const gitFile = path.join(checkout, ".git");
      if (!fs.existsSync(gitFile) || !fs.statSync(gitFile).isFile()) continue;
      const match = /^gitdir: (.+)$/m.exec(fs.readFileSync(gitFile, "utf8"));
      if (match && path.resolve(checkout, match[1]) === absoluteCommonDir) return checkout;
    }
  } catch {}
  return "";
}

async function detectPrimaryCheckout(pi, cwd) {
  const repoPath = (await commandExec(pi, "git", ["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim();
  const gitDir = (await commandExec(pi, "git", ["-C", cwd, "rev-parse", "--git-dir"])).stdout.trim();
  const commonDir = (await commandExec(pi, "git", ["-C", cwd, "rev-parse", "--git-common-dir"])).stdout.trim();
  if (isLinkedGitWorktree(cwd, gitDir, commonDir)) {
    const configuredWorktree = await pi.exec("git", ["-C", cwd, "config", "--path", "--get", "core.worktree"], { timeout: 15_000 });
    const worktreeList = (await commandExec(pi, "git", ["-C", cwd, "worktree", "list", "--porcelain"])).stdout;
    const primaryCheckout = configuredWorktree.code === 0
      ? configuredWorktree.stdout.trim()
      : findCheckoutPointingToGitDir(path.resolve(cwd, commonDir)) || worktreeList.match(/^worktree (.+)$/m)?.[1];
    if (!primaryCheckout) throw new Error("linked worktree primary checkout could not be resolved");
    throw new Error(`linked worktrees cannot be enabled or disabled; use the primary checkout: ${primaryCheckout}`);
  }
  return repoPath;
}

function enableAttemptPath(repoPath) {
  const key = crypto.createHash("sha256").update(path.resolve(repoPath)).digest("hex").slice(0, 24);
  return path.join(STATE_DIR, `enable-attempt-${key}.json`);
}

function writeEnableAttempt(repoPath, token, cancelled = false) {
  writeJsonFile(enableAttemptPath(repoPath), { repoPath: path.resolve(repoPath), token, cancelled });
}

function ownsEnableAttempt(repoPath, token) {
  const attempt = readJsonFile(enableAttemptPath(repoPath), null);
  return attempt?.repoPath === path.resolve(repoPath) && attempt?.token === token && attempt?.cancelled !== true;
}

function finishEnableAttempt(repoPath, token) {
  const attemptPath = enableAttemptPath(repoPath);
  const attempt = readJsonFile(attemptPath, null);
  if (attempt?.token === token) fs.rmSync(attemptPath, { force: true });
}

async function revalidateLocalProjectIdentity(pi, identity) {
  const repoPath = await detectPrimaryCheckout(pi, identity.repoPath);
  if (path.resolve(repoPath) !== path.resolve(identity.repoPath)) throw new Error("repository checkout identity changed during enablement");
  const fetchRemotes = (await commandExec(pi, "git", ["-C", repoPath, "remote", "get-url", "--all", "origin"], 5_000)).stdout.split(/\r?\n/).filter(Boolean);
  const pushRemotes = (await commandExec(pi, "git", ["-C", repoPath, "remote", "get-url", "--push", "--all", "origin"], 5_000)).stdout.split(/\r?\n/).filter(Boolean);
  const identities = [...fetchRemotes, ...pushRemotes].map(githubRepoFromRemote);
  if (identities.length === 0 || identities.some((candidate) => !candidate)) {
    throw new Error("origin identity changed during enablement");
  }
  for (const remoteIdentity of new Set(identities)) {
    const view = JSON.parse(
      (await commandExec(pi, "gh", ["repo", "view", remoteIdentity, "--json", "id"])).stdout || "{}",
    );
    if (!view.id || String(view.id) !== identity.githubRepositoryId) {
      throw new Error("origin GitHub repository identity changed during enablement");
    }
  }
}

async function detectProjectIdentity(pi, cwd) {
  const repoPath = await detectPrimaryCheckout(pi, cwd);
  const fetchRemotes = (await commandExec(pi, "git", ["-C", repoPath, "remote", "get-url", "--all", "origin"])).stdout.split(/\r?\n/).filter(Boolean);
  const pushRemotes = (await commandExec(pi, "git", ["-C", repoPath, "remote", "get-url", "--push", "--all", "origin"])).stdout.split(/\r?\n/).filter(Boolean);
  const identities = [...fetchRemotes, ...pushRemotes].map(githubRepoFromRemote);
  if (identities.length === 0 || identities.some((identity) => !identity)) {
    throw new Error("all origin fetch and push URLs must identify GitHub repositories");
  }
  const canonicalIdentities = new Set<string>();
  const repositoryIds = new Set<string>();
  const defaultBranches = new Set<string>();
  for (const remoteIdentity of new Set(identities)) {
    const view = JSON.parse(
      (await commandExec(pi, "gh", ["repo", "view", remoteIdentity, "--json", "id,nameWithOwner,defaultBranchRef"])).stdout || "{}",
    );
    if (!view.id || !view.nameWithOwner) throw new Error(`GitHub repository identity could not be resolved for ${remoteIdentity}`);
    repositoryIds.add(String(view.id));
    canonicalIdentities.add(String(view.nameWithOwner));
    if (view.defaultBranchRef?.name) defaultBranches.add(String(view.defaultBranchRef.name));
  }
  if (canonicalIdentities.size !== 1 || repositoryIds.size !== 1) {
    throw new Error("all origin fetch and push URLs must resolve to exactly the same GitHub repository");
  }
  const githubRepo = [...canonicalIdentities][0];
  const githubRepositoryId = [...repositoryIds][0];
  const upstream = await pi.exec("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { timeout: 15_000 });
  let baseBranch = upstream.code === 0 ? upstream.stdout.trim() : "";
  if (!baseBranch.startsWith("origin/")) {
    if (defaultBranches.size !== 1) throw new Error("GitHub default branch could not be resolved unambiguously");
    const defaultBranch = [...defaultBranches][0];
    await commandExec(pi, "git", [
      "-C",
      repoPath,
      "fetch",
      "--quiet",
      "origin",
      `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
    ], 30_000);
    baseBranch = `origin/${defaultBranch}`;
  }
  await commandExec(pi, "git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", `${baseBranch}^{commit}`]);
  const id = inferredProjectId(repoPath, githubRepo);
  return {
    repoPath,
    githubRepo,
    githubRepositoryId,
    githubAliases: [...new Set(identities)],
    baseBranch,
    id,
    worktreeRoot: path.join(os.homedir(), ".herdr", "worktrees", id),
  };
}

async function prepareGithub(pi, identity) {
  await commandExec(pi, "gh", ["auth", "status"]);
  const view = JSON.parse((await commandExec(pi, "gh", ["repo", "view", identity.githubRepo, "--json", "id,viewerPermission,nameWithOwner"])).stdout || "{}");
  if (view.nameWithOwner !== identity.githubRepo || String(view.id || "") !== identity.githubRepositoryId) {
    throw new Error("GitHub repository identity changed during enablement");
  }
  if (!["ADMIN", "MAINTAIN", "WRITE"].includes(String(view.viewerPermission || "").toUpperCase())) {
    throw new Error("GitHub write permission is required to enable deadloop");
  }
  for (const [name, color] of STANDARD_LABELS) {
    const lookup = await pi.exec("gh", ["api", "--silent", `repos/${identity.githubRepo}/labels/${encodeURIComponent(name)}`], { timeout: 15_000 });
    if (lookup.code === 0) continue;
    if (!/HTTP 404\b/.test(`${lookup.stderr || ""}\n${lookup.stdout || ""}`)) {
      throw new Error((lookup.stderr || lookup.stdout || `label lookup failed for ${name}`).trim());
    }
    await commandExec(pi, "gh", ["label", "create", name, "-R", identity.githubRepo, "--color", color]);
  }
}
function automationRunnerDeps(pi, ctx, project, isCurrentSchedulerRun = () => true) {
  return {
    currentEnabledAt: () => project.enabledAt,
    isEnabled: () => isCurrentSchedulerRun() && isProjectEnabled(project),
    isIdle: typeof ctx.isIdle === "function" ? () => ctx.isIdle() : undefined,
    notify: (message, level) => {
      if (!isCurrentSchedulerRun()) return;
      try {
        ctx.ui.notify(message.replace(/^deadloop /, `${EXTENSION_NAME} `), level);
      } catch {}
    },
    now: () => Date.now(),
    readPrompt,
    resolveAutomationFileInDir,
    runDriver: async (driverProject, driverAutomation, driverFile) =>
      await runAutomationScript(pi, driverProject, driverAutomation, driverFile),
    runPrecheck: async (precheckProject, precheckAutomation, precheckFile) =>
      await runAutomationScript(pi, precheckProject, precheckAutomation, precheckFile),
    saveState: (state) => {
      if (isCurrentSchedulerRun()) saveState(state);
    },
    sendUserMessage: (prompt) => {
      if (isCurrentSchedulerRun()) pi.sendUserMessage(prompt);
    },
    sendUserMessageIfEnabled: (prompt) => {
      if (!isCurrentSchedulerRun()) return false;
      try {
        return withEnabledProjectLock(
          { repoPath: project.repoPath, githubRepo: project.githubRepo, stateDir: STATE_DIR, enabledAt: project.enabledAt },
          () => (pi.sendUserMessage(prompt), true),
        );
      } catch (error) {
        if (error instanceof Error && error.message === "deadloop is disabled for this repository") return false;
        throw error;
      }
    },
    setStatus: (text) => {
      if (isCurrentSchedulerRun()) setLooperStatus(ctx, text);
    },
  };
}

async function runAutomation(pi, ctx, project, automation, dueSlot, state, deps = automationRunnerDeps(pi, ctx, project)) {
  await runScheduledAutomation(project, automation, dueSlot, state, deps);
}

function registerReportCommand(pi, name, description, customType, buildReport) {
  pi.registerCommand(name, {
    description,
    handler: async (_args, ctx) => {
      const report = await buildReport(pi, ctx.cwd);
      if (ctx.mode === "print" || ctx.mode === "json") {
        console.log(report);
      } else {
        pi.sendMessage({ customType, content: report, display: true });
      }
    },
  });
}

export default function (pi) {
  registerReportCommand(
    pi,
    "deadloop-status",
    "Show the active deadloop project, automations, GitHub queues, and Herdr worker worktrees",
    "deadloop-status",
    buildLiveStatusReport,
  );
  registerReportCommand(
    pi,
    "deadloop-doctor",
    "Diagnose known deadloop failure modes and show copy-paste recovery or inspection commands",
    "deadloop-doctor",
    buildLiveDoctorReport,
  );

  let timer = null;
  let running = false;
  let startupTick = null;
  let active = null;
  let ownsLock = false;
  let stopRequested = false;
  let pendingStart = null;

  async function tick(ctx) {
    if (!active) return;
    const schedulerRun = active;

    let remainsEnabled = false;
    try {
      remainsEnabled = isProjectEnabled(active.project);
    } catch (error) {
      debugLog("scheduler enablement check failed", error?.message || error);
    }
    if (!remainsEnabled) {
      stopScheduler(ctx);
      setLooperStatus(ctx, "deadloop is not enabled for this repository");
      return;
    }

    const projectsResult = loadProjectsResult(ctx.cwd);
    if (!projectsResult.ok) {
      setLooperStatus(ctx, `skipped: ${projectsResult.reason}`);
      return;
    }
    const project = await activeSchedulerProject(ctx.cwd, projectsResult.projects);
    if (!project) {
      stopScheduler(ctx);
      setLooperStatus(ctx, "deadloop is not enabled for this repository");
      return;
    }
    if (projectLockPath(project) !== active.lockPath) {
      stopScheduler(ctx);
      setLooperStatus(ctx, "skipped: active project identity changed since scheduler lock was acquired");
      return;
    }
    if (running) return;
    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
    if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return;

    running = true;
    try {
      const state = loadState();
      updateStatus(ctx, project, state);

      const deps = automationRunnerDeps(pi, ctx, project, () => active === schedulerRun && ownsLock && !stopRequested);
      for (const automation of project.automations) {
        const entry = state.automations[automationStateKey(project, automation)] || {};
        state.automations[automationStateKey(project, automation)] = entry;
        if (deliverPendingDriverHandoff(entry, state, automation.name, deps)) {
          if (active === schedulerRun && ownsLock && !stopRequested) saveState(state);
          return;
        }
      }

      const now = Date.now();
      for (const automation of project.automations) {
        const key = automationStateKey(project, automation);
        const entry = state.automations[key] || {};
        state.automations[key] = entry;
        const dueSlot = getDueSlot(automation, entry, now);
        if (!dueSlot) continue;

        await runAutomation(pi, ctx, project, automation, dueSlot, state, deps);
        if (active === schedulerRun && ownsLock && !stopRequested) updateStatus(ctx, project, state);
        break;
      }

      if (active === schedulerRun && ownsLock && !stopRequested) saveState(state);
    } finally {
      running = false;
      if (stopRequested) {
        const restart = pendingStart;
        finishStoppingScheduler(ctx);
        if (restart) startScheduler(restart.ctx, restart.project);
      }
    }
  }

  function finishStoppingScheduler(ctx) {
    if (ownsLock && active?.lockPath && active?.lockToken) releaseSchedulerLock(active.lockPath, active.lockToken);
    ownsLock = false;
    active = null;
    stopRequested = false;
    pendingStart = null;
    setLooperStatus(ctx, undefined);
  }

  function stopScheduler(ctx) {
    if (timer) clearInterval(timer);
    if (startupTick) clearTimeout(startupTick);
    timer = null;
    startupTick = null;
    pendingStart = null;
    if (running) {
      stopRequested = true;
      setLooperStatus(ctx, undefined);
      return;
    }
    finishStoppingScheduler(ctx);
  }

  function startScheduler(ctx, project) {
    if (process.env.DEADLOOP === "off") {
      return { started: false, reason: "scheduler startup is suppressed by DEADLOOP=off" };
    }
    if (process.env.DEADLOOP_AUTOMATIONS === "off") {
      return { started: false, reason: "scheduler startup is suppressed by DEADLOOP_AUTOMATIONS=off" };
    }
    if (!isProjectEnabled(project)) {
      stopScheduler(ctx);
      setLooperStatus(ctx, "deadloop is not enabled for this repository");
      return { started: false, reason: "repository enablement was not retained before scheduler startup" };
    }
    const lockPath = projectLockPath(project);
    if (stopRequested) {
      pendingStart = { ctx, project };
      return { started: true };
    }
    if (active?.lockPath === lockPath && ownsLock) {
      active.project = project;
      return { started: true };
    }
    stopScheduler(ctx);
    if (running) {
      pendingStart = { ctx, project };
      return { started: true };
    }
    const lock = acquireSchedulerLock(project);
    ownsLock = lock.acquired;
    active = { project, lockPath: lock.lockPath, lockToken: lock.token };
    if (!ownsLock) {
      setLooperStatus(ctx, `${project.id} standby: owner pid ${lock.owner ?? "unknown"}`);
      timer = setInterval(() => startScheduler(ctx, project), TICK_MS);
      timer.unref?.();
      return { started: true };
    }
    updateStatus(ctx, project, loadState());
    timer = setInterval(() => tick(ctx).catch((error) => console.warn(`[${EXTENSION_NAME}] tick failed:`, error?.message || error)), TICK_MS);
    timer.unref?.();
    startupTick = setTimeout(() => tick(ctx).catch((error) => console.warn(`[${EXTENSION_NAME}] startup tick failed:`, error?.message || error)), 3000);
    startupTick.unref?.();
    return { started: true };
  }

  pi.registerCommand("deadloop-enable", {
    description: "Enable deadloop locally for this primary Git checkout",
    handler: async (_args, ctx) => {
      let primaryRepoPath;
      let identity;
      let previousEnabledAt;
      let enablementSaved = false;
      const enableAttemptToken = crypto.randomUUID();
      try {
        let enabledAt;
        primaryRepoPath = await detectPrimaryCheckout(pi, ctx.cwd);
        writeEnableAttempt(primaryRepoPath, enableAttemptToken);
        identity = await detectProjectIdentity(pi, primaryRepoPath);
        previousEnabledAt = await withEnablementStateLock(async () => findEnabledProject(loadEnablementState(), identity)?.enabledAt);
        const configuredProject = resolveEnableProject(ctx.cwd, identity);
        const firstEnable = { firstEnableAutoMerge: Boolean(configuredProject.autoMerge) };
        await prepareGithub(pi, identity);
        await withEnablementStateLock(async () => {
          if (!ownsEnableAttempt(primaryRepoPath, enableAttemptToken)) {
            throw new Error("enablement was revoked while preflight was running");
          }
          await revalidateLocalProjectIdentity(pi, identity);
          const next = upsertEnabledProject(loadEnablementState(), identity, Date.now(), firstEnable, enableAttemptToken);
          enabledAt = findEnabledProject(next, identity)?.enabledAt;
          saveEnablementState(next);
          enablementSaved = true;
        });
        finishEnableAttempt(primaryRepoPath, enableAttemptToken);
        let project;
        try {
          await pi.testing?.afterEnablementSaved?.();
          const projects = loadProjects(ctx.cwd);
          project = await activeSchedulerProject(ctx.cwd, projects);
          if (!project) throw new Error("enabled repository configuration could not be resolved safely");
          const schedulerStart = startScheduler(ctx, project);
          if (!schedulerStart.started) throw new Error(schedulerStart.reason);
          await completeFirstSchedulerStart(project);
        } catch (error) {
          await disableEnablementAttempt(identity, enabledAt, enableAttemptToken);
          throw error;
        }
        const owner = ownsLock ? "this session" : `another session (pid ${readLock(projectLockPath(project))?.pid || "unknown"})`;
        const message = `deadloop enabled for ${identity.githubRepo}; scheduler owner: ${owner}. autoMerge is ${project.autoMerge ? "on (existing local setting preserved)" : "off"}.`;
        if (ctx.mode === "print" || ctx.mode === "json") console.log(message);
        else pi.sendMessage({ customType: "deadloop-enable", content: message, display: true });
      } catch (error) {
        if (!enablementSaved && identity && previousEnabledAt !== undefined && primaryRepoPath) {
          await rollbackFailedEnablementAttempt(identity, previousEnabledAt, primaryRepoPath, enableAttemptToken);
        }
        if (primaryRepoPath) finishEnableAttempt(primaryRepoPath, enableAttemptToken);
        const message = `deadloop was not enabled: ${error?.message || error}`;
        if (ctx.mode === "print" || ctx.mode === "json") console.log(message);
        else pi.sendMessage({ customType: "deadloop-enable", content: message, display: true });
      }
    },
  });

  pi.registerCommand("deadloop-disable", {
    description: "Disable local deadloop scheduling for this repository without stopping active agents",
    handler: async (_args, ctx) => {
      try {
        let message;
        const repoPath = await detectPrimaryCheckout(pi, ctx.cwd);
        const attemptPath = enableAttemptPath(repoPath);
        const attempt = readJsonFile(attemptPath, null);
        if (attempt?.repoPath === path.resolve(repoPath) && attempt?.token) {
          writeEnableAttempt(repoPath, attempt.token, true);
        }
        await withEnablementStateLock(async () => {
          const state = loadEnablementState();
          const enabled = state.projects.find((project) => project.repoPath === path.resolve(repoPath) && project.enabled !== false);
          saveEnablementState(removeEnabledProjectAtPath(state, repoPath));
          if (active?.project?.repoPath && path.resolve(active.project.repoPath) === path.resolve(repoPath)) stopScheduler(ctx);
          message = enabled
            ? `deadloop disabled for ${enabled.githubRepo}. Existing agents, GitHub state, worktrees, and run artifacts were left unchanged.`
            : "deadloop disabled for this checkout. Existing agents, GitHub state, worktrees, and run artifacts were left unchanged.";
        });
        if (ctx.mode === "print" || ctx.mode === "json") console.log(message);
        else pi.sendMessage({ customType: "deadloop-disable", content: message, display: true });
      } catch (error) {
        const message = `deadloop was not disabled: ${error?.message || error}`;
        if (ctx.mode === "print" || ctx.mode === "json") console.log(message);
        else pi.sendMessage({ customType: "deadloop-disable", content: message, display: true });
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode === "print" || ctx.mode === "json") return;
    try {
      const project = await activeSchedulerProject(ctx.cwd, loadProjects(ctx.cwd));
      debugLog("session_start", "cwd", ctx.cwd, "mode", ctx.mode, "project", project?.id || null);
      if (project) startScheduler(ctx, project);
    } catch (error) {
      setLooperStatus(ctx, `skipped: ${error?.message || error}`);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => stopScheduler(ctx));
}
