import { spawnSync } from "node:child_process";
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
import { buildStatusSnapshot, formatStatusReport } from "../../src/status";

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
const { decideCiFallback } = require("../../extensions/deadloop/automations/ci-fallback-decision.ts") as {
  decideCiFallback: (
    data: unknown,
    jobs: unknown,
    logs: string,
    enabled: boolean,
    mode: string,
    maxImmediateSeconds: number,
  ) => { fallbackAllowed: boolean };
};

export type CiInfrastructureFailure = { checks: unknown; logs: string };

function selectedAutomation(project: NormalizedProject, driver: string) {
  const automation = project.automations.find((candidate) => candidate.driverFile.endsWith(driver));
  if (!automation) throw new Error(`missing ${driver} automation`);
  return automation;
}

function observeAgentLaunch(project: NormalizedProject, role: "worker" | "reviewer"): string[] {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-configuration-launch-"));
  const captureFile = path.join(sandbox, "herdr-argv.json");
  const fakeHerdr = path.join(sandbox, "herdr");
  fs.writeFileSync(
    fakeHerdr,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.DEADLOOP_CAPTURE_FILE, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write("{}\\n");\n`,
    "utf8",
  );
  fs.chmodSync(fakeHerdr, 0o755);
  fs.writeFileSync(path.join(sandbox, ".claude.json"), JSON.stringify({ projects: { "/repo": { hasTrustDialogAccepted: true } } }));

  const runner: RunnerAdapter = {
    createWorktree: () => ({ workspaceId: "workspace", worktreePath: sandbox }),
    openWorktree: () => ({ workspaceId: "workspace", worktreePath: sandbox }),
    createTab: () => ({ tabId: "tab" }),
    startAgent: () => "",
    listWorktrees: () => [],
    listAgents: () => [],
    removeAgent: () => "",
    removeWorktree: () => "",
  };
  const ops = {
    mkdirSync: fs.mkdirSync,
    runner,
    runText: (command: string[]) => {
      const result = spawnSync(command[0], command.slice(1), {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DEADLOOP_CAPTURE_FILE: captureFile,
          HOME: sandbox,
          PATH: `${sandbox}:${process.env.PATH || ""}`,
        },
      });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout || "agent launch failed");
      return result.stdout;
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
      });
      launchIssueWorkerFlow({ number: 12, title: "configuration observation" }, env, ops);
    } else {
      const automation = selectedAutomation(project, "pr-reviewer-driver.ts");
      const env = reviewerEnvironment({
        ...process.env,
        ...automationEnvironment(project, automation),
        DEADLOOP_STATE_DIR: sandbox,
      });
      launchPrReviewerFlow(
        { number: 24, headRefName: "agent/configuration-observation", headRefOid: "head" },
        env,
        "configuration observation",
        ops,
      );
    }
    const herdrArgv = JSON.parse(fs.readFileSync(captureFile, "utf8")) as string[];
    const separator = herdrArgv.indexOf("--");
    if (separator < 0) throw new Error("Herdr launch omitted the agent command separator");
    return herdrArgv.slice(separator + 1);
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
      ? () => ({ status: "loaded", text: JSON.stringify(input.policy) })
      : () => ({ status: "missing" }),
  });
  if (result.ok === false) throw new Error(result.reason);
  const project = result.projects[0];
  if (!project) throw new Error("selected configuration has no active project");
  return project;
}

export function observeStatus(project: NormalizedProject): string {
  return formatStatusReport(buildStatusSnapshot({ cwd: "/repo", projects: [project], nowMs: 0 }));
}

export function observeWorkerLaunch(project: NormalizedProject): string[] {
  return observeAgentLaunch(project, "worker");
}

export function observeReviewerLaunch(project: NormalizedProject): string[] {
  return observeAgentLaunch(project, "reviewer");
}

export function observeCiFallbackLaunches(
  project: NormalizedProject,
  failure: CiInfrastructureFailure,
  launchCommand: (command: string) => void,
): void {
  const decision = decideCiFallback(
    failure.checks,
    null,
    failure.logs,
    project.ciFallback.enabled,
    project.ciFallback.mode,
    5,
  );
  if (!decision.fallbackAllowed) return;
  for (const command of project.ciFallback.localCommands.split("\n").filter(Boolean)) launchCommand(command);
}
