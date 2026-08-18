const path = require("node:path") as typeof import("node:path");

type EnablementIdentityValue = {
  repoPath: string;
  githubRepo: string;
};

type EnabledProjectValue = EnablementIdentityValue & {
  githubRepositoryId: string;
  enabledAt: number;
  disableGeneration: number;
  enableAttemptToken?: string;
  baseBranch?: string;
  automationLogin?: string;
  firstEnableAutoMerge: boolean;
  firstStartPending: boolean;
  lastObservedAutoMerge: boolean;
  autoMergeAcknowledged: boolean;
  enabled: boolean;
};

type EnablementStateValue = { projects: EnabledProjectValue[]; lastWriterCodeIdentity?: string };

function validIdentity(value: unknown): value is EnablementIdentityValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<EnablementIdentityValue>;
  return Boolean(
    typeof candidate.repoPath === "string"
    && candidate.repoPath
    && typeof candidate.githubRepo === "string"
    && /^[^/\s]+\/[^/\s]+$/.test(candidate.githubRepo),
  );
}

function normalizeEnablementStateValue(value: unknown): EnablementStateValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as { projects?: unknown; lastWriterCodeIdentity?: unknown };
  const candidates = state.projects;
  if (!Array.isArray(candidates)) return null;
  if (state.lastWriterCodeIdentity !== undefined && (
    typeof state.lastWriterCodeIdentity !== "string" || !/^[0-9a-f]{40}$/i.test(state.lastWriterCodeIdentity)
  )) return null;
  const normalized: EnabledProjectValue[] = [];
  const repoPaths = new Set<string>();
  const githubRepos = new Set<string>();
  const githubRepositoryIds = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !validIdentity(candidate)) return null;
    const record = candidate as EnabledProjectValue;
    if (typeof record.githubRepositoryId !== "string" || !record.githubRepositoryId) return null;
    if (!Number.isFinite(record.enabledAt)) return null;
    if (record.disableGeneration !== undefined && (!Number.isSafeInteger(record.disableGeneration) || record.disableGeneration < 0)) return null;
    if (record.enableAttemptToken !== undefined && (typeof record.enableAttemptToken !== "string" || !record.enableAttemptToken)) return null;
    if (record.baseBranch !== undefined && (
      typeof record.baseBranch !== "string" || !record.baseBranch.startsWith("origin/")
    )) return null;
    if (record.automationLogin !== undefined && (
      typeof record.automationLogin !== "string" || !record.automationLogin.trim()
    )) return null;
    for (const field of ["firstEnableAutoMerge", "firstStartPending", "lastObservedAutoMerge", "autoMergeAcknowledged", "enabled"] as const) {
      if (typeof record[field] !== "boolean") return null;
    }
    const repoPath = path.resolve(record.repoPath);
    const githubRepo = record.githubRepo.toLowerCase();
    if (repoPaths.has(repoPath) || githubRepos.has(githubRepo) || githubRepositoryIds.has(record.githubRepositoryId)) return null;
    repoPaths.add(repoPath);
    githubRepos.add(githubRepo);
    githubRepositoryIds.add(record.githubRepositoryId);
    normalized.push({
      repoPath,
      githubRepo: record.githubRepo,
      githubRepositoryId: record.githubRepositoryId,
      enabledAt: Number(record.enabledAt),
      disableGeneration: record.disableGeneration ?? 0,
      ...(record.enableAttemptToken === undefined ? {} : { enableAttemptToken: record.enableAttemptToken }),
      ...(record.baseBranch === undefined ? {} : { baseBranch: record.baseBranch }),
      ...(record.automationLogin === undefined ? {} : { automationLogin: record.automationLogin.trim().toLowerCase() }),
      firstEnableAutoMerge: record.firstEnableAutoMerge,
      firstStartPending: record.firstStartPending,
      lastObservedAutoMerge: record.lastObservedAutoMerge,
      autoMergeAcknowledged: record.autoMergeAcknowledged,
      enabled: record.enabled,
    });
  }
  const lastWriterCodeIdentity = typeof state.lastWriterCodeIdentity === "string"
    ? state.lastWriterCodeIdentity.toLowerCase()
    : undefined;
  return {
    projects: normalized,
    ...(lastWriterCodeIdentity === undefined ? {} : { lastWriterCodeIdentity }),
  };
}

module.exports = { normalizeEnablementStateValue, validIdentity };
