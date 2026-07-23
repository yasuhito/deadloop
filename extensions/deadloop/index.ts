import childProcess from "node:child_process";
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
import { buildStatusSnapshot, formatStatusReport } from "../../src/status";
import { readClaudeConfig } from "../../src/agent-trust.cjs";
import { runScheduledAutomation } from "../../src/automation-runner";
const { createAsyncHerdrRunner } = require("../../src/herdr-runner.ts");
const { acquireLock, releaseOwned } = require("../../src/enablement-lock.cjs");
const {
  acquireSchedulerLock: acquireSchedulerFileLock,
  releaseSchedulerLock: releaseSchedulerFileLock,
} = require("../../src/scheduler-lock.cjs");
import { inferredProjectId, schedulerLockName } from "../../src/project-identity";
import {
  findEnabledProject,
  isEnabledProjectState,
  normalizeEnablementState,
  observeAutoMerge,
  removeEnabledProject,
  removeEnabledProjectAtPath,
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

function trustedRepoPolicyProvider(project) {
  const repoPath = project.repoPath;
  if (!repoPath) return { status: "missing" as const };
  const baseBranch = project.baseBranch || "origin/main";

  const fetch = gitSync(repoPath, ["fetch", "--quiet"], 30_000);
  if (fetch.status !== 0) {
    const reason = (fetch.stderr || fetch.stdout || fetch.error?.message || "git fetch failed").trim();
    return { status: "error" as const, reason: `trusted repo policy fetch failed for ${baseBranch}: ${reason}` };
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

function implicitProjectFromCwd(cwd) {
  const repoPath = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (!repoPath) return null;
  const gitCommonDir = gitOutput(cwd, ["rev-parse", "--git-common-dir"]);
  if (!gitCommonDir || isLinkedGitWorktree(repoPath, gitCommonDir)) return null;
  const githubRepo = inferGithubRepo(repoPath);
  if (!githubRepo) return null;
  const id = inferredProjectId(repoPath, githubRepo);
  const raw = {
    id,
    enabled: true,
    repoPath,
    githubRepo,
    baseBranch: inferBaseBranch(repoPath),
    worktreeRoot: path.join(os.homedir(), ".herdr", "worktrees", id),
    autoMerge: false,
  };
  const policy = trustedRepoPolicyProvider(raw);
  if (policy.status === "error") return null;
  const result = parseProjectsConfig(JSON.stringify({ projects: [raw] }), projectFilter(), {
    configPath: `${repoPath}${path.sep}${REPO_POLICY_FILE}`,
    repoPolicyProvider: () => policy,
  });
  if (!result.ok) return null;
  return result.projects[0] || null;
}

function addImplicitProject(cwd, result) {
  if (!result.ok || !cwd) return result;
  const implicit = implicitProjectFromCwd(cwd);
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

function loadProjectsResult(cwd, options: { includeDisabled?: boolean } = {}) {
  let text;
  try {
    text = readConfigText();
  } catch (error) {
    return { ok: false, reason: `projects.json read error: ${error?.message || error}` };
  }
  const parsed = parseProjectsConfig(text, projectFilter(), {
    configPath: CONFIG_PATH,
    repoPolicyProvider: trustedRepoPolicyProvider,
  });
  const result = addImplicitProject(cwd, parsed);
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
  const result = loadProjectsResult(cwd, { includeDisabled: true });
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
  const implicit = implicitProjectFromCwd(cwd);
  if (!implicit || path.resolve(implicit.repoPath) !== repoPath || implicit.githubRepo !== identity.githubRepo) {
    throw new Error("repository configuration could not be resolved safely");
  }
  return implicit;
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

async function updateEnablementState(update) {
  const lockPath = `${ENABLEMENT_PATH}.lock`;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const lock = await acquireLock(lockPath, { busyMessage: "enablement state is busy; retry the command" });
  try {
    const next = await update(loadEnablementState());
    saveEnablementState(next);
    return next;
  } finally {
    releaseOwned(lockPath, lock.token);
  }
}

async function applyFirstEnableAutoMergeGate(project) {
  let forceAutoMergeOff = false;
  await updateEnablementState((state) => {
    const enabled = findEnabledProject(state, project);
    if (!enabled || enabled.firstEnableAutoMerge !== true || enabled.autoMergeAcknowledged) return state;

    const observed = observeAutoMerge(state, project, project.autoMerge);
    if (!findEnabledProject(observed, project)?.autoMergeAcknowledged) forceAutoMergeOff = true;
    return observed;
  });
  if (forceAutoMergeOff) project.autoMerge = false;
  return project;
}

function isProjectEnabled(project) {
  if (!project.repoPath || !project.githubRepo) return false;
  if (inferGithubRepo(project.repoPath) !== project.githubRepo) return false;
  return isEnabledProjectState(loadEnablementState(), { repoPath: project.repoPath, githubRepo: project.githubRepo });
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
  const env = { ...automationEnvironment(project, automation), DEADLOOP_STATE_DIR: STATE_DIR };
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

  const projectsResult = loadProjectsResult(cwd);
  const projects = projectsResult.ok ? projectsResult.projects : [];
  const state = loadState();
  const project = activeProject(cwd, projects);
  const warnings = statusWarnings(projectsResult.ok ? projectsResult.warnings : [projectsResult.reason], project);
  if (!project) {
    return { cwd, projects, state, warnings };
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

async function detectProjectIdentity(pi, cwd) {
  const repoPath = (await commandExec(pi, "git", ["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim();
  const commonDir = (await commandExec(pi, "git", ["-C", cwd, "rev-parse", "--git-common-dir"])).stdout.trim();
  if (isLinkedGitWorktree(repoPath, commonDir)) {
    throw new Error(`linked worktrees cannot be enabled; run /deadloop-enable from the primary checkout: ${path.dirname(path.resolve(repoPath, commonDir))}`);
  }
  const fetchRemotes = (await commandExec(pi, "git", ["-C", repoPath, "remote", "get-url", "--all", "origin"])).stdout.split(/\r?\n/).filter(Boolean);
  const pushRemotes = (await commandExec(pi, "git", ["-C", repoPath, "remote", "get-url", "--push", "--all", "origin"])).stdout.split(/\r?\n/).filter(Boolean);
  const identities = [...fetchRemotes, ...pushRemotes].map(githubRepoFromRemote);
  const uniqueIdentities = new Set(identities);
  if (identities.length === 0 || identities.some((identity) => !identity) || uniqueIdentities.size !== 1) {
    throw new Error("all origin fetch and push URLs must identify exactly the same GitHub repository");
  }
  const githubRepo = identities[0];
  const upstream = await pi.exec("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { timeout: 15_000 });
  const baseBranch = upstream.code === 0 ? upstream.stdout.trim() || "origin/main" : "origin/main";
  const id = inferredProjectId(repoPath, githubRepo);
  return { repoPath, githubRepo, baseBranch, id, worktreeRoot: path.join(os.homedir(), ".herdr", "worktrees", id) };
}

async function prepareGithub(pi, githubRepo) {
  await commandExec(pi, "gh", ["auth", "status"]);
  const view = JSON.parse((await commandExec(pi, "gh", ["repo", "view", githubRepo, "--json", "viewerPermission"])).stdout || "{}");
  if (!["ADMIN", "MAINTAIN", "WRITE"].includes(String(view.viewerPermission || "").toUpperCase())) {
    throw new Error("GitHub write permission is required to enable deadloop");
  }
  const labels = JSON.parse((await commandExec(pi, "gh", ["label", "list", "-R", githubRepo, "--limit", "1000", "--json", "name"])).stdout || "[]");
  const existing = new Set(labels.map((label) => label.name));
  for (const [name, color] of STANDARD_LABELS) {
    if (!existing.has(name)) await commandExec(pi, "gh", ["label", "create", name, "-R", githubRepo, "--color", color]);
  }
}
async function runAutomation(pi, ctx, project, automation, dueSlot, state) {
  await runScheduledAutomation(project, automation, dueSlot, state, {
    isEnabled: () => isProjectEnabled(project),
    isIdle: typeof ctx.isIdle === "function" ? () => ctx.isIdle() : undefined,
    notify: (message, level) => {
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
    saveState,
    sendUserMessage: (prompt) => pi.sendUserMessage(prompt),
    setStatus: (text) => setLooperStatus(ctx, text),
  });
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

  async function tick(ctx) {
    if (!active) return;

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
      setLooperStatus(ctx, "skipped: active project changed since scheduler lock was acquired");
      return;
    }
    if (running) return;
    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
    if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return;

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

  function stopScheduler(ctx) {
    if (timer) clearInterval(timer);
    if (startupTick) clearTimeout(startupTick);
    timer = null;
    startupTick = null;
    if (ownsLock && active?.lockPath && active?.lockToken) releaseSchedulerLock(active.lockPath, active.lockToken);
    ownsLock = false;
    active = null;
    setLooperStatus(ctx, undefined);
  }

  function startScheduler(ctx, project) {
    if (process.env.DEADLOOP === "off" || process.env.DEADLOOP_AUTOMATIONS === "off") return;
    if (active?.lockPath === projectLockPath(project)) return;
    stopScheduler(ctx);
    const lock = acquireSchedulerLock(project);
    ownsLock = lock.acquired;
    active = { project, lockPath: lock.lockPath, lockToken: lock.token };
    if (!ownsLock) {
      setLooperStatus(ctx, `${project.id} standby: owner pid ${lock.owner ?? "unknown"}`);
      return;
    }
    updateStatus(ctx, project, loadState());
    timer = setInterval(() => tick(ctx).catch((error) => console.warn(`[${EXTENSION_NAME}] tick failed:`, error?.message || error)), TICK_MS);
    timer.unref?.();
    startupTick = setTimeout(() => tick(ctx).catch((error) => console.warn(`[${EXTENSION_NAME}] startup tick failed:`, error?.message || error)), 3000);
    startupTick.unref?.();
  }

  pi.registerCommand("deadloop-enable", {
    description: "Enable deadloop locally for this primary Git checkout",
    handler: async (_args, ctx) => {
      try {
        const identity = await detectProjectIdentity(pi, ctx.cwd);
        const wasEnabled = Boolean(findEnabledProject(loadEnablementState(), identity));
        let configuredProject;
        try {
          configuredProject = resolveEnableProject(ctx.cwd, identity);
        } catch (error) {
          if (wasEnabled) await updateEnablementState((state) => removeEnabledProject(state, identity));
          throw error;
        }
        const firstEnable = {
          firstEnableAutoMerge: Boolean(configuredProject.autoMerge),
        };
        try {
          await prepareGithub(pi, identity.githubRepo);
        } catch (error) {
          if (wasEnabled) await updateEnablementState((state) => removeEnabledProject(state, identity));
          throw error;
        }
        await updateEnablementState((state) => {
          if (findEnabledProject(state, identity)) return state;
          return upsertEnabledProject(state, identity, Date.now(), firstEnable);
        });
        let project;
        try {
          const projects = loadProjects(ctx.cwd);
          project = await activeSchedulerProject(ctx.cwd, projects);
          if (!project) throw new Error("enabled repository configuration could not be resolved safely");
          startScheduler(ctx, project);
        } catch (error) {
          await updateEnablementState((state) => removeEnabledProject(state, identity));
          throw error;
        }
        const owner = ownsLock ? "this session" : `another session (pid ${readLock(projectLockPath(project))?.pid || "unknown"})`;
        const message = `deadloop enabled for ${identity.githubRepo}; scheduler owner: ${owner}. autoMerge is ${project.autoMerge ? "on (existing local setting preserved)" : "off"}.`;
        if (ctx.mode === "print" || ctx.mode === "json") console.log(message);
        else pi.sendMessage({ customType: "deadloop-enable", content: message, display: true });
      } catch (error) {
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
        let identity;
        try {
          identity = await detectProjectIdentity(pi, ctx.cwd);
        } catch {
          const repoPath = (await commandExec(pi, "git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"])).stdout.trim();
          const commonDir = (await commandExec(pi, "git", ["-C", ctx.cwd, "rev-parse", "--git-common-dir"])).stdout.trim();
          if (isLinkedGitWorktree(repoPath, commonDir)) {
            const primaryCheckout = path.dirname(path.resolve(ctx.cwd, commonDir));
            throw new Error(`linked worktrees cannot be disabled; run /deadloop-disable from the primary checkout: ${primaryCheckout}`);
          }
          await updateEnablementState((state) => removeEnabledProjectAtPath(state, repoPath));
          if (active?.project?.repoPath && path.resolve(active.project.repoPath) === path.resolve(repoPath)) stopScheduler(ctx);
          const message = "deadloop disabled for this checkout. Existing agents, GitHub state, worktrees, and run artifacts were left unchanged.";
          if (ctx.mode === "print" || ctx.mode === "json") console.log(message);
          else pi.sendMessage({ customType: "deadloop-disable", content: message, display: true });
          return;
        }
        await updateEnablementState((state) => removeEnabledProjectAtPath(removeEnabledProject(state, identity), identity.repoPath));
        if (active?.project?.githubRepo === identity.githubRepo && path.resolve(active.project.repoPath) === path.resolve(identity.repoPath)) stopScheduler(ctx);
        const message = `deadloop disabled for ${identity.githubRepo}. Existing agents, GitHub state, worktrees, and run artifacts were left unchanged.`;
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
