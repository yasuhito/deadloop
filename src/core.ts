import path from "node:path";

import { AGENT_KINDS, type AgentKind, isAgentKind } from "./agent-profiles.cjs";

export const DEFAULT_TIMEZONE = "Asia/Tokyo";

export const REPO_POLICY_FILE = "pi-looper.project.json";

export const DEFAULT_WORKER_INSTRUCTIONS = "AGENTS.md、CONTEXT.md、関連 docs/adr/ を読んでから作業する。";

export const DEFAULT_WORKER_LAUNCH_POLICY =
  "Worker 起動時は issue の難易度を見てレベルを選ぶ。単純なドキュメント修正・小さなテスト修正・局所的な実装は low、通常の実装は medium、複数コンポーネント・設計判断・データ移行・難しい不具合修正は high。判断理由を worker prompt に1行で残す。";

export type LabelConfig = {
  ready?: string;
  implement?: string;
  inProgress?: string;
  blocked?: string;
  review?: string;
  reviewing?: string;
  human?: string;
  needsInfo?: string;
  wontfix?: string;
  needsTriage?: string;
};

export type NormalizedLabels = Required<LabelConfig>;

export type RawAutomation = {
  id?: string;
  name?: string;
  schedule?: string;
  timezone?: string;
  graceMinutes?: number;
  promptFile?: string;
  precheckFile?: string;
  precheckTimeoutSeconds?: number;
  initialLastScheduledAt?: number;
};

export type NormalizedAutomation = {
  id: string;
  name: string;
  schedule: string;
  timezone: string;
  graceMinutes: number;
  promptFile?: string;
  precheckFile?: string;
  precheckTimeoutSeconds: number;
  initialLastScheduledAt: number;
};

// The worker and reviewer agent enums are derived from the profile table keys
// (agent-profiles.cjs), so adding an agent profile is the only place that widens
// this union.
export type WorkerAgent = AgentKind;
export type ReviewerAgent = AgentKind;

export type RawProject = {
  id?: string;
  enabled?: boolean;
  repoPath?: string;
  githubRepo?: string;
  baseBranch?: string;
  worktreeRoot?: string;
  checkCommand?: string;
  autoMerge?: boolean;
  workerInstructions?: string;
  workerLaunchPolicy?: string;
  workerAgent?: string;
  workerModel?: string;
  reviewerAgent?: string;
  reviewerModel?: string;
  labels?: LabelConfig;
  automations?: RawAutomation[];
};

export type RepoPolicyReadResult =
  | { status: "missing" }
  | { status: "loaded"; text: string }
  | { status: "error"; reason: string };

export type RepoPolicyProvider = (project: RawProject) => RepoPolicyReadResult;

export type ProjectConfigSource = {
  localPath?: string;
  repoPolicyPath: string;
  repoPolicyBaseBranch: string;
  repoPolicyStatus: "not-read" | "missing" | "loaded" | "error";
  repoPolicyError?: string;
  repoPolicyAppliedKeys: string[];
};

export type NormalizedProject = {
  id: string;
  enabled: boolean;
  repoPath?: string;
  githubRepo?: string;
  baseBranch: string;
  worktreeRoot: string;
  checkCommand: string;
  autoMerge: boolean;
  workerInstructions: string;
  workerLaunchPolicy: string;
  workerAgent: WorkerAgent;
  workerModel: string;
  reviewerAgent: ReviewerAgent;
  reviewerModel: string;
  labels: NormalizedLabels;
  automations: NormalizedAutomation[];
  configSource: ProjectConfigSource;
};

export type AutomationStateEntry = {
  lastScheduledAt?: number;
  lastAttemptAt?: number;
  lastResult?: string;
  failureStreak?: number;
  updatedAt?: number;
};

export type TemplateValueMap = Record<string, unknown>;

export const EXTENSION_CODE_CHANGED_WARNING = "⚠ extension code changed since load — restart required";

export type ConfigPathOptions = {
  env?: Record<string, string | undefined>;
  stateDir: string;
  extensionDir: string;
  exists?: (path: string) => boolean;
  joinPath?: (...parts: string[]) => string;
};

