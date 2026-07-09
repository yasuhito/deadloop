const path = require("node:path") as typeof import("node:path");
const { createHerdrRunner } = require("./herdr-runner.ts");

import type { RunnerAdapter } from "./runner";

type WorktreeRequest =
  | { mode: "create"; branch: string; baseBranch: string }
  | { mode: "open"; branch: string };

type AgentLaunchFlowInput = {
  worktree: WorktreeRequest;
  repoPath: string;
  automationDir: string;
  name: string;
  agent: string;
  model: string;
  level: string;
  uuid: string;
  promptFilePrefix: string;
  renderPrompt: (input: { promiseFile: string; worktreePath: string }) => string;
};

type AgentLaunchFlowOps = {
  mkdirSync: (dir: string, options: { recursive: true }) => void;
  runner?: RunnerAdapter;
  runText: (args: string[]) => string;
  writeFileSync: (file: string, text: string, encoding: "utf8") => void;
};

type AgentLaunchFlowResult = {
  workspaceId: string;
  tabId: string;
  worktreePath: string;
  promptFile: string;
  promiseFile: string;
  launchOutput: string;
};

function prepareWorktree(input: AgentLaunchFlowInput, runner: RunnerAdapter): { workspaceId: string; worktreePath: string } {
  if (input.worktree.mode === "create") {
    return runner.createWorktree({
      repoPath: input.repoPath,
      branch: input.worktree.branch,
      baseBranch: input.worktree.baseBranch,
      label: input.name,
    });
  }

  return runner.openWorktree({ repoPath: input.repoPath, branch: input.worktree.branch, label: input.name });
}

function launchAgentFlow(input: AgentLaunchFlowInput, ops: AgentLaunchFlowOps): AgentLaunchFlowResult {
  const runner = ops.runner || createHerdrRunner();
  const { workspaceId, worktreePath } = prepareWorktree(input, runner);
  const { tabId } = runner.createTab({ workspaceId, cwd: worktreePath, label: input.name });

  const stateDir = path.join(worktreePath, ".deadloop");
  ops.mkdirSync(stateDir, { recursive: true });
  const promptFile = path.join(stateDir, `${input.promptFilePrefix}-${input.uuid}.md`);
  const promiseFile = path.join(stateDir, `promise-${input.uuid}.json`);
  ops.writeFileSync(promptFile, input.renderPrompt({ promiseFile, worktreePath }), "utf8");

  const launchOutput = ops.runText([
    "node",
    path.join(input.automationDir, "launch-agent.ts"),
    "--agent",
    input.agent,
    "--name",
    input.name,
    "--cwd",
    worktreePath,
    "--repo-path",
    input.repoPath,
    "--level",
    input.level,
    "--model",
    input.model,
    "--uuid",
    input.uuid,
    "--prompt-file",
    promptFile,
    "--tab",
    tabId,
  ]);

  return { workspaceId, tabId, worktreePath, promptFile, promiseFile, launchOutput };
}

module.exports = { launchAgentFlow };
