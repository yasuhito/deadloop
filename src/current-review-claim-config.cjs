// @ts-nocheck -- CommonJS runtime loads the canonical TypeScript module through tsx.
require("tsx/cjs");

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  REPO_POLICY_FILE,
  authorizeAutomationLogin,
  parseProjectsConfig,
  resolveConfigPath,
} = require("./core.ts");

const POLICY_COMMAND_TIMEOUT_MS = 10_000;

function git(repoPath, args, timeout = POLICY_COMMAND_TIMEOUT_MS) {
  return childProcess.spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: 1024 * 1024,
  });
}

function commandFailure(result, fallback) {
  return String(result.stderr || result.stdout || result.error?.message || fallback).trim();
}

function trustedPolicyProvider(enabled) {
  return (project) => {
    const repoPath = String(project.repoPath || "");
    const baseBranch = String(project.baseBranch || enabled.baseBranch || "origin/main");
    if (!repoPath) return { status: "missing" };
    const revision = git(repoPath, ["rev-parse", `${baseBranch}^{commit}`]);
    if (revision.status !== 0 || !String(revision.stdout || "").trim()) {
      return { status: "error", reason: `trusted base revision resolution failed for ${baseBranch}: ${commandFailure(revision, "git rev-parse failed")}` };
    }
    const baseRevision = String(revision.stdout).trim();
    const show = git(repoPath, ["show", `${baseRevision}:${REPO_POLICY_FILE}`]);
    if (show.status === 0) return { status: "loaded", text: show.stdout || "{}", baseRevision };
    if (show.error) return { status: "error", reason: `trusted repo policy read failed for ${baseRevision}: ${show.error.message}`, baseRevision };
    return { status: "missing", baseRevision };
  };
}

function readCurrentConfig(stateDir) {
  const extensionDir = path.resolve(__dirname, "../extensions/deadloop");
  const configPath = resolveConfigPath({
    env: process.env,
    stateDir,
    extensionDir,
    exists: fs.existsSync,
    joinPath: path.join,
  });
  try { return { configPath, text: fs.readFileSync(configPath, "utf8") }; }
  catch (error) {
    if (error.code === "ENOENT") return { configPath, text: JSON.stringify({ projects: [] }) };
    throw new Error(`projects.json read error: ${error.message}`);
  }
}

function rawProjects(text) {
  let value;
  try { value = JSON.parse(text || "{}"); }
  catch (error) { throw new Error(`current normalized project configuration is invalid: ${error.message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value) || (value.projects !== undefined && !Array.isArray(value.projects))) {
    throw new Error("current normalized project configuration is invalid: projects.json must contain a projects array");
  }
  return value.projects || [];
}

function samePath(left, right) {
  try { return path.resolve(String(left || "")) === path.resolve(String(right || "")); }
  catch { return false; }
}

function exactIdentity(project, enabled) {
  return samePath(project.repoPath, enabled.repoPath) && project.githubRepo === enabled.githubRepo;
}

function resolveCanonicalProject(stateDir, enabled) {
  if (!enabled || enabled.enabled === false || !enabled.repoPath || !enabled.githubRepo
    || !enabled.githubRepositoryId || !enabled.automationLogin) {
    throw new Error("current enablement identity is missing or disabled");
  }
  const { configPath, text } = readCurrentConfig(stateDir);
  const candidates = rawProjects(text);
  const identityOverlaps = candidates.filter((project) =>
    samePath(project?.repoPath, enabled.repoPath) || project?.githubRepo === enabled.githubRepo,
  );
  if (identityOverlaps.some((project) => !exactIdentity(project, enabled))) {
    throw new Error("current normalized project identity does not exactly match enablement");
  }
  const provider = trustedPolicyProvider(enabled);
  const parsed = parseProjectsConfig(text, process.env.DEADLOOP_PROJECTS || "", {
    configPath,
    repoPolicyProvider: provider,
  });
  if (!parsed.ok) throw new Error(`current normalized project configuration is invalid: ${parsed.reason}`);
  const exact = parsed.projects.filter((project) => exactIdentity(project, enabled));
  if (exact.length > 1) throw new Error("current normalized project configuration is ambiguous");
  if (exact.length === 1) return authorizeAutomationLogin(exact[0], enabled.automationLogin);

  const implicitRaw = {
    repoPath: enabled.repoPath,
    githubRepo: enabled.githubRepo,
    baseBranch: enabled.baseBranch || "origin/main",
    enabled: true,
    autoMerge: false,
  };
  const implicit = parseProjectsConfig(JSON.stringify({ projects: [implicitRaw] }), process.env.DEADLOOP_PROJECTS || "", {
    configPath: `${enabled.repoPath}${path.sep}${REPO_POLICY_FILE}`,
    repoPolicyProvider: provider,
  });
  if (!implicit.ok) throw new Error(`current normalized project configuration is invalid: ${implicit.reason}`);
  if (implicit.projects.length !== 1) throw new Error("current reviewer project is missing after DEADLOOP_PROJECTS filtering");
  return authorizeAutomationLogin(implicit.projects[0], enabled.automationLogin);
}

/** The request label each PR role consumes, taken from current configuration. */
function requestLabelForRole(labels, role) {
  const byRole = {
    reviewer: labels.review,
    "review-repair": labels.implement,
    "branch-update": labels.updateBranch,
  };
  if (!byRole[role]) throw new Error(`current configuration has no request label for the ${role} role`);
  return byRole[role];
}

function loadCurrentReviewClaimConfiguration(stateDir, enabled, authenticatedLogin, role = "reviewer") {
  const project = resolveCanonicalProject(stateDir, enabled);
  if (project.enabled === false) throw new Error("current project configuration disables this repository");
  const reviewers = project.automations.filter((automation) => automation.driverFile === "pr-reviewer-driver.ts");
  if (reviewers.length !== 1) throw new Error("current reviewer automation configuration is missing or ambiguous");
  const reviewer = reviewers[0];
  const login = String(authenticatedLogin || "").trim().toLowerCase();
  const enabledLogin = String(enabled.automationLogin || "").trim().toLowerCase();
  const authorizedLogins = [...new Set(project.automationLogins)].sort();
  if (!login || login !== enabledLogin || !authorizedLogins.includes(login)) {
    throw new Error("current authenticated GitHub identity is not authorized by current enablement and configuration");
  }
  const labels = project.labels;
  return {
    reviewerMaxRuntimeSeconds: reviewer.maxRuntimeSeconds,
    cleanupGraceSeconds: reviewer.shutdownGraceSeconds,
    authoritySeconds: reviewer.maxRuntimeSeconds + reviewer.shutdownGraceSeconds,
    managedLabels: [labels.review, labels.implement, labels.updateBranch, labels.inProgress, labels.blocked],
    requestLabel: requestLabelForRole(labels, role),
    requiredLabels: [labels.inProgress],
    repositoryId: enabled.githubRepositoryId,
    repository: enabled.githubRepo,
    authorizedLogins,
    authenticatedLogin: login,
    reviewerAgent: project.reviewerAgent,
  };
}

module.exports = {
  POLICY_COMMAND_TIMEOUT_MS,
  loadCurrentReviewClaimConfiguration,
  requestLabelForRole,
  resolveCanonicalProject,
};