export type ProjectConfigResolution =
  | { ok: true; projects: NormalizedProject[]; warnings: string[] }
  | { ok: false; reason: string; warnings?: string[] };

export type TickProjectResolution = { ok: true; project: NormalizedProject } | { ok: false; reason: string };

export type CodeSourceMtime = {
  path: string;
  mtimeMs: number;
};

export function resolveConfigPath(options: ConfigPathOptions): string {
  const env = options.env || {};
  if (env.PI_LOOPER_CONFIG) return env.PI_LOOPER_CONFIG;

  const joinPath = options.joinPath || ((...parts: string[]) => parts.join("/"));
  const userConfigPath = joinPath(options.stateDir, "projects.json");
  if (options.exists?.(userConfigPath)) return userConfigPath;

  return joinPath(options.extensionDir, "projects.json");
}

// Bundled automation files were shortened in #46 (e.g. dropping the "generic-"
// prefix). Existing operator projects.json files still point at the old names,
// so we alias every legacy name back to its current short name. Built from the
// prefix + current name so the retired stems never appear as literals here.
const LEGACY_AUTOMATION_PREFIX = ["generic", ""].join("-");
const ALIASED_AUTOMATION_FILES = [
  "issue-coordinator.prompt.md",
  "issue-coordinator.precheck.sh",
  "pr-reviewer.prompt.md",
  "pr-reviewer.precheck.sh",
];

export const AUTOMATION_FILE_ALIASES: Record<string, string> = Object.fromEntries(
  ALIASED_AUTOMATION_FILES.map((current) => [`${LEGACY_AUTOMATION_PREFIX}${current}`, current]),
);

export type AutomationFileResolution = {
  requested: string;
  resolved: string;
  aliased: boolean;
  found: boolean;
};

export function resolveAutomationFile(
  requested: string | undefined,
  exists: (fileName: string) => boolean,
): AutomationFileResolution {
  const name = requested || "";
  const aliasTarget = AUTOMATION_FILE_ALIASES[name];
  const aliased = aliasTarget !== undefined;
  const resolved = aliased ? aliasTarget : name;
  return { requested: name, resolved, aliased, found: name !== "" && exists(resolved) };
}

