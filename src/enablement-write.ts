import type { EnablementState, EnabledProject } from "./enablement";

function previousAutomationLogin(value: unknown, project: EnabledProject): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const projects = (value as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return undefined;
  const previous = projects.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const record = candidate as Partial<EnabledProject>;
    return record.githubRepositoryId === project.githubRepositoryId;
  }) as Partial<EnabledProject> | undefined;
  const login = previous?.automationLogin;
  return typeof login === "string" && login.trim() ? login.trim().toLowerCase() : undefined;
}

export function preserveEnablementAutomationLogins(previous: unknown, next: EnablementState): EnablementState {
  return {
    projects: next.projects.map((project) => {
      if (project.automationLogin) return project;
      const automationLogin = previousAutomationLogin(previous, project);
      return automationLogin ? { ...project, automationLogin } : project;
    }),
  };
}
