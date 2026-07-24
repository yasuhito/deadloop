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
  githubAliases?: string[];
  baseBranch?: string;
  firstEnableAutoMerge: boolean;
  firstStartPending: boolean;
  lastObservedAutoMerge: boolean;
  autoMergeAcknowledged: boolean;
  enabled: boolean;
};

type EnablementStateValue = { projects: EnabledProjectValue[] };

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
  const candidates = (value as { projects?: unknown }).projects;
  if (!Array.isArray(candidates)) return null;
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
    if (record.githubAliases !== undefined && (
      !Array.isArray(record.githubAliases)
      || record.githubAliases.length === 0
      || record.githubAliases.some((alias) => typeof alias !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(alias))
    )) return null;
    if (record.baseBranch !== undefined && (
      typeof record.baseBranch !== "string" || !record.baseBranch.startsWith("origin/")
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
      ...(record.githubAliases === undefined ? {} : { githubAliases: [...new Set(record.githubAliases)] }),
      ...(record.baseBranch === undefined ? {} : { baseBranch: record.baseBranch }),
      firstEnableAutoMerge: record.firstEnableAutoMerge,
      firstStartPending: record.firstStartPending,
      lastObservedAutoMerge: record.lastObservedAutoMerge,
      autoMergeAcknowledged: record.autoMergeAcknowledged,
      enabled: record.enabled,
    });
  }
  return { projects: normalized };
}

module.exports = { normalizeEnablementStateValue, validIdentity };