export function sanitizeId(value: unknown): string {
  return (
    String(value || "project")
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

export function normalizeLabels(labels: LabelConfig = {}): NormalizedLabels {
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

export function normalizeAutomation(
  project: Pick<NormalizedProject, "id">,
  automation: RawAutomation,
): NormalizedAutomation {
  const id = automation.id || `${project.id}:${automation.name || automation.promptFile || "automation"}`;
  return {
    id,
    name: automation.name || id,
    schedule: automation.schedule || "*/10 * * * *",
    timezone: automation.timezone || DEFAULT_TIMEZONE,
    graceMinutes: Number.isFinite(automation.graceMinutes) ? automation.graceMinutes! : 720,
    promptFile: automation.promptFile,
    precheckFile: automation.precheckFile,
    precheckTimeoutSeconds: Number.isFinite(automation.precheckTimeoutSeconds)
      ? automation.precheckTimeoutSeconds!
      : 60,
    initialLastScheduledAt: Number.isFinite(automation.initialLastScheduledAt) ? automation.initialLastScheduledAt! : 0,
  };
}

function filterProjectIds(only?: string | string[]): string[] {
  const values = Array.isArray(only) ? only : String(only || "").split(",");
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => sanitizeId(value));
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

const REPO_POLICY_PROJECT_KEYS = new Set([
  "workerAgent",
  "workerModel",
  "reviewerAgent",
  "reviewerModel",
  "checkCommand",
  "workerInstructions",
  "workerLaunchPolicy",
  "labels",
  "automations",
]);
const REPO_POLICY_LABEL_KEYS = new Set([
  "ready",
  "implement",
  "inProgress",
  "blocked",
  "review",
  "reviewing",
  "human",
  "needsInfo",
  "wontfix",
  "needsTriage",
]);
const REPO_POLICY_AUTOMATION_KEYS = new Set(["id", "name", "promptFile", "precheckFile"]);

function validateObject(value: unknown, context: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
}

function validateRepoPolicy(policy: unknown): RawProject {
  validateObject(policy, REPO_POLICY_FILE);
  for (const key of Object.keys(policy)) {
    if (!REPO_POLICY_PROJECT_KEYS.has(key)) throw new Error(`repo policy key is not allowed: ${key}`);
  }
  const labels = (policy as { labels?: unknown }).labels;
  if (labels !== undefined) {
    validateObject(labels, "repo policy labels");
    for (const key of Object.keys(labels)) {
      if (!REPO_POLICY_LABEL_KEYS.has(key)) throw new Error(`repo policy labels key is not allowed: ${key}`);
    }
  }
  const automations = (policy as { automations?: unknown }).automations;
  if (automations !== undefined) {
    if (!Array.isArray(automations)) throw new Error("repo policy automations must be an array");
    for (const [index, automation] of automations.entries()) {
      validateObject(automation, `repo policy automations[${index}]`);
      for (const key of Object.keys(automation)) {
        if (!REPO_POLICY_AUTOMATION_KEYS.has(key)) {
          throw new Error(`repo policy automations[${index}] key is not allowed: ${key}`);
        }
      }
    }
  }
  return policy as RawProject;
}

function parseRepoPolicy(text: string): RawProject {
  try {
    return validateRepoPolicy(JSON.parse(text || "{}"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`repo policy parse error: ${message}`);
  }
}

function mergeIfLocalMissing<T extends Record<string, unknown>>(target: T, local: T, policy: T, keys: string[]): string[] {
  const applied: string[] = [];
  for (const key of keys) {
    if (policy[key] === undefined || hasOwn(local, key)) continue;
    target[key as keyof T] = policy[key] as T[keyof T];
    applied.push(key);
  }
  return applied;
}

function mergeLabels(local?: LabelConfig, policy?: LabelConfig): { labels?: LabelConfig; appliedKeys: string[] } {
  if (!local && !policy) return { appliedKeys: [] };
  const merged = { ...(policy || {}), ...(local || {}) };
  const appliedKeys = Object.keys(policy || {}).filter((key) => !hasOwn(local || {}, key));
  return { labels: merged, appliedKeys: appliedKeys.map((key) => `labels.${key}`) };
}

function automationKey(automation: RawAutomation, index: number): string {
  return automation.id || automation.name || `#${index}`;
}

function mergeAutomations(
  local: RawAutomation[] | undefined,
  policy: RawAutomation[] | undefined,
): { automations?: RawAutomation[]; appliedKeys: string[] } {
  const localAutomations = local || [];
  if (!localAutomations.length) return { automations: local, appliedKeys: [] };
  const policyAutomations = policy || [];
  const byKey = new Map(policyAutomations.map((automation, index) => [automationKey(automation, index), automation]));
  const appliedKeys: string[] = [];
  const automations = localAutomations.map((automation, index) => {
    const policyAutomation = byKey.get(automationKey(automation, index)) || policyAutomations[index];
    if (!policyAutomation) return automation;
    const merged = { ...automation } as Record<string, unknown>;
    for (const key of REPO_POLICY_AUTOMATION_KEYS) {
      if (policyAutomation[key as keyof RawAutomation] === undefined || hasOwn(automation, key)) continue;
      merged[key] = policyAutomation[key as keyof RawAutomation];
      appliedKeys.push(`automations[${index}].${key}`);
    }
    return merged as RawAutomation;
  });
  return { automations, appliedKeys };
}

function mergeRepoPolicy(local: RawProject, policy: RawProject): { project: RawProject; appliedKeys: string[] } {
  const merged = { ...local } as Record<string, unknown>;
  const appliedKeys = mergeIfLocalMissing(merged, local as Record<string, unknown>, policy as Record<string, unknown>, [
    "workerAgent",
    "workerModel",
    "reviewerAgent",
    "reviewerModel",
    "checkCommand",
    "workerInstructions",
    "workerLaunchPolicy",
  ]);
  const labels = mergeLabels(local.labels, policy.labels);
  if (labels.labels) merged.labels = labels.labels;
  appliedKeys.push(...labels.appliedKeys);
  const automations = mergeAutomations(local.automations, policy.automations);
  if (automations.automations) merged.automations = automations.automations;
  appliedKeys.push(...automations.appliedKeys);
  return { project: merged as RawProject, appliedKeys };
}

function defaultConfigSource(raw: RawProject, localPath?: string): ProjectConfigSource {
  return {
    localPath,
    repoPolicyPath: REPO_POLICY_FILE,
    repoPolicyBaseBranch: raw.baseBranch || "origin/main",
    repoPolicyStatus: "not-read",
    repoPolicyAppliedKeys: [],
  };
}

export type ProjectsFromConfigOptions = {
  configPath?: string;
  repoPolicyProvider?: RepoPolicyProvider;
};

function applyRepoPolicy(raw: RawProject, options: ProjectsFromConfigOptions = {}): { raw: RawProject; source: ProjectConfigSource } {
  const source = defaultConfigSource(raw, options.configPath);
  if (!options.repoPolicyProvider) return { raw, source };
  const result = options.repoPolicyProvider(raw);
  source.repoPolicyStatus = result.status;
  if (result.status === "missing") return { raw, source };
  if (result.status === "error") {
    source.repoPolicyError = result.reason;
    throw new Error(result.reason);
  }
  const policy = parseRepoPolicy(result.text);
  const merged = mergeRepoPolicy(raw, policy);
  source.repoPolicyAppliedKeys = merged.appliedKeys;
  return { raw: merged.project, source };
}

// Shared by workerAgent and reviewerAgent: both draw from the same profile-table
// enum, so the only difference is which field name appears in the error message.
function normalizeAgentKind(value: unknown, field: string): AgentKind {
  if (value === undefined) return "pi";
  if (isAgentKind(value)) return value;
  const expected = AGENT_KINDS.map((kind) => `"${kind}"`).join(" or ");
  throw new Error(`invalid ${field}: ${String(value)} (expected ${expected})`);
}

export function normalizeProject(raw: RawProject, configSource?: ProjectConfigSource): NormalizedProject {
  const id = sanitizeId(raw.id || raw.githubRepo || raw.repoPath);
  const project: NormalizedProject = {
    id,
    enabled: raw.enabled !== false,
    repoPath: raw.repoPath,
    githubRepo: raw.githubRepo,
    baseBranch: raw.baseBranch || "origin/main",
    worktreeRoot: raw.worktreeRoot || "",
    checkCommand: raw.checkCommand || "git diff --check",
    autoMerge: raw.autoMerge === true,
    workerInstructions: raw.workerInstructions || DEFAULT_WORKER_INSTRUCTIONS,
    workerLaunchPolicy: raw.workerLaunchPolicy || DEFAULT_WORKER_LAUNCH_POLICY,
    workerAgent: normalizeAgentKind(raw.workerAgent, "workerAgent"),
    workerModel: raw.workerModel || "",
    reviewerAgent: normalizeAgentKind(raw.reviewerAgent, "reviewerAgent"),
    reviewerModel: raw.reviewerModel || "",
    labels: normalizeLabels(raw.labels || {}),
    automations: [],
    configSource: configSource || defaultConfigSource(raw),
  };
  project.automations = (raw.automations || []).map((automation) => normalizeAutomation(project, automation));
  return project;
}

export function projectsFromConfig(
  config: unknown,
  only?: string | string[],
  options: ProjectsFromConfigOptions = {},
): NormalizedProject[] {
  const onlyIds = filterProjectIds(only);
  const projects =
    config && typeof config === "object" && Array.isArray((config as { projects?: unknown }).projects)
      ? (config as { projects: RawProject[] }).projects
      : [];
  return projects
    .filter((raw) => {
      if (!onlyIds.length) return true;
      const rawId = sanitizeId(raw.id || raw.githubRepo || raw.repoPath);
      return onlyIds.includes(rawId);
    })
    .map((raw) => {
      const layered = applyRepoPolicy(raw, options);
      return normalizeProject(layered.raw, layered.source);
    })
    .filter((project) => project.enabled);
}

export function parseProjectsConfig(
  text: string,
  only?: string | string[],
  options: ProjectsFromConfigOptions = {},
): ProjectConfigResolution {
  try {
    return { ok: true, projects: projectsFromConfig(JSON.parse(text || "{}"), only, options), warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `projects.json parse error: ${message}` };
  }
}

export function resolveProjectForTick(input: {
  cwd: string;
  configText: string;
  only?: string | string[];
  lockedProjectId?: string;
  configPath?: string;
  repoPolicyProvider?: RepoPolicyProvider;
}): TickProjectResolution {
  const config = parseProjectsConfig(input.configText, input.only, {
    configPath: input.configPath,
    repoPolicyProvider: input.repoPolicyProvider,
  });
  if (config.ok === false) return { ok: false, reason: config.reason };
  const project = config.projects.find((candidate) => {
    if (!candidate.repoPath) return false;
    try {
      return isPathInside(input.cwd, candidate.repoPath);
    } catch {
      return input.cwd === candidate.repoPath;
    }
  });
  if (!project) return { ok: false, reason: "active project is not present in projects.json" };
  if (input.lockedProjectId && project.id !== input.lockedProjectId) {
    return { ok: false, reason: "active project changed since scheduler lock was acquired" };
  }
  return { ok: true, project };
}

export function codeFreshnessWarning(loadedAtMs: number, sources: CodeSourceMtime[]): string | null {
  return sources.some((source) => source.mtimeMs > loadedAtMs) ? EXTENSION_CODE_CHANGED_WARNING : null;
}

export function parseEveryMinutes(schedule: unknown): number | null {
  const match = /^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/.exec(String(schedule || "").trim());
  if (!match) return null;
  const minutes = Number(match[1]);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return minutes;
}

export function cronSlotAt(nowMs: number, intervalMinutes: number): number {
  const intervalMs = intervalMinutes * 60_000;
  return Math.floor(nowMs / intervalMs) * intervalMs;
}

export function automationStateKey(
  project: Pick<NormalizedProject, "id">,
  automation: Pick<NormalizedAutomation, "id">,
): string {
  return `${project.id}:${automation.id}`;
}

export function getDueSlot(
  automation: Pick<NormalizedAutomation, "schedule" | "graceMinutes" | "initialLastScheduledAt">,
  entry: AutomationStateEntry,
  nowMs: number,
): number | null {
  const intervalMinutes = parseEveryMinutes(automation.schedule);
  if (!intervalMinutes) return null;

  const latestSlot = cronSlotAt(nowMs, intervalMinutes);
  const lastScheduledAt = Number.isFinite(entry.lastScheduledAt)
    ? entry.lastScheduledAt!
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

export function nextSlotAfter(
  entry: Pick<AutomationStateEntry, "lastScheduledAt">,
  automation: Pick<NormalizedAutomation, "schedule" | "initialLastScheduledAt">,
  nowMs: number,
): number | null {
  const intervalMinutes = parseEveryMinutes(automation.schedule);
  if (!intervalMinutes) return null;
  const intervalMs = intervalMinutes * 60_000;
  const lastScheduledAt = Number.isFinite(entry.lastScheduledAt)
    ? entry.lastScheduledAt!
    : automation.initialLastScheduledAt;
  const candidate = lastScheduledAt + intervalMs;
  if (candidate > nowMs) return candidate;
  return cronSlotAt(nowMs, intervalMinutes) + intervalMs;
}

export function templateValues(
  project: NormalizedProject,
  automation: NormalizedAutomation,
  automationDir: string,
): TemplateValueMap {
  return {
    projectId: project.id,
    repoPath: project.repoPath,
    githubRepo: project.githubRepo,
    baseBranch: project.baseBranch,
    worktreeRoot: project.worktreeRoot || "",
    checkCommand: project.checkCommand || "git diff --check",
    autoMerge: project.autoMerge,
    workerInstructions: project.workerInstructions || "",
    workerLaunchPolicy: project.workerLaunchPolicy || "",
    workerAgent: project.workerAgent,
    workerModel: project.workerModel || "",
    reviewerAgent: project.reviewerAgent,
    reviewerModel: project.reviewerModel || "",
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
    automationDir,
  };
}

export function renderTemplate(text: string, values: TemplateValueMap): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key) => {
    const value = values[key];
    return value == null ? "" : String(value);
  });
}
