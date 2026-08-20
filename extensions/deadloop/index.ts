import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { reconcileAndSelectDueAutomation } from "../../src/automation-scheduler";
import { ensureCodeSnapshot } from "../../src/code-snapshot";
import {
  DEFAULT_TIMEZONE,
  REPO_POLICY_FILE,
  automationEnvironment,
  automationStateKey,
  authorizeAutomationLogin,
  codeFreshnessWarning,
  isLinkedGitWorktree,
  nextSlotAfter,
  parseProjectsConfig,
  renderTemplate,
  resolveAutomationFile,
  resolveConfigPath,
  sanitizeId,
  templateValues,
} from "../../src/core";
import { buildDoctorSnapshot, formatDoctorReport, herdrDoctorFinding } from "../../src/doctor";
import { herdrVersionDiagnosticData, parseHerdrVersions } from "../../src/herdr-version";
import { herdrServerIsUnreachableWithSupportedClient, runHerdrPreflight } from "../../src/herdr-preflight";
import { discoverVerificationCandidates } from "../../src/required-verification";
import { buildStatusSnapshot, formatStatusReport, type RepositoryEnablement } from "../../src/status";
import { readClaudeConfig } from "../../src/agent-trust.cjs";
import {
  deliverPendingDriverHandoff,
  isPendingIssueHandoffEligible,
  runScheduledAutomation,
} from "../../src/automation-runner";
const { hasUncommittedWork, UNCOMMITTED_WORK_STATUS_ARGS } = require("../../src/agent-scratch-area.cjs");
const { createAsyncHerdrRunner } = require("../../src/herdr-runner.cts");
const { observeAttemptLiveness } = require("../../src/attempt-runtime-observation.cts");
const {
  agentOccupiesAttemptWorkspace,
  readWorkspaceCloseStartedReceipt,
  workspaceProof,
} = require("./automations/abandon-launch-failed-attempt.cts");
const { readAttemptRecord, releasesAttemptOwnership, validateCompletionReportBinding } = require("../../src/attempt-lifecycle-runtime.cjs");
const { decideReviewTransition } = require("../../src/reviewer-outcome-contract.cts");
const {
  defaultIssueDecisionConfig,
  issueBlockedByNumbers,
  liveDependencyState,
  selectIssueForImplementation,
} = require("./automations/issue-coordinator-decisions.cts");
const { loadAutomationState, saveAutomationState } = require("../../src/automation-state.cjs");
const { acquireLock, releaseOwned } = require("../../src/enablement-lock.cjs");
const {
  DISABLE_LOCK_ATTEMPTS,
  DISABLE_LOCK_DELAY_MS,
} = require("../../src/driver-enablement.cjs");
const { assertEnabled, withEnabledProjectLock } = require("../../src/enabled-operation.cjs");
const {
  advanceDisableGeneration,
  disableGenerationForRepo,
  loadDisableGenerations,
} = require("../../src/disable-generation.cjs");
const {
  acquireSchedulerLock: acquireSchedulerFileLock,
  preflightSchedulerLockCapability,
  releaseSchedulerLock: releaseSchedulerFileLock,
} = require("../../src/scheduler-lock.cjs");
import { inferredProjectId, schedulerLockName } from "../../src/project-identity";
import {
  inspectRetainedEnablementVerifications,
  runEnablementVerification,
} from "../../src/enablement-verification";
type RetainedProjectCheckFailure = {
  attemptId?: string;
  worktreePath: string;
  quarantinePath: string;
  message: string;
  recordPath: string;
  attemptRecordPath?: string;
};
const { inspectRetainedProjectCheckFailures, inspectUnresolvedProjectCheckFailures } = require("../../src/project-check.cts") as {
  inspectRetainedProjectCheckFailures: (stateDir: string, project?: { id: string; githubRepo: string }) => RetainedProjectCheckFailure[];
  inspectUnresolvedProjectCheckFailures: (stateDir: string) => RetainedProjectCheckFailure[];
};
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
import { preserveEnablementAutomationLogins } from "../../src/enablement-write";

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
const AUTOMATION_DIR = path.join(EXTENSION_DIR, "automations");
const PACKAGE_ROOT = path.resolve(__dirname, "../..");
const LOADED_CODE_IDENTITY = gitOutput(PACKAGE_ROOT, ["rev-parse", "HEAD^{commit}"]);
if (!/^[0-9a-f]{40}$/i.test(LOADED_CODE_IDENTITY)) {
  throw new Error("deadloop could not resolve its load-time code identity");
}

function currentConfigPath() {
  return resolveConfigPath({
    env: process.env,
    stateDir: STATE_DIR,
    extensionDir: EXTENSION_DIR,
    exists: fs.existsSync,
    joinPath: path.join,
  });
}

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
  const configPath = currentConfigPath();
  try {
    return { text: fs.readFileSync(configPath, "utf8"), configPath };
  } catch (error) {
    if (error?.code === "ENOENT") return { text: "{}", configPath };
    throw error;
  }
}

