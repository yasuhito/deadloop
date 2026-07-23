const path = require("node:path") as typeof import("node:path");

type EnablementIdentityValue = {
  repoPath: string;
  githubRepo: string;
};

type EnabledProjectValue = EnablementIdentityValue & {
  enabledAt: number;
  firstEnableAutoMerge?: boolean;
  firstStartPending?: boolean;
  lastObservedAutoMerge?: boolean;
  autoMergeAcknowledged?: boolean;
  enabled?: boolean;
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
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) || !validIdentity(candidate)) return null;
    const record = candidate as EnabledProjectValue;
    if (!Number.isFinite(record.enabledAt)) return null;
    for (const field of ["firstEnableAutoMerge", "firstStartPending", "lastObservedAutoMerge", "autoMergeAcknowledged", "enabled"] as const) {
      if (record[field] !== undefined && typeof record[field] !== "boolean") return null;
    }
    normalized.push({
      repoPath: path.resolve(record.repoPath),
      githubRepo: record.githubRepo,
      enabledAt: Number(record.enabledAt),
      ...(record.firstEnableAutoMerge === undefined ? {} : { firstEnableAutoMerge: record.firstEnableAutoMerge }),
      ...(record.firstStartPending === undefined ? {} : { firstStartPending: record.firstStartPending }),
      ...(record.lastObservedAutoMerge === undefined ? {} : { lastObservedAutoMerge: record.lastObservedAutoMerge }),
      ...(record.autoMergeAcknowledged === undefined ? {} : { autoMergeAcknowledged: record.autoMergeAcknowledged }),
      ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
    });
  }
  return { projects: normalized };
}

module.exports = { normalizeEnablementStateValue, validIdentity };
