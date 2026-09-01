import path from "node:path";

const { normalizeEnablementStateValue, validIdentity } = require("./enablement-state.cts");

export type EnabledProject = {
  repoPath: string;
  githubRepo: string;
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

export type EnablementState = { projects: EnabledProject[] };

/** The persisted shared enablement state always names the Automation host code that wrote it. */
export type EnablementStateFile = EnablementState & { lastWriterCodeIdentity: string };

export type ProjectIdentity = Pick<EnabledProject, "repoPath" | "githubRepo"> &
  Partial<Pick<EnabledProject, "githubRepositoryId" | "baseBranch" | "automationLogin" | "disableGeneration">>;

function normalizedPath(value: string): string {
  return path.resolve(value);
}

export function normalizeEnablementState(value: unknown): EnablementStateFile | null {
  return normalizeEnablementStateValue(value);
}

export function findEnabledProject(state: EnablementState | null, identity: ProjectIdentity): EnabledProject | null {
  if (!state || !validIdentity(identity)) return null;
  const repoPath = normalizedPath(identity.repoPath);
  return state.projects.find((project) => project.repoPath === repoPath && project.githubRepo === identity.githubRepo && project.enabled !== false) || null;
}

export function isEnabledProjectState(state: EnablementState | null, identity: ProjectIdentity): boolean {
  return findEnabledProject(state, identity) !== null;
}

export function upsertEnabledProject(
  state: EnablementState | null,
  identity: ProjectIdentity,
  now = Date.now(),
  firstEnable: Pick<EnabledProject, "firstEnableAutoMerge"> = { firstEnableAutoMerge: false },
  enableAttemptToken?: string,
): EnablementState {
  if (!validIdentity(identity) || typeof identity.githubRepositoryId !== "string" || !identity.githubRepositoryId) {
    throw new Error("invalid project identity");
  }
  const repoPath = normalizedPath(identity.repoPath);
  const existing = state?.projects || [];
  const previous = existing.find((project) => project.githubRepositoryId === identity.githubRepositoryId);
  const retained = existing.filter((project) =>
    project.githubRepositoryId !== identity.githubRepositoryId
    && project.githubRepo !== identity.githubRepo
    && project.repoPath !== repoPath
  );
  const enabledAt = previous && previous.enabled !== false
    ? previous.enabledAt
    : Math.max(now, (previous?.enabledAt ?? 0) + 1);
  return {
    projects: [
      ...retained,
      {
        ...(previous || {
          ...firstEnable,
          firstStartPending: true,
          // Preserve the configured value seen at enablement. A pre-existing true
          // must not look like a post-enable choice on the next scheduler tick.
          lastObservedAutoMerge: firstEnable.firstEnableAutoMerge,
          autoMergeAcknowledged: false,
        }),
        repoPath,
        githubRepo: identity.githubRepo,
        githubRepositoryId: identity.githubRepositoryId,
        enabledAt,
        disableGeneration: identity.disableGeneration ?? previous?.disableGeneration ?? 0,
        ...(enableAttemptToken ? { enableAttemptToken } : {}),
        ...(identity.baseBranch ? { baseBranch: identity.baseBranch } : {}),
        ...(identity.automationLogin ? { automationLogin: identity.automationLogin.trim().toLowerCase() } : {}),
        enabled: true,
      },
    ],
  };
}

export function observeAutoMerge(state: EnablementState, identity: ProjectIdentity, autoMerge: boolean): EnablementState {
  if (!validIdentity(identity)) throw new Error("invalid project identity");
  const repoPath = normalizedPath(identity.repoPath);
  return {
    projects: state.projects.map((project) => {
      if (project.repoPath !== repoPath || project.githubRepo !== identity.githubRepo) return project;
      const autoMergeAcknowledged = project.autoMergeAcknowledged || (
        project.firstEnableAutoMerge === true
        && project.firstStartPending === false
        && project.lastObservedAutoMerge === false
        && autoMerge === true
      );
      const lastObservedAutoMerge = project.firstStartPending ? project.lastObservedAutoMerge : autoMerge;
      return { ...project, lastObservedAutoMerge, autoMergeAcknowledged };
    }),
  };
}

export function removeEnabledProjectGeneration(
  state: EnablementState | null,
  identity: ProjectIdentity,
  enabledAt: number,
): EnablementState {
  const enabled = findEnabledProject(state, identity);
  return enabled?.enabledAt === enabledAt ? removeEnabledProject(state, identity) : state || { projects: [] };
}

export function removeEnabledProjectAttempt(
  state: EnablementState | null,
  identity: ProjectIdentity,
  enabledAt: number,
  enableAttemptToken: string,
): EnablementState {
  const enabled = findEnabledProject(state, identity);
  return enabled?.enabledAt === enabledAt && enabled.enableAttemptToken === enableAttemptToken
    ? removeEnabledProject(state, identity)
    : state || { projects: [] };
}

export function removeEnabledProject(state: EnablementState | null, identity: ProjectIdentity): EnablementState {
  if (!validIdentity(identity)) throw new Error("invalid project identity");
  const repoPath = normalizedPath(identity.repoPath);
  return {
    projects: (state?.projects || []).map((project) =>
      project.repoPath === repoPath && project.githubRepo === identity.githubRepo ? { ...project, enabled: false } : project,
    ),
  };
}

const ENABLED_PROJECT_FIELDS = [
  "repoPath",
  "githubRepo",
  "githubRepositoryId",
  "enabledAt",
  "disableGeneration",
  "enableAttemptToken",
  "baseBranch",
  "automationLogin",
  "firstEnableAutoMerge",
  "firstStartPending",
  "lastObservedAutoMerge",
  "autoMergeAcknowledged",
  "enabled",
] as const;

function sameEnabledProject(left: EnabledProject, right: EnabledProject): boolean {
  return ENABLED_PROJECT_FIELDS.every((field) => left[field] === right[field]);
}

/**
 * True when persisting `next` would not change any observable content, including the recorded
 * writer identity. Tick-time state re-derivations use this to skip no-op enablement writes.
 */
export function sameEnablementStateFile(
  previous: (Pick<EnablementStateFile, "projects"> & { lastWriterCodeIdentity?: string }) | null,
  next: (Pick<EnablementStateFile, "projects"> & { lastWriterCodeIdentity?: string }) | null,
): boolean {
  if (!previous || !next) return false;
  if ((previous.lastWriterCodeIdentity ?? "") !== (next.lastWriterCodeIdentity ?? "")) return false;
  const previousProjects = previous.projects ?? [];
  const nextProjects = next.projects ?? [];
  return previousProjects.length === nextProjects.length
    && previousProjects.every((project, index) => sameEnabledProject(project, nextProjects[index]));
}

export function removeEnabledProjectAtPath(state: EnablementState | null, repoPath: string): EnablementState {
  const normalized = normalizedPath(repoPath);
  return {
    projects: (state?.projects || []).map((project) =>
      project.repoPath === normalized ? { ...project, enabled: false } : project,
    ),
  };
}