function herdrPreflight() {
  return runHerdrPreflight({
    run: (command, args) => {
      const result = childProcess.spawnSync(command, args, {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${command} failed`).trim());
      return result.stdout || "";
    },
  });
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

  const revision = gitSync(repoPath, ["rev-parse", `${baseBranch}^{commit}`], 10_000);
  if (revision.status !== 0) {
    const reason = (revision.stderr || revision.stdout || revision.error?.message || "git rev-parse failed").trim();
    return { status: "error" as const, reason: `trusted base revision resolution failed for ${baseBranch}: ${reason}` };
  }
  const baseRevision = String(revision.stdout || "").trim();
  const show = gitSync(repoPath, ["show", `${baseRevision}:${REPO_POLICY_FILE}`], 10_000);
  if (show.status === 0) return { status: "loaded" as const, text: show.stdout || "{}", baseRevision };
  debugLog("trusted repo policy missing", repoPath, baseBranch, String(show.stderr || show.stdout || "").trim());
  return { status: "missing" as const, baseRevision };
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
  let configPath;
  try {
    ({ text, configPath } = readConfigText());
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
    configPath,
    repoPolicyProvider: (project) => trustedRepoPolicyProvider(project, { fetch: options.fetchPolicy }),
  });
  const result = addImplicitProject(cwd, parsed, options);
  if (result.ok) {
    const enablement = loadEnablementState();
    if (!options.enableIdentity) {
      const baseBranchChanged = result.projects.some((project) => {
        const enabled = enablement.projects.find((candidate) =>
          candidate.repoPath === path.resolve(project.repoPath || "")
          && candidate.githubRepo === project.githubRepo
          && candidate.enabled !== false
        );
        return Boolean(enabled?.baseBranch && enabled.baseBranch !== project.baseBranch);
      });
      if (baseBranchChanged) {
        return { ok: false, reason: "configured base branch changed since enablement; run /deadloop-enable to authorize it" };
      }
    }
    result.projects = result.projects.map((project) => {
      const enabled = enablement.projects.find((candidate) =>
        candidate.repoPath === path.resolve(project.repoPath || "")
        && candidate.githubRepo === project.githubRepo
        && candidate.enabled !== false
      );
      return enabled
        ? authorizeAutomationLogin({ ...project, githubRepositoryId: enabled.githubRepositoryId }, enabled.automationLogin)
        : project;
    });
    if (!options.includeDisabled) result.projects = result.projects.filter((project) => isProjectEnabled(project));
    debugLog(
      "config",
      configPath,
      "projects",
      result.projects.map((project) => project.id || project.repoPath),
    );
  } else {
    debugLog("config", configPath, result.reason);
  }
  return result;
}

function loadProjects(cwd) {
  const result = loadProjectsResult(cwd);
  if (!result.ok) throw new Error(result.reason);
  return result.projects;
}

function requiredVerificationMatches(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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
  let previous = null;
  try {
    previous = JSON.parse(fs.readFileSync(ENABLEMENT_PATH, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") debugLog("enablement preservation read failed", error?.message || error);
  }
  writeJsonFile(ENABLEMENT_PATH, preserveEnablementAutomationLogins(previous, state));
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

function firstEnableAutoMergeGate(state, project) {
  const enabled = findEnabledProject(state, project);
  if (!enabled) return { state, project: null };

  let observed = state;
  let forceAutoMergeOff = enabled.firstStartPending;
  if (enabled.firstEnableAutoMerge === true && !enabled.autoMergeAcknowledged) {
    observed = observeAutoMerge(state, project, project.autoMerge);
    if (!findEnabledProject(observed, project)?.autoMergeAcknowledged) forceAutoMergeOff = true;
  }
  return {
    state: observed,
    project: { ...project, enabledAt: enabled.enabledAt, ...(forceAutoMergeOff ? { autoMerge: false } : {}) },
  };
}

async function applyFirstEnableAutoMergeGate(project) {
  let effectiveProject = null;
  await updateEnablementState((state) => {
    const gated = firstEnableAutoMergeGate(state, project);
    effectiveProject = gated.project;
    return gated.state;
  });
  return effectiveProject;
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

async function rollbackFailedEnablementAttempt(identity, enabledAt, repoPath, enableAttemptToken) {
  await updateEnablementState((state) => ownsEnableAttempt(repoPath, enableAttemptToken)
    ? removeEnabledProjectGeneration(state, identity, enabledAt)
    : state);
}

async function rollbackSavedEnablementAttempt(identity, enabledAt, enableAttemptToken, previousEnabledProject) {
  await updateEnablementState((state) => {
    const current = findEnabledProject(state, identity);
    if (current?.enabledAt !== enabledAt || current.enableAttemptToken !== enableAttemptToken) return state;
    if (!previousEnabledProject?.automationLogin) {
      return removeEnabledProjectAttempt(state, identity, enabledAt, enableAttemptToken);
    }
    return {
      projects: state.projects.map((project) => project === current ? previousEnabledProject : project),
    };
  });
}

function assertSavedAutomationAuthority(identity, expected) {
  const saved = findEnabledProject(loadEnablementState(), identity);
  if (
    saved?.enabledAt !== expected.enabledAt
    || saved.enableAttemptToken !== expected.enableAttemptToken
    || saved.automationLogin !== expected.automationLogin
    || saved.disableGeneration !== expected.disableGeneration
    || disableGenerationForRepo(loadDisableGenerations(STATE_DIR), identity.repoPath) !== expected.disableGeneration
  ) {
    throw new Error("automation authority changed after enablement was saved");
  }
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

function saveState(state, ownedAutomationKeys) {
  try {
    return saveAutomationState(STATE_PATH, state, ownedAutomationKeys);
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

function canonicalPath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function activeProject(cwd, projects) {
  const repositoryRoot = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  const gitDir = gitOutput(cwd, ["rev-parse", "--git-dir"]);
  const gitCommonDir = gitOutput(cwd, ["rev-parse", "--git-common-dir"]);
  if (!repositoryRoot || !gitDir || !gitCommonDir || isLinkedGitWorktree(cwd, gitDir, gitCommonDir)) {
    debugLog("active project rejected", cwd, "missing repository identity or linked worktree");
    return null;
  }
  const canonicalRoot = canonicalPath(repositoryRoot);
  const project = projects.find((candidate) => {
    try {
      const matches = canonicalPath(candidate.repoPath) === canonicalRoot;
      debugLog("project candidate", candidate.id, "repoPath", candidate.repoPath, "repositoryRoot", canonicalRoot, "matches", matches);
      return matches;
    } catch (error) {
      debugLog("project candidate error", candidate.id, error?.message || error);
      return false;
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

function resolveAutomationFileInDir(_kind, _automation, requested, supply) {
  const automationDir = supply.automationDir;
  return resolveAutomationFile(requested, (fileName) => fs.existsSync(path.join(automationDir, fileName)));
}

async function runAutomationScript(pi, project, automation, automationFile, supply) {
  const automationDir = supply.automationDir;
  const scriptPath = path.join(automationDir, automationFile);
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

function readPrompt(project, automation, promptFile, supply) {
  const automationDir = supply.automationDir;
  const template = fs.readFileSync(path.join(automationDir, promptFile), "utf8");
  return renderTemplate(template, templateValues(project, automation, automationDir));
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

function repositoryEnablementForRoot(repositoryRoot: string | undefined): RepositoryEnablement {
  if (!repositoryRoot) return "unavailable";
  const enabled = loadEnablementState().projects.find((project) =>
    project.enabled !== false && path.resolve(project.repoPath) === path.resolve(repositoryRoot)
  );
  if (!enabled) return "disabled";
  try {
    assertEnabled({
      repoPath: enabled.repoPath,
      githubRepo: enabled.githubRepo,
      stateDir: STATE_DIR,
      enabledAt: enabled.enabledAt,
    });
    return "enabled";
  } catch {
    return "disabled";
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
  const configuredProject = activeProject(cwd, projects);
  const project = configuredProject
    ? firstEnableAutoMergeGate(loadEnablementState(), configuredProject).project
    : null;
  const repositoryRoot = (await gitText(pi, ["-C", cwd, "rev-parse", "--show-toplevel"]))?.trim();
  const repositoryEnablement = repositoryEnablementForRoot(repositoryRoot);
  const diagnosticWarnings = projectsResult.ok
    ? [...projectsResult.warnings, ...(repositoryEnablement === "unavailable" ? ["current directory is not inside a Git repository"] : [])]
    : [projectsResult.reason, ...(repositoryEnablement === "unavailable" ? ["current directory is not inside a Git repository"] : [])];
  const warnings = statusWarnings(diagnosticWarnings, project);
  if (!project) {
    return { cwd, projects, state, repositoryEnablement, warnings, selectedProject: null };
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
          "number,title,labels,updatedAt,headRefName,headRefOid,isDraft",
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
  const workspaces = includeAgents ? await herdrRunner.listWorkspaces() : [];
  const gitStatuses = {};
  const gitHeads = {};
  for (const worktree of worktrees) {
    const worktreePath = String(worktree?.path || "");
    if (!worktreePath) continue;
    const status = await gitText(pi, ["-C", worktreePath, ...UNCOMMITTED_WORK_STATUS_ARGS]);
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
    workspaces,
    gitStatuses,
    gitHeads,
    automationDir: AUTOMATION_DIR,
    statePath: STATE_PATH,
    claudeConfig,
    repositoryEnablement,
    warnings,
    selectedProject: project,
  };
}

async function buildLiveStatusReport(pi, cwd) {
  const data = await collectLiveSnapshotData(pi, cwd, { includeClosedPrs: true });
  return formatStatusReport(buildStatusSnapshot(data));
}

function labelNames(item) {
  return new Set((item?.labels || []).map((label) => typeof label === "string" ? label : String(label?.name || "")));
}

function projectLabels(project) {
  const labels = project?.labels;
  if (!labels) throw new Error(`normalized labels are unavailable for project ${project?.id || "unknown"}`);
  return labels;
}

function launchFailedRecoveryGuidance(record, runDir, project, workspaces, agents, evidence) {
  const refuse = (reason) => ({ commands: [], detail: `manual review required: ${reason}` });
  if (!project || !["worker", "reviewer"].includes(record.role)) return refuse(`attempt role ${record.role} has no safe requeue policy`);
  if (record.lastSuccessfulPhase !== "workspace_opened" || !record.workspaceId || !record.tabId || !record.rootPaneId) {
    return refuse("the journal does not prove a fully identified workspace opened before agent start");
  }
  const workspace = workspaceProof(record, workspaces, readWorkspaceCloseStartedReceipt(runDir, record));
  if (!workspace.safe) return refuse(workspace.reason || "workspace ownership is not proven");
  if (agents.some((agent) => agentOccupiesAttemptWorkspace(agent, record))) {
    return refuse("an agent still owns the recorded pane or launch-unique name");
  }
  // The sentinel is not a status line, so an unavailable status counts as work and refuses.
  if (hasUncommittedWork(evidence?.gitStatuses?.[record.worktreePath] ?? "__unknown__")) {
    return refuse("the linked worktree is changed or its clean status is unavailable");
  }
  if (String(evidence?.gitHeads?.[record.worktreePath] || "").toLowerCase() !== record.inputRevision.head.toLowerCase()) {
    return refuse("the linked worktree HEAD does not match the recorded input revision");
  }
  const registered = (evidence?.worktrees || []).filter((worktree) => worktree.branch === record.branch
    && worktree.path && path.resolve(worktree.path) === path.resolve(record.worktreePath));
  if (registered.length !== 1) return refuse("the linked worktree is not uniquely retained by the configured repository");

  let entries = [];
  try { entries = fs.readdirSync(path.dirname(runDir)); } catch { return refuse("other attempt journals cannot be inspected"); }
  for (const entry of entries) {
    const candidateDir = path.join(path.dirname(runDir), entry);
    if (candidateDir === runDir || !fs.existsSync(path.join(candidateDir, "attempt.json"))) continue;
    let candidate;
    try { candidate = readAttemptRecord(candidateDir); }
    catch { return refuse("another attempt journal is malformed"); }
    if (candidate.project !== record.project || candidate.repository !== record.repository
      || releasesAttemptOwnership(candidate.phase)) continue;
    if (candidate.workspaceId === record.workspaceId
      || path.resolve(candidate.worktreePath) === path.resolve(record.worktreePath)) {
      return refuse("another nonterminal attempt owns the checkout");
    }
  }

  const configured = projectLabels(project);
  if (record.role === "worker") {
    const issue = (evidence?.issues || []).find((item) => Number(item.number) === record.target.number);
    const labels = labelNames(issue);
    if (!issue || !labels.has(configured.ready) || !labels.has(configured.inProgress) || labels.has(configured.implement)
      || labels.has(configured.blocked) || labels.has(configured.human)) {
      return refuse("the Issue no longer has the exact safe launch claim");
    }
  } else {
    const pr = (evidence?.openPrs || []).find((item) => Number(item.number) === record.target.number);
    const labels = labelNames(pr);
    if (!pr || pr.headRefName !== record.branch || String(pr.headRefOid || "").toLowerCase() !== record.inputRevision.head.toLowerCase()
      || !labels.has(configured.review) || !labels.has(configured.inProgress)
      || labels.has(configured.blocked) || labels.has(configured.human)) {
      return refuse("the pull request no longer has the exact safe launch claim and head");
    }
  }
  return { commands: [`/deadloop-abandon-attempt ${record.attemptId}`], detail: "safe abandonment and requeue prerequisites are currently proven" };
}

function retainedAttemptClaimSnapshot(project) {
  const runsDir = path.join(STATE_DIR, "runs");
  let runs = [];
  try { runs = fs.readdirSync(runsDir); } catch { return { claims: [], ownershipAmbiguous: false }; }
  const claims = [];
  let ownershipAmbiguous = false;
  for (const run of runs) {
    const runDir = path.join(runsDir, run);
    if (!fs.existsSync(path.join(runDir, "attempt.json"))) continue;
    try {
      const record = readAttemptRecord(runDir);
      if (record.project === project?.id && record.repository === project?.githubRepo
        && !releasesAttemptOwnership(record.phase)) claims.push(record.target);
    } catch {
      ownershipAmbiguous = true;
    }
  }
  return { claims, ownershipAmbiguous };
}

function retainedAttemptDoctorFindings(project, workspaces, agents = [], evidence = {}) {
  const runsDir = path.join(STATE_DIR, "runs");
  let runs = [];
  try { runs = fs.readdirSync(runsDir); } catch { return []; }
  const findings = [];
  for (const run of runs) {
    const runDir = path.join(runsDir, run);
    const attemptRecord = path.join(runDir, "attempt.json");
    let record;
    try { record = readAttemptRecord(runDir); }
    catch (error) {
      if (fs.existsSync(attemptRecord)) findings.push(herdrDoctorFinding(
        "malformed_journal",
        `attempt journal ${attemptRecord} is malformed: ${error instanceof Error ? error.message : String(error)}; manual review required before changing any claim label`,
      ));
      continue;
    }
    if (record.project !== project?.id || record.repository !== project?.githubRepo
      || releasesAttemptOwnership(record.phase)) continue;
    let status: import("../../src/doctor").HerdrDoctorStatus = "missing_report";
    let detail = `attempt ${record.attemptId} (${record.role}) is retained at phase ${record.phase}`;
    if (record.phase === "launch_failed") {
      status = "launch_failed";
      const guidance = launchFailedRecoveryGuidance(record, runDir, project, workspaces, agents, evidence);
      detail = `${detail}; ${guidance.detail}`;
      findings.push(herdrDoctorFinding(status, detail, guidance.commands));
      continue;
    }
    else if (record.phase === "github_persisted") status = "cleanup_pending";
    else {
      if (record.workspaceId) {
        const owned = workspaces.filter((workspace) => workspace.workspaceId === record.workspaceId);
        if (owned.length !== 1 || !owned[0].worktreePath
          || path.resolve(owned[0].worktreePath) !== path.resolve(record.worktreePath)) {
          status = "ownership_mismatch";
          detail = `attempt ${record.attemptId} cannot prove ownership of workspace ${record.workspaceId}`;
          findings.push(herdrDoctorFinding(status, detail));
          continue;
        }
      }
      if (!fs.existsSync(record.promiseFile)) {
        // The same judgment the authority reconciliation uses, so doctor never calls an agent that is
        // merely awaiting input a Worker that failed to report.
        const absent = observeAttemptLiveness({ listAgents: () => agents }, record).kind === "owner_absent";
        status = absent ? "missing_report" : "active";
      } else {
        let report;
        try { report = JSON.parse(fs.readFileSync(record.promiseFile, "utf8")); }
        catch {
          status = "malformed_report";
          findings.push(herdrDoctorFinding(status, detail));
          continue;
        }
        if (report?.schemaVersion !== 1) {
          status = "malformed_report";
          findings.push(herdrDoctorFinding(status, detail));
          continue;
        }
        try { report = validateCompletionReportBinding(record, report).report; }
        catch { status = "malformed_report"; findings.push(herdrDoctorFinding(status, detail)); continue; }
        if (report.status === "blocked") status = "blocked";
        else if (["agent_started", "report_received"].includes(record.phase)) status = "persistence_unconfirmed";
        else status = "active";
      }
    }
    findings.push(herdrDoctorFinding(status, detail));
  }
  return findings;
}

function shellCommandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function retainedVerificationReport(repositoryRoot: string | undefined): string {
  const retained = inspectRetainedEnablementVerifications(STATE_DIR, repositoryRoot);
  if (!retained.length) return "";
  const lines = ["", `Retained required-verification worktrees: ${retained.length}`];
  for (const item of retained) {
    const worktree = shellCommandArgument(item.worktreePath);
    const confirmation = item.primaryRepoPath
      ? `git -C ${shellCommandArgument(item.primaryRepoPath)} worktree list --porcelain && git -C ${worktree} rev-parse HEAD && git -C ${worktree} status --short --untracked-files=all --ignored`
      : `git -C ${worktree} rev-parse HEAD && git -C ${worktree} status --short --untracked-files=all --ignored`;
    lines.push(
      `- ${item.worktreePath}`,
      `  repository: ${item.repository}`,
      `  revision: ${item.targetRevision}`,
      `  reason: ${item.retentionReason}`,
      `  journal: ${item.journalPath}`,
      `  record: ${item.recordPath || "not written"}`,
      `  log: ${item.logPath || "not written"}`,
      `  confirm: ${confirmation}`,
    );
  }
  return lines.join("\n");
}

function renderRetainedProjectCheckReport(title: string, retained: RetainedProjectCheckFailure[]): string {
  if (!retained.length) return "";
  const lines = ["", `${title}: ${retained.length}`];
  for (const item of retained) {
    lines.push(
      `- attempt: ${item.attemptId || "unresolved"}`,
      `  worktree: ${item.worktreePath}`,
      `  quarantine: ${item.quarantinePath}`,
      `  reason: ${item.message}`,
      `  record: ${item.recordPath}`,
      `  attempt journal: ${item.attemptRecordPath || "not resolved"}`,
    );
  }
  return lines.join("\n");
}

function retainedProjectCheckReport(project): string {
  if (!project) return "";
  return renderRetainedProjectCheckReport(
    "Retained project-check artifacts",
    inspectRetainedProjectCheckFailures(STATE_DIR, project),
  );
}

function unresolvedProjectCheckReport(): string {
  return renderRetainedProjectCheckReport(
    "Unresolved retained project-check artifacts",
    inspectUnresolvedProjectCheckFailures(STATE_DIR),
  );
}

async function buildLiveDoctorReport(pi, cwd) {
  const data = await collectLiveSnapshotData(pi, cwd, { includeIssueComments: true, includeAgents: true });
  const retained = retainedAttemptClaimSnapshot(data.selectedProject);
  const snapshot = buildDoctorSnapshot({
    ...data,
    retainedClaims: retained.claims,
    retainedClaimOwnershipAmbiguous: retained.ownershipAmbiguous,
    ...(data.selectedProject?.repoPath && data.selectedProject.requiredVerification.status === "blocked"
      ? { verificationCandidates: discoverVerificationCandidates({ repositoryRoot: data.selectedProject.repoPath }) }
      : {}),
  });
  snapshot.findings.unshift(...retainedAttemptDoctorFindings(
    data.selectedProject,
    data.workspaces || [],
    data.agents || [],
    data,
  ));
  try {
    herdrPreflight();
  } catch (error) {
    snapshot.findings.unshift(herdrDoctorFinding(
      "unsupported",
      herdrVersionDiagnosticData({ probeFailure: error instanceof Error ? error.message : String(error) }),
    ));
  }
  const repositoryRoot = (await gitText(pi, ["-C", cwd, "rev-parse", "--show-toplevel"]))?.trim();
  return `${formatDoctorReport(snapshot)}${retainedVerificationReport(repositoryRoot)}${retainedProjectCheckReport(data.selectedProject)}${unresolvedProjectCheckReport()}`;
}

const STANDARD_LABELS = [
  ["ready-for-agent", "0e8a16"],
  ["agent:implement", "1d76db"],
  ["ready-for-human", "d93f0b"],
  ["wontfix", "ffffff"],
  ["needs-info", "fef2c0"],
  ["needs-triage", "f9d0c4"],
  ["agent:explore", "0052cc"],
  ["agent:review", "5319e7"],
  ["agent:update-branch", "006b75"],
  ["agent:in-progress", "fbca04"],
  ["agent:blocked", "b60205"],
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

async function detectPrimaryCheckout(pi, cwd, allowLinkedWorktree = false) {
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
    if (allowLinkedWorktree) return path.resolve(cwd, primaryCheckout);
    throw new Error(`linked worktrees cannot be enabled; use the primary checkout: ${primaryCheckout}`);
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
    baseBranch,
    id,
    worktreeRoot: path.join(os.homedir(), ".herdr", "worktrees", id),
  };
}

async function prepareGithub(pi, identity, repoPath, enableAttemptToken, disableGeneration) {
  await commandExec(pi, "gh", ["auth", "status"]);
  const automationLogin = (await commandExec(pi, "gh", ["api", "user", "--jq", ".login"])).stdout.trim().toLowerCase();
  if (!automationLogin) throw new Error("authenticated GitHub login is required to enable deadloop");
  const view = JSON.parse((await commandExec(pi, "gh", ["repo", "view", identity.githubRepo, "--json", "id,viewerPermission,nameWithOwner"])).stdout || "{}");
  if (view.nameWithOwner !== identity.githubRepo || String(view.id || "") !== identity.githubRepositoryId) {
    throw new Error("GitHub repository identity changed during enablement");
  }
  if (!["ADMIN", "MAINTAIN", "WRITE"].includes(String(view.viewerPermission || "").toUpperCase())) {
    throw new Error("GitHub write permission is required to enable deadloop");
  }
  for (const [name, color] of STANDARD_LABELS) {
    if (!ownsEnableAttempt(repoPath, enableAttemptToken)) {
      throw new Error("enablement was revoked while preflight was running");
    }
    const lookup = await pi.exec("gh", ["api", "--silent", `repos/${identity.githubRepo}/labels/${encodeURIComponent(name)}`], { timeout: 15_000 });
    if (lookup.code === 0) continue;
    if (!/HTTP 404\b/.test(`${lookup.stderr || ""}\n${lookup.stdout || ""}`)) {
      throw new Error((lookup.stderr || lookup.stdout || `label lookup failed for ${name}`).trim());
    }
    await withEnablementStateLock(async () => {
      if (
        !ownsEnableAttempt(repoPath, enableAttemptToken) ||
        disableGenerationForRepo(loadDisableGenerations(STATE_DIR), repoPath) !== disableGeneration
      ) {
        throw new Error("enablement was revoked while preflight was running");
      }
      const lockedLookup = await pi.exec("gh", ["api", "--silent", `repos/${identity.githubRepo}/labels/${encodeURIComponent(name)}`], { timeout: 15_000 });
      if (lockedLookup.code === 0) return;
      if (!/HTTP 404\b/.test(`${lockedLookup.stderr || ""}\n${lockedLookup.stdout || ""}`)) {
        throw new Error((lockedLookup.stderr || lockedLookup.stdout || `label lookup failed for ${name}`).trim());
      }
      await commandExec(pi, "gh", ["label", "create", name, "-R", identity.githubRepo, "--color", color]);
    });
  }
  return automationLogin;
}
function revalidatePendingIssueHandoff(handoff) {
  if (handoff.kind !== "issue" || !handoff.input || typeof handoff.input !== "object") return true;
  const input = handoff.input;
  if (
    !input.githubRepo ||
    !Number.isInteger(input.issueNumber) ||
    typeof input.issueTitle !== "string" ||
    typeof input.issueBody !== "string" ||
    !input.readyLabel ||
    !input.implementLabel ||
    !input.inProgressLabel ||
    !input.blockedLabel ||
    !input.humanLabel ||
    !input.needsInfoLabel ||
    !input.wontfixLabel
  ) return false;
  const result = childProcess.spawnSync(
    "gh",
    ["issue", "view", String(input.issueNumber), "-R", input.githubRepo, "--json", "number,title,body,state,labels"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 25_000, killSignal: "SIGKILL" },
  );
  if (result.status !== 0) return false;
  try {
    const issue = JSON.parse(result.stdout || "{}");
    if (!isPendingIssueHandoffEligible(handoff, issue)) return false;
    const labels = (Array.isArray(issue.labels) ? issue.labels : [])
      .map((label) => typeof label === "string" ? label : String(label?.name || ""))
      .filter((label) => label && label !== input.inProgressLabel && label !== input.implementLabel);
    labels.push(input.implementLabel);
    const decision = selectIssueForImplementation(
      [{ ...issue, labels }],
      defaultIssueDecisionConfig({
        readyLabel: input.readyLabel,
        implementLabel: input.implementLabel,
        inProgressLabel: input.inProgressLabel,
        blockedLabel: input.blockedLabel,
        humanLabel: input.humanLabel,
        needsInfoLabel: input.needsInfoLabel,
        wontfixLabel: input.wontfixLabel,
      }),
      (candidate) => issueBlockedByNumbers(input.githubRepo, Number(candidate.number)),
      (number) => liveDependencyState(input.githubRepo, number),
    );
    return decision.selected === true && decision.number === input.issueNumber;
  } catch {
    return false;
  }
}

function automationRunnerDeps(pi, ctx, project, isCurrentSchedulerRun = () => true) {
  const ownedAutomationKeys = project.automations.map((automation) => automationStateKey(project, automation));
  return {
    enabledAt: () => project.enabledAt,
    isEnabled: () => isCurrentSchedulerRun() && isProjectEnabled(project),
    isIdle: typeof ctx.isIdle === "function" ? () => ctx.isIdle() : undefined,
    notify: (message, level) => {
      if (!isCurrentSchedulerRun()) return;
      try {
        ctx.ui.notify(message.replace(/^deadloop /, `${EXTENSION_NAME} `), level);
      } catch {}
    },
    now: () => Date.now(),
    prepareExecutionSupply: () => {
      try {
        return ensureCodeSnapshot({ packageRoot: PACKAGE_ROOT, stateDir: STATE_DIR, codeIdentity: LOADED_CODE_IDENTITY });
      } catch (error) {
        // A stop nobody can see is indistinguishable from an idle host, so publish the reason
        // before the throw stops this automation short of precheck and every driver.
        setLooperStatus(ctx, `skipped: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    },
    readPrompt,
    revalidatePendingDriverHandoff: revalidatePendingIssueHandoff,
    resolveAutomationFileInDir,
    runDriver: async (driverProject, driverAutomation, driverFile, supply) =>
      await runAutomationScript(pi, driverProject, driverAutomation, driverFile, supply),
    runPrecheck: async (precheckProject, precheckAutomation, precheckFile, supply) =>
      await runAutomationScript(pi, precheckProject, precheckAutomation, precheckFile, supply),
    saveState: (state) => {
      if (isCurrentSchedulerRun()) saveState(state, ownedAutomationKeys);
    },
    sendUserMessage: (prompt) => {
      if (isCurrentSchedulerRun()) pi.sendUserMessage(prompt);
    },
    sendUserMessageIfEnabled: (prompt) => {
      if (!isCurrentSchedulerRun()) return false;
      try {
        return withEnabledProjectLock(
          { repoPath: project.repoPath, githubRepo: project.githubRepo, stateDir: STATE_DIR, enabledAt: project.enabledAt },
          (_enabled, recheck) => (recheck(), pi.sendUserMessage(prompt), true),
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

function unreconciledAuthorityStatus(authority: { reconciled: boolean; reason: string }): string {
  return authority.reconciled ? "" : `PR work authority could not be reconciled safely: ${authority.reason}`;
}

// A caller that cannot reconcile must be able to say why, so the outcome carries its own reason
// instead of leaving one in the debug log. Only an explicit override may replace the reconciliation.
async function reconcilePrWorkAuthority(pi, project): Promise<{ reconciled: boolean; reason: string }> {
  if (typeof pi.testing?.reconcilePrWorkAuthority === "function") {
    return await pi.testing.reconcilePrWorkAuthority(project);
  }
  const labels = projectLabels(project);
  const enabled = findEnabledProject(loadEnablementState(), project);
  if (!enabled?.automationLogin) return { reconciled: false, reason: "the enabled record names no Automation host login" };
  const result = await execJson(pi, "node", [
    path.join(AUTOMATION_DIR, "reconcile-pr-work-authority.cts"),
    "--project-id", project.id,
    "--project-repo", project.repoPath,
    "--github-repo", project.githubRepo,
    "--state-dir", STATE_DIR,
    "--enabled-at", String(project.enabledAt),
    "--automation-login", enabled.automationLogin,
    "--review-label", labels.review,
    "--implement-label", labels.implement,
    "--update-branch-label", "agent:update-branch",
    "--in-progress-label", labels.inProgress,
    "--blocked-label", labels.blocked,
  ], null, { timeout: 90_000 });
  if (!result || result.action === "error") {
    const reason = String(result?.summary || result?.error || "the reconciliation driver returned no result");
    debugLog("PR work-authority reconciliation failed", reason);
    return { reconciled: false, reason };
  }
  return { reconciled: true, reason: "" };
}

async function reconcilePersistedAttemptJournals(pi, project): Promise<boolean> {
  const runsDir = path.join(STATE_DIR, "runs");
  let runs: string[];
  let safeToSchedule = true;
  try { runs = fs.readdirSync(runsDir); } catch { return true; }
  for (const run of runs) {
    const runDir = path.join(runsDir, run);
    const attemptRecord = path.join(runDir, "attempt.json");
    let record;
    try { record = readAttemptRecord(runDir); }
    catch (error) {
      // The owner cannot be trusted when its journal is malformed. Globally suppress selection
      // rather than silently launching into a possibly conflicting checkout.
      if (fs.existsSync(attemptRecord)) {
        safeToSchedule = false;
        debugLog("malformed attempt journal blocks scheduling", attemptRecord, error instanceof Error ? error.message : String(error));
      }
      continue;
    }
    if (record.project !== project.id || record.repository !== project.githubRepo
      || releasesAttemptOwnership(record.phase)) continue;
    const labels = projectLabels(project);
    if (record.phase === "prepared") {
      const claimResult = await execJson(pi, "node", [
        path.join(AUTOMATION_DIR, "reconcile-prepared-attempt.cts"),
        "--attempt-record", attemptRecord,
        "--project-id", project.id,
        "--project-repo", project.repoPath,
        "--github-repo", project.githubRepo,
        "--state-dir", STATE_DIR,
        "--enabled-at", String(project.enabledAt),
        "--ready-label", labels.ready,
        "--implement-label", labels.implement,
        "--in-progress-label", labels.inProgress,
        "--review-label", labels.review,
        "--update-branch-label", labels.updateBranch,
        "--blocked-label", labels.blocked,
      ], null);
      if (claimResult?.action === "error") debugLog("prepared attempt claim reconciliation blocked", claimResult.reason || claimResult.driverAction, claimResult.summary);
      try { record = readAttemptRecord(runDir); }
      catch { safeToSchedule = false; continue; }
    }
    if (!record.workspaceId) {
      if (record.phase === "prepared" || record.phase === "github_claimed") safeToSchedule = false;
      continue;
    }

    let report;
    if (record.phase !== "github_persisted") {
      try {
        report = JSON.parse(fs.readFileSync(record.promiseFile, "utf8"));
        validateCompletionReportBinding(record, report);
      } catch { continue; }
      if (report.status !== "complete") continue;
    }
    const reviewerAutoMerge = record.autoMergePolicy ?? project.autoMerge;
    // A review that neither repairs nor merges hands its pull request to a person, and that state
    // carries no agent workflow label. The human handoff label classifies Issues, so expecting it
    // on a pull request would describe a state nothing ever writes.
    const expectedLabels = report?.role === "reviewer"
      ? decideReviewTransition(report.result || {}).transition === "repair" || reviewerAutoMerge
        ? [labels.review, labels.inProgress]
        : []
      : [];
    const args = [
      path.join(AUTOMATION_DIR, "complete-attempt-workspace.cts"),
      "--attempt-record", attemptRecord,
      "--project-id", project.id,
      "--project-repo", project.repoPath,
      "--github-repo", project.githubRepo,
      "--state-dir", STATE_DIR,
      "--enabled-at", String(project.enabledAt),
      "--worker-ready-label", labels.ready,
      "--worker-implement-label", labels.implement,
      "--worker-review-label", labels.review,
      "--auto-merge", reviewerAutoMerge ? "true" : "false",
      ...expectedLabels.flatMap((label) => ["--expected-label", label]),
      ...[labels.review, labels.inProgress, labels.blocked, labels.human]
        .flatMap((label) => ["--managed-label", label]),
    ];
    const result = await execJson(pi, "node", args, null);
    // `driverResult` carries the failure text in `summary`, so logging only `reason` reduces every
    // exception to the word "exception" and leaves a per-tick retry with nothing to diagnose it by.
    if (result?.action === "error") debugLog("attempt reconciliation retained workspace", result.reason || result.driverAction, result.summary);
  }
  return safeToSchedule;
}

export { reconcilePersistedAttemptJournals, reconcilePrWorkAuthority, retainedAttemptClaimSnapshot, retainedAttemptDoctorFindings };

function attemptRecordForId(project, attemptId) {
  const runsDir = path.join(STATE_DIR, "runs");
  let runs = [];
  try { runs = fs.readdirSync(runsDir); } catch { throw new Error("No deadloop attempt journals were found."); }
  const matches = [];
  for (const run of runs) {
    const runDir = path.join(runsDir, run);
    if (!fs.existsSync(path.join(runDir, "attempt.json"))) continue;
    let record;
    try { record = readAttemptRecord(runDir); }
    catch (error) { throw new Error(`Cannot safely search attempts because ${path.join(runDir, "attempt.json")} is malformed: ${error instanceof Error ? error.message : String(error)}`); }
    if (record.project === project.id && record.repository === project.githubRepo && record.attemptId === attemptId) {
      matches.push(path.join(runDir, "attempt.json"));
    }
  }
  if (matches.length !== 1) throw new Error(`Expected one attempt ${attemptId} for ${project.id}; found ${matches.length}.`);
  return matches[0];
}

function displayCommandResult(pi, ctx, customType, content) {
  if (ctx.mode === "print" || ctx.mode === "json") console.log(content);
  else pi.sendMessage({ customType, content, display: true });
}

export default function (pi) {
  const preflight = typeof pi.testing?.herdrPreflight === "function"
    ? () => pi.testing.herdrPreflight()
    : herdrPreflight;
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
  pi.registerCommand("deadloop-abandon-attempt", {
    description: "Safely abandon one proven launch-failed attempt and requeue its unchanged Issue or PR",
    handler: async (args, ctx) => {
      const attemptId = String(args || "").trim();
      if (!attemptId || /\s/.test(attemptId)) {
        displayCommandResult(pi, ctx, "deadloop-abandon-attempt", "Usage: /deadloop-abandon-attempt <attempt-id>");
        return;
      }
      try {
        const data = await collectLiveSnapshotData(pi, ctx.cwd);
        const project = data.selectedProject;
        if (!project) throw new Error("deadloop is not enabled for the current repository.");
        const attemptRecord = attemptRecordForId(project, attemptId);
        const labels = projectLabels(project);
        const commandArgs = [
          path.join(AUTOMATION_DIR, "abandon-launch-failed-attempt.cts"),
          "--attempt-record", attemptRecord,
          "--project-id", project.id,
          "--project-repo", project.repoPath,
          "--github-repo", project.githubRepo,
          "--state-dir", STATE_DIR,
          "--enabled-at", String(project.enabledAt),
          "--ready-label", labels.ready,
          "--implement-label", labels.implement,
          "--in-progress-label", labels.inProgress,
          "--review-label", labels.review,
          "--blocked-label", labels.blocked,
          "--human-label", labels.human,
        ];
        const completed = await pi.exec("node", commandArgs, { timeout: 90_000 });
        if (completed.code !== 0) throw new Error((completed.stderr || completed.stdout || "attempt abandonment failed").trim());
        const result = JSON.parse(completed.stdout || "null");
        const content = result?.action === "done"
          ? result.summary
          : `${result?.summary || "manual review required"}\nInspect the original attempt journal and retained linked worktree before taking any label action.`;
        displayCommandResult(pi, ctx, "deadloop-abandon-attempt", content);
      } catch (error) {
        displayCommandResult(pi, ctx, "deadloop-abandon-attempt", `manual review required: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  let timer = null;
  let running = false;
  let startupTick = null;
  let active = null;
  let ownsLock = false;
  let stopRequested = false;
  let pendingStart = null;
  let activeTickPromise = null;
  const activeEnablementVerifications = new Map();

  function registerEnablementVerification(repoPath, controller, settled) {
    const key = path.resolve(repoPath);
    const runs = activeEnablementVerifications.get(key) || new Set();
    runs.add({ controller, settled });
    activeEnablementVerifications.set(key, runs);
  }

  function unregisterEnablementVerification(repoPath, controller) {
    const key = path.resolve(repoPath);
    const runs = activeEnablementVerifications.get(key);
    if (!runs) return;
    for (const run of runs) if (run.controller === controller) runs.delete(run);
    if (!runs.size) activeEnablementVerifications.delete(key);
  }

  async function interruptEnablementVerifications(repoPath?) {
    const runs = repoPath
      ? [...(activeEnablementVerifications.get(path.resolve(repoPath)) || [])]
      : [...activeEnablementVerifications.values()].flatMap((entries) => [...entries]);
    for (const run of runs) run.controller.abort();
    await Promise.allSettled(runs.map((run) => run.settled));
  }

  async function tick(ctx) {
    if (!active) return;
    const schedulerRun = active;

    // Global fail-closed gate: no candidate selection or workflow/runner mutation may happen first.
    try {
      preflight();
    } catch (error) {
      // Recovery-only exception: a supported local client may reflect an unreachable runtime
      // as agent:blocked. No candidate, launch, completion, push, ready, or merge path is opened.
      let recoveryStatus = "";
      if (herdrServerIsUnreachableWithSupportedClient() && isProjectEnabled(schedulerRun.project)) {
        const status = unreconciledAuthorityStatus(await reconcilePrWorkAuthority(pi, schedulerRun.project));
        if (status) recoveryStatus = `; ${status}`;
      }
      setLooperStatus(ctx, `skipped: ${error instanceof Error ? error.message : String(error)}${recoveryStatus}`);
      return;
    }

    let remainsEnabled = false;
    try {
      remainsEnabled = isProjectEnabled(active.project);
    } catch (error) {
      debugLog("scheduler enablement check failed", error?.message || error);
    }
    if (!remainsEnabled) {
      invalidateSchedulerRun(ctx, schedulerRun);
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
      invalidateSchedulerRun(ctx, schedulerRun);
      setLooperStatus(ctx, "deadloop is not enabled for this repository");
      return;
    }
    if (projectLockPath(project) !== schedulerRun.lockPath) {
      invalidateSchedulerRun(ctx, schedulerRun);
      setLooperStatus(ctx, "skipped: active project identity changed since scheduler lock was acquired");
      return;
    }
    if (running) return;
    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
    if (typeof ctx.hasPendingMessages === "function" && ctx.hasPendingMessages()) return;

    running = true;
    let completedSafely = false;
    try {
      // GitHub work authority is reconciled before local cleanup, pending handoffs, or candidate selection.
      const authorityStatus = unreconciledAuthorityStatus(await reconcilePrWorkAuthority(pi, project));
      if (authorityStatus) {
        setLooperStatus(ctx, `skipped: ${authorityStatus}`);
        completedSafely = true;
        return;
      }
      // Restart reconciliation is idempotent and runs before pending handoffs or candidate selection.
      const safeToSchedule = await reconcilePersistedAttemptJournals(pi, project);
      if (!safeToSchedule) {
        setLooperStatus(ctx, "skipped: a prepared GitHub claim requires operator reconciliation");
        completedSafely = true;
        return;
      }
      const state = loadState();
      updateStatus(ctx, project, state);

      const deps = automationRunnerDeps(pi, ctx, project, () => active === schedulerRun && ownsLock && !stopRequested);
      for (const automation of project.automations) {
        const entry = state.automations[automationStateKey(project, automation)] || {};
        state.automations[automationStateKey(project, automation)] = entry;
        if (deliverPendingDriverHandoff(entry, state, automation.name, deps)) {
          if (active === schedulerRun && ownsLock && !stopRequested) deps.saveState(state);
          completedSafely = true;
          return;
        }
      }

      const selected = reconcileAndSelectDueAutomation(project, state.automations, Date.now());
      if (selected) {
        await runAutomation(pi, ctx, project, selected.automation, selected.dueSlot, state, deps);
        if (active === schedulerRun && ownsLock && !stopRequested) updateStatus(ctx, project, state);
      }

      if (active === schedulerRun && ownsLock && !stopRequested) deps.saveState(state);
      completedSafely = true;
    } finally {
      try {
        if (completedSafely) await completeFirstSchedulerStart(project);
      } finally {
        running = false;
      }
    }
  }

  function runTick(ctx) {
    if (activeTickPromise) return activeTickPromise;
    const currentTick = tick(ctx);
    activeTickPromise = currentTick;
    const finishTick = () => {
      if (activeTickPromise === currentTick) activeTickPromise = null;
      if (stopRequested && !running) {
        const restart = pendingStart;
        finishStoppingScheduler(ctx);
        if (restart) startScheduler(restart.ctx, restart.project);
      }
    };
    void currentTick.then(finishTick, finishTick);
    return currentTick;
  }

  function finishStoppingScheduler(ctx) {
    if (ownsLock && active?.lockPath && active?.lockToken) releaseSchedulerLock(active.lockPath, active.lockToken);
    ownsLock = false;
    active = null;
    stopRequested = false;
    pendingStart = null;
    setLooperStatus(ctx, undefined);
  }

  function invalidateSchedulerRun(ctx, schedulerRun = active) {
    if (!schedulerRun || active !== schedulerRun) return;
    if (timer) clearInterval(timer);
    if (startupTick) clearTimeout(startupTick);
    timer = null;
    startupTick = null;
    pendingStart = null;
    if (ownsLock && schedulerRun.lockPath && schedulerRun.lockToken) {
      releaseSchedulerLock(schedulerRun.lockPath, schedulerRun.lockToken);
    }
    ownsLock = false;
    active = null;
    stopRequested = false;
    setLooperStatus(ctx, undefined);
  }

  function pollScheduler(ctx) {
    const schedulerRun = active;
    if (!schedulerRun) return Promise.resolve();
    let remainsEnabled = false;
    try {
      remainsEnabled = isProjectEnabled(schedulerRun.project);
    } catch (error) {
      debugLog("scheduler polling enablement check failed", error?.message || error);
    }
    if (!remainsEnabled) {
      invalidateSchedulerRun(ctx, schedulerRun);
      setLooperStatus(ctx, "deadloop is not enabled for this repository");
      return Promise.resolve();
    }
    return runTick(ctx);
  }

  function stopScheduler(ctx) {
    if (timer) clearInterval(timer);
    if (startupTick) clearTimeout(startupTick);
    timer = null;
    startupTick = null;
    pendingStart = null;
    if (activeTickPromise) {
      stopRequested = true;
      setLooperStatus(ctx, undefined);
      return activeTickPromise;
    }
    finishStoppingScheduler(ctx);
    return Promise.resolve();
  }

  function startScheduler(ctx, project) {
    if (process.env.DEADLOOP === "off") {
      return { started: false, reason: "scheduler startup is suppressed by DEADLOOP=off" };
    }
    if (process.env.DEADLOOP_AUTOMATIONS === "off") {
      return { started: false, reason: "scheduler startup is suppressed by DEADLOOP_AUTOMATIONS=off" };
    }
    try {
      preflight();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setLooperStatus(ctx, `skipped: ${reason}`);
      return { started: false, reason };
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
    if (!lock.acquired) {
      ownsLock = false;
      active = null;
      const reason = `repository is already served by Automation host pid ${lock.owner ?? "unknown"}`;
      setLooperStatus(ctx, `skipped: ${reason}`);
      return { started: false, reason };
    }
    ownsLock = true;
    active = { project, lockPath: lock.lockPath, lockToken: lock.token };
    updateStatus(ctx, project, loadState());
    timer = setInterval(() => pollScheduler(ctx).catch((error) => console.warn(`[${EXTENSION_NAME}] tick failed:`, error?.message || error)), TICK_MS);
    timer.unref?.();
    startupTick = setTimeout(() => pollScheduler(ctx).catch((error) => console.warn(`[${EXTENSION_NAME}] startup tick failed:`, error?.message || error)), 3000);
    startupTick.unref?.();
    return { started: true };
  }

  pi.registerCommand("deadloop-enable", {
    description: "Enable deadloop locally for this primary Git checkout",
    handler: async (_args, ctx) => {
      let primaryRepoPath;
      let identity;
      let previousEnabledAt;
      let previousEnabledProject;
      let retainedVerificationJournalPath;
      let enablementSaved = false;
      const enableAttemptToken = crypto.randomUUID();
      const progressKey = `deadloop-enable:${enableAttemptToken}`;
      const showProgress = ctx.hasUI;
      if (showProgress) {
        ctx.ui.notify("Enabling deadloop. Required verification may take several minutes.", "info");
        ctx.ui.setStatus(progressKey, "deadloop: enabling…");
      }
      try {
        (pi.testing?.schedulerLockCapabilityPreflight || preflightSchedulerLockCapability)();
        let enabledAt;
        const disableGenerations = await withEnablementStateLock(async () => loadDisableGenerations(STATE_DIR));
        primaryRepoPath = await detectPrimaryCheckout(pi, ctx.cwd);
        const disableGeneration = disableGenerationForRepo(disableGenerations, primaryRepoPath);
        await withEnablementStateLock(async () => {
          if (disableGenerationForRepo(loadDisableGenerations(STATE_DIR), primaryRepoPath) !== disableGeneration) {
            throw new Error("enablement was revoked while checkout detection was running");
          }
          writeEnableAttempt(primaryRepoPath, enableAttemptToken);
        });
        identity = await detectProjectIdentity(pi, primaryRepoPath);
        previousEnabledAt = await withEnablementStateLock(async () => findEnabledProject(loadEnablementState(), identity)?.enabledAt);
        const preflightProject = resolveEnableProject(ctx.cwd, identity);
        const verificationController = new AbortController();
        let settleVerification;
        const verificationSettled = new Promise<void>((resolve) => { settleVerification = resolve; });
        registerEnablementVerification(primaryRepoPath, verificationController, verificationSettled);
        let verification;
        try {
          if (showProgress) ctx.ui.setStatus(progressKey, "deadloop: running required verification…");
          verification = await runEnablementVerification({
            stateDir: STATE_DIR,
            primaryRepoPath,
            repository: identity.githubRepo,
            resolution: preflightProject.requiredVerification,
            beforeWorktreeCreate: pi.testing?.beforeEnablementWorktreeCreate,
            beforeProjectCheck: pi.testing?.beforeEnablementProjectCheck,
            signal: verificationController.signal,
          });
        } finally {
          unregisterEnablementVerification(primaryRepoPath, verificationController);
          settleVerification();
        }
        if (verification.outcome !== "passed") {
          const retained = verification.cleanup === "retained" ? `; retained worktree journal: ${verification.journalPath}` : "";
          const failure = verification.outcome === "interrupted"
            ? "was interrupted"
            : verification.outcome === "timed_out"
              ? "timed out"
              : `failed (exit ${verification.exitCode})`;
          throw new Error(`required verification ${failure}; log: ${verification.logPath}${retained}`);
        }
        if (verification.cleanup === "retained") {
          retainedVerificationJournalPath = verification.journalPath;
        }
        if (!ownsEnableAttempt(primaryRepoPath, enableAttemptToken)) {
          throw new Error("enablement was revoked while required verification was running");
        }
        const verifiedProject = resolveEnableProject(ctx.cwd, identity);
        if (!requiredVerificationMatches(verifiedProject.requiredVerification, preflightProject.requiredVerification)) {
          throw new Error("required verification contract changed during enablement");
        }
        if (verifiedProject.baseBranch !== preflightProject.baseBranch) {
          throw new Error("base branch changed during enablement");
        }
        if (showProgress) ctx.ui.setStatus(progressKey, "deadloop: checking GitHub access and labels…");
        const automationLogin = await prepareGithub(pi, identity, primaryRepoPath, enableAttemptToken, disableGeneration);
        await withEnablementStateLock(async () => {
          if (
            !ownsEnableAttempt(primaryRepoPath, enableAttemptToken) ||
            disableGenerationForRepo(loadDisableGenerations(STATE_DIR), primaryRepoPath) !== disableGeneration
          ) {
            throw new Error("enablement was revoked while preflight was running");
          }
          await revalidateLocalProjectIdentity(pi, identity);
          const revalidatedAutomationLogin = (await commandExec(pi, "gh", ["api", "user", "--jq", ".login"])).stdout.trim().toLowerCase();
          if (!revalidatedAutomationLogin || revalidatedAutomationLogin !== automationLogin) {
            throw new Error("authenticated GitHub login changed during enablement");
          }
          const configuredProject = resolveEnableProject(ctx.cwd, identity);
          if (!requiredVerificationMatches(configuredProject.requiredVerification, preflightProject.requiredVerification)) {
            throw new Error("required verification contract changed during enablement");
          }
          if (configuredProject.baseBranch !== preflightProject.baseBranch) {
            throw new Error("base branch changed during enablement");
          }
          const firstEnable = { firstEnableAutoMerge: Boolean(configuredProject.autoMerge) };
          const currentEnablementState = loadEnablementState();
          previousEnabledProject = findEnabledProject(currentEnablementState, identity);
          const next = upsertEnabledProject(
            currentEnablementState,
            { ...identity, baseBranch: configuredProject.baseBranch, automationLogin, disableGeneration },
            Date.now(),
            firstEnable,
            enableAttemptToken,
          );
          enabledAt = findEnabledProject(next, identity)?.enabledAt;
          saveEnablementState(next);
          enablementSaved = true;
        });
        finishEnableAttempt(primaryRepoPath, enableAttemptToken);
        let project;
        let schedulerStartedForAttempt = false;
        try {
          await pi.testing?.afterEnablementSaved?.();
          const expectedAuthority = {
            enabledAt,
            enableAttemptToken,
            automationLogin,
            disableGeneration,
          };
          assertSavedAutomationAuthority(identity, expectedAuthority);
          const projects = loadProjects(ctx.cwd);
          project = await activeSchedulerProject(ctx.cwd, projects);
          if (!project) throw new Error("enabled repository configuration could not be resolved safely");
          if (!requiredVerificationMatches(project.requiredVerification, preflightProject.requiredVerification)) {
            throw new Error("required verification contract changed before scheduler startup");
          }
          if (project.baseBranch !== preflightProject.baseBranch) {
            throw new Error("base branch changed before scheduler startup");
          }
          await withEnablementStateLock(async () => {
            assertSavedAutomationAuthority(identity, expectedAuthority);
            const schedulerStart = startScheduler(ctx, project);
            if (!schedulerStart.started) throw new Error(schedulerStart.reason);
            schedulerStartedForAttempt = true;
            await pi.testing?.afterEnablementSchedulerStart?.();
            assertSavedAutomationAuthority(identity, expectedAuthority);
          });
        } catch (error) {
          if (schedulerStartedForAttempt) await stopScheduler(ctx);
          await rollbackSavedEnablementAttempt(identity, enabledAt, enableAttemptToken, previousEnabledProject);
          throw error;
        }
        const owner = ownsLock ? "this session" : `another session (pid ${readLock(projectLockPath(project))?.pid || "unknown"})`;
        const retainedVerification = retainedVerificationJournalPath
          ? ` Required-verification worktree was retained for inspection because cleanup was not proven safe; journal: ${retainedVerificationJournalPath}.`
          : "";
        const message = `deadloop enabled for ${identity.githubRepo}; scheduler owner: ${owner}. autoMerge is ${project.autoMerge ? "on (existing local setting preserved)" : "off"}.${retainedVerification}`;
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
      } finally {
        if (showProgress) ctx.ui.setStatus(progressKey, undefined);
      }
    },
  });

  pi.registerCommand("deadloop-disable", {
    description: "Disable local deadloop scheduling for this repository without stopping active agents",
    handler: async (_args, ctx) => {
      try {
        let message;
        const repoPath = await detectPrimaryCheckout(pi, ctx.cwd, true);
        advanceDisableGeneration(STATE_DIR, repoPath, writeJsonFile);
        await interruptEnablementVerifications(repoPath);
        await pi.testing?.beforeDisableLock?.();
        await withEnablementStateLock(async () => {
          const attempt = readJsonFile(enableAttemptPath(repoPath), null);
          if (attempt?.repoPath === path.resolve(repoPath) && attempt?.token) {
            writeEnableAttempt(repoPath, attempt.token, true);
          }
          const state = loadEnablementState();
          const enabled = state.projects.find((project) => project.repoPath === path.resolve(repoPath) && project.enabled !== false);
          saveEnablementState(removeEnabledProjectAtPath(state, repoPath));
          if (active?.project?.repoPath && path.resolve(active.project.repoPath) === path.resolve(repoPath)) {
            invalidateSchedulerRun(ctx, active);
          }
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

  pi.on("session_shutdown", async (_event, ctx) => {
    await interruptEnablementVerifications();
    await stopScheduler(ctx);
  });
}
