import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  automationEnvironment,
  parseProjectsConfig,
  resolveConfigPath,
  type NormalizedProject,
  type RawProject,
} from "../../src/core";
import type { RunnerAdapter } from "../../src/runner";
import { buildDoctorSnapshot, formatDoctorReport } from "../../src/doctor";
import { buildStatusSnapshot, formatStatusReport } from "../../src/status";

const { decideCiFallback } = require("../../extensions/deadloop/automations/ci-fallback-decision.ts") as {
  decideCiFallback: (
    data: unknown,
    jobsData: unknown,
    logText: string,
    enabled: boolean,
    mode: string,
    maxImmediateSeconds: number,
  ) => Record<string, unknown>;
};
const { main: launchAgent } = require("../../extensions/deadloop/automations/launch-agent.ts") as {
  main: (argv: string[], options: Record<string, unknown>) => string;
};
const {
  envConfig: workerEnvironment,
  launchIssueWorkerFlow,
} = require("../../extensions/deadloop/automations/issue-coordinator-driver.ts") as {
  envConfig: (source: NodeJS.ProcessEnv) => Record<string, any>;
  launchIssueWorkerFlow: (issue: Record<string, unknown>, env: Record<string, any>, ops: Record<string, unknown>) => unknown;
};
const {
  envConfig: reviewerEnvironment,
  launchPrReviewerFlow,
} = require("../../extensions/deadloop/automations/pr-reviewer-driver.ts") as {
  envConfig: (source: NodeJS.ProcessEnv) => Record<string, any>;
  launchPrReviewerFlow: (
    pr: Record<string, unknown>,
    env: Record<string, any>,
    reason: string,
    ops: Record<string, unknown>,
  ) => unknown;
};
function selectedAutomation(project: NormalizedProject, driver: string) {
  const automation = project.automations.find((candidate) => candidate.driverFile.endsWith(driver));
  if (!automation) throw new Error(`missing ${driver} automation`);
  return automation;
}

function observeAgentLaunch(project: NormalizedProject, role: "worker" | "reviewer"): string[] {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-configuration-launch-"));
  let agentArgv: string[] | undefined;
  let launchedAgent: { name: string; paneId: string; cwd: string } | undefined;
  const checkout = (branch: string) => path.join(sandbox, branch.replace(/\//g, "-"));

  const runner: RunnerAdapter = {
    createWorktree: (input) => ({ workspaceId: "workspace", tabId: "tab", rootPaneId: "pane", worktreePath: checkout(input.branch) }),
    openWorktree: (input) => ({ workspaceId: "workspace", tabId: "tab", rootPaneId: "pane", worktreePath: checkout(input.branch) }),
    renameWorkspace: () => "",
    startAgent: () => "",
    closeWorkspace: () => "",
    listWorkspaces: () => [],
    listWorktrees: () => role === "reviewer"
      ? [{ path: checkout("agent/configuration-observation"), branch: "agent/configuration-observation" }]
      : [],
    listAgents: () => launchedAgent ? [{ ...launchedAgent, status: "working" }] : [],
    removeWorktree: () => "",
  };
  const ops = {
    mkdirSync: fs.mkdirSync,
    runner,
    runText: (command: string[]) => {
      if (command[0] === "git") return `${"a".repeat(40)}\n`;
      return launchAgent(command.slice(2), {
        readClaudeConfig: () => ({ projects: { "/repo": { hasTrustDialogAccepted: true } } }),
        runner: {
          startAgent: (input: { name: string; kind: string; rootPaneId: string; nativeAgentArgv: string[] }) => {
            agentArgv = [input.kind, ...input.nativeAgentArgv];
            launchedAgent = { name: input.name, paneId: input.rootPaneId, cwd: command[command.indexOf("--cwd") + 1] };
            return "{}\n";
          },
        },
        writeOutput: false,
      });
    },
    writeFileSync: fs.writeFileSync,
  };

  try {
    if (role === "worker") {
      const automation = selectedAutomation(project, "issue-coordinator-driver.ts");
      const env = workerEnvironment({
        ...process.env,
        ...automationEnvironment(project, automation),
        DEADLOOP_STATE_DIR: sandbox,
        DEADLOOP_WORKTREE_ROOT: sandbox,
        DEADLOOP_GITHUB_REPO: project.githubRepo || "owner/repo",
      });
      launchIssueWorkerFlow({ number: 12, title: "configuration observation" }, env, ops);
    } else {
      const automation = selectedAutomation(project, "pr-reviewer-driver.ts");
      const env = reviewerEnvironment({
        ...process.env,
        ...automationEnvironment(project, automation),
        DEADLOOP_STATE_DIR: sandbox,
        DEADLOOP_WORKTREE_ROOT: sandbox,
        DEADLOOP_GITHUB_REPO: project.githubRepo || "owner/repo",
      });
      launchPrReviewerFlow(
        { number: 24, headRefName: "agent/configuration-observation", headRefOid: "a".repeat(40) },
        env,
        "configuration observation",
        ops,
      );
    }
    if (!agentArgv) throw new Error("agent launch did not reach the launcher boundary");
    return agentArgv;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

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
      ? () => ({ status: "loaded", text: JSON.stringify(input.policy), baseRevision: "b".repeat(40) })
      : () => ({ status: "missing", baseRevision: "b".repeat(40) }),
  });
  if (result.ok === false) throw new Error(result.reason);
  const project = result.projects[0];
  if (!project) throw new Error("selected configuration has no active project");
  return project;
}

export function observeStatus(project: NormalizedProject, cwd = "/repo"): string {
  return formatStatusReport(buildStatusSnapshot({ cwd, projects: [project], selectedProject: project, nowMs: 0 }));
}

export function observeDoctor(project: NormalizedProject, cwd = "/repo"): string {
  return formatDoctorReport(buildDoctorSnapshot({ cwd, projects: [project], selectedProject: project, nowMs: 0 }));
}

export function observeWorkerLaunch(project: NormalizedProject): string[] {
  return observeAgentLaunch(project, "worker");
}

export function observeReviewerLaunch(project: NormalizedProject): string[] {
  return observeAgentLaunch(project, "reviewer");
}

export function observeCiFallbackDecision(project: NormalizedProject): Record<string, unknown> {
  const automation = selectedAutomation(project, "pr-reviewer-driver.ts");
  const environment = automationEnvironment(project, automation);
  const fixture = path.join(process.cwd(), "test/fixtures/ci-fallback/qorraq-all-jobs-immediate-failure.json");
  const input = JSON.parse(fs.readFileSync(fixture, "utf8")) as unknown;
  return decideCiFallback(
    input,
    null,
    "",
    environment.DEADLOOP_CI_FALLBACK_ENABLED === "1",
    environment.DEADLOOP_CI_FALLBACK_MODE ?? "",
    5,
  );
}
