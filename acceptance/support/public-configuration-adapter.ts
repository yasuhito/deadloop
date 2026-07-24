import {
  parseProjectsConfig,
  resolveConfigPath,
  type NormalizedProject,
  type RawProject,
} from "../../src/core";
import { buildStatusSnapshot, formatStatusReport } from "../../src/status";

const { buildAgentArgv } = require("../../src/agent-profiles.cjs") as {
  buildAgentArgv: (input: {
    agent: "pi" | "claude";
    name: string;
    level: string;
    model: string;
    uuid: string;
    promptFile: string;
    promptText: string;
  }) => string[];
};
const { decideCiFallback } = require("../../extensions/deadloop/automations/ci-fallback-decision.ts") as {
  decideCiFallback: (
    data: unknown,
    jobs: unknown,
    logs: string,
    enabled: boolean,
    mode: string,
    maxImmediateSeconds: number,
  ) => { fallbackAllowed: boolean; reason: string };
};

export type ConfigurationObservation = {
  status?: string;
  workerLaunch?: string[];
  reviewerLaunch?: string[];
  ciFallbackAllowed?: boolean;
};

export function resolveSelectedProject(input: {
  env?: Record<string, string | undefined>;
  files: Record<string, RawProject>;
  stateDir?: string;
  extensionDir?: string;
  policy?: RawProject;
}): NormalizedProject {
  const selectedPath = resolveConfigPath({
    env: input.env,
    stateDir: input.stateDir ?? "/state",
    extensionDir: input.extensionDir ?? "/extension",
    exists: (file) => Object.hasOwn(input.files, file),
  });
  const raw = input.files[selectedPath];
  if (!raw) throw new Error(`selected configuration is unreadable: ${selectedPath}`);
  const result = parseProjectsConfig(JSON.stringify({ projects: [{ id: "demo", repoPath: "/repo", ...raw }] }), "", {
    configPath: selectedPath,
    repoPolicyProvider: input.policy
      ? () => ({ status: "loaded", text: JSON.stringify(input.policy) })
      : () => ({ status: "missing" }),
  });
  if (result.ok === false) throw new Error(result.reason);
  const project = result.projects[0];
  if (!project) throw new Error("selected configuration has no active project");
  return project;
}

export function observeConfiguration(project: NormalizedProject): ConfigurationObservation {
  const status = formatStatusReport(
    buildStatusSnapshot({ cwd: "/repo", projects: [project], nowMs: 0 }),
  );
  const launch = (agent: "pi" | "claude", model: string, role: string): string[] =>
    buildAgentArgv({
      agent,
      model,
      name: `demo-${role}`,
      level: "medium",
      uuid: "00000000-0000-4000-8000-000000000001",
      promptFile: `/tmp/${role}.md`,
      promptText: `${role} instructions`,
    });
  const ciDecision = decideCiFallback(
    { statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }] },
    null,
    "GitHub Actions disabled because of billing",
    project.ciFallback.enabled,
    project.ciFallback.mode,
    5,
  );
  return {
    status,
    workerLaunch: launch(project.workerAgent, project.workerModel, "worker"),
    reviewerLaunch: launch(project.reviewerAgent, project.reviewerModel, "reviewer"),
    ciFallbackAllowed: ciDecision.fallbackAllowed,
  };
}
