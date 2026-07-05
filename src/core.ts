import path from "node:path";

export const DEFAULT_TIMEZONE = "Asia/Tokyo";

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

export type WorkerAgent = "pi" | "claude";

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
  reviewerModel?: string;
  labels?: LabelConfig;
  automations?: RawAutomation[];
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
  reviewerModel: string;
  labels: NormalizedLabels;
  automations: NormalizedAutomation[];
};

export type AutomationStateEntry = {
  lastScheduledAt?: number;
  lastResult?: string;
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

export type ProjectConfigResolution = { ok: true; projects: NormalizedProject[] } | { ok: false; reason: string };

export type TickProjectResolution = { ok: true; project: NormalizedProject } | { ok: false; reason: string };

export type CodeSourceMtime = {
  path: string;
  mtimeMs: number;
};

export function resolveConfigPath(options: ConfigPathOptions): string {
  const env = options.env || {};
  if (env.PI_LOOPER_CONFIG) return env.PI_LOOPER_CONFIG;
  if (env.HERDR_LOOPER_CONFIG) return env.HERDR_LOOPER_CONFIG;

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

function normalizeWorkerAgent(value: unknown): WorkerAgent {
  if (value === undefined) return "pi";
  if (value === "pi" || value === "claude") return value;
  throw new Error(`invalid workerAgent: ${String(value)} (expected "pi" or "claude")`);
}

export function normalizeProject(raw: RawProject): NormalizedProject {
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
    workerAgent: normalizeWorkerAgent(raw.workerAgent),
    workerModel: raw.workerModel || "",
    reviewerModel: raw.reviewerModel || "",
    labels: normalizeLabels(raw.labels || {}),
    automations: [],
  };
  project.automations = (raw.automations || []).map((automation) => normalizeAutomation(project, automation));
  return project;
}

export function projectsFromConfig(config: unknown, only?: string | string[]): NormalizedProject[] {
  const onlyIds = filterProjectIds(only);
  const projects =
    config && typeof config === "object" && Array.isArray((config as { projects?: unknown }).projects)
      ? (config as { projects: RawProject[] }).projects
      : [];
  return projects
    .map(normalizeProject)
    .filter((project) => project.enabled)
    .filter((project) => !onlyIds.length || onlyIds.includes(project.id));
}

export function parseProjectsConfig(text: string, only?: string | string[]): ProjectConfigResolution {
  try {
    return { ok: true, projects: projectsFromConfig(JSON.parse(text || "{}"), only) };
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
}): TickProjectResolution {
  const config = parseProjectsConfig(input.configText, input.only);
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
