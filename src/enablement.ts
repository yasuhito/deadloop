import path from "node:path";

export type EnabledProject = {
  repoPath: string;
  githubRepo: string;
  enabledAt: number;
  firstEnableConfigMtimeMs?: number;
  firstEnableAutoMerge?: boolean;
};

export type EnablementState = { projects: EnabledProject[] };

export type ProjectIdentity = Pick<EnabledProject, "repoPath" | "githubRepo">;

function normalizedPath(value: string): string {
  return path.resolve(value);
}

function validIdentity(value: Partial<ProjectIdentity>): value is ProjectIdentity {
  return Boolean(value.repoPath && value.githubRepo && /^[^/\s]+\/[^/\s]+$/.test(value.githubRepo));
}

export function normalizeEnablementState(value: unknown): EnablementState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const projects = (value as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return null;
  const normalized: EnabledProject[] = [];
  for (const candidate of projects) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const project = candidate as Partial<EnabledProject>;
    const enabledAt = project.enabledAt;
    const firstEnableConfigMtimeMs = project.firstEnableConfigMtimeMs;
    const firstEnableAutoMerge = project.firstEnableAutoMerge;
    if (!validIdentity(project) || !Number.isFinite(enabledAt)) return null;
    if (firstEnableConfigMtimeMs !== undefined && !Number.isFinite(firstEnableConfigMtimeMs)) return null;
    if (firstEnableAutoMerge !== undefined && typeof firstEnableAutoMerge !== "boolean") return null;
    normalized.push({
      repoPath: normalizedPath(project.repoPath),
      githubRepo: project.githubRepo,
      enabledAt: Number(enabledAt),
      ...(firstEnableConfigMtimeMs === undefined ? {} : { firstEnableConfigMtimeMs: Number(firstEnableConfigMtimeMs) }),
      ...(firstEnableAutoMerge === undefined ? {} : { firstEnableAutoMerge }),
    });
  }
  return { projects: normalized };
}

export function findEnabledProject(state: EnablementState | null, identity: ProjectIdentity): EnabledProject | null {
  if (!state || !validIdentity(identity)) return null;
  const repoPath = normalizedPath(identity.repoPath);
  return state.projects.find((project) => project.repoPath === repoPath && project.githubRepo === identity.githubRepo) || null;
}

export function isEnabledProjectState(state: EnablementState | null, identity: ProjectIdentity): boolean {
  return findEnabledProject(state, identity) !== null;
}

export function upsertEnabledProject(
  state: EnablementState | null,
  identity: ProjectIdentity,
  now = Date.now(),
  firstEnable: Pick<EnabledProject, "firstEnableConfigMtimeMs" | "firstEnableAutoMerge"> = {},
): EnablementState {
  if (!validIdentity(identity)) throw new Error("invalid project identity");
  const repoPath = normalizedPath(identity.repoPath);
  const existing = state?.projects || [];
  const retained = existing.filter((project) => project.githubRepo !== identity.githubRepo && project.repoPath !== repoPath);
  return { projects: [...retained, { repoPath, githubRepo: identity.githubRepo, enabledAt: now, ...firstEnable }] };
}

export function removeEnabledProject(state: EnablementState | null, identity: ProjectIdentity): EnablementState {
  if (!validIdentity(identity)) throw new Error("invalid project identity");
  const repoPath = normalizedPath(identity.repoPath);
  return {
    projects: (state?.projects || []).filter(
      (project) => !(project.repoPath === repoPath && project.githubRepo === identity.githubRepo),
    ),
  };
}

export function removeEnabledProjectAtPath(state: EnablementState | null, repoPath: string): EnablementState {
  const normalized = normalizedPath(repoPath);
  return { projects: (state?.projects || []).filter((project) => project.repoPath !== normalized) };
}
