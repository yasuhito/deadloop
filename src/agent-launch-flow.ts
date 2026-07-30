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
  stateDir: string;
  name: string;
  agent: string;
  model: string;
  level: string;
  uuid: string;
  promptFilePrefix: string;
  resolveWorktreeHead?: boolean;
  renderPrompt: (input: { promiseFile: string; worktreePath: string; worktreeHead?: string }) => string;
};

type AgentLaunchFlowOps = {
  mkdirSync: (dir: string, options: { recursive: true }) => void;
  runner?: RunnerAdapter;
  runText: (args: string[]) => string;
  writeFileSync: (file: string, text: string, encoding: "utf8") => void;
  beforeAgentStart?: () => void;
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

function retireFinishedSameNameAgent(name: string, worktreePath: string, runner: RunnerAdapter): void {
  const matches = runner.listAgents().filter((agent) => agent.name === name);
  if (!matches.length) return;
  if (matches.length !== 1) throw new Error(`agent name ${name} has ${matches.length} live candidates; refusing cleanup`);

  const [agent] = matches;
  if (agent.status !== "done") throw new Error(`agent name ${name} is ${agent.status || "unknown"}; refusing duplicate launch`);
  if (path.resolve(agent.cwd || "") !== path.resolve(worktreePath)) {
    throw new Error(`agent name ${name} belongs to a different worktree; refusing cleanup`);
  }
  if (!agent.agentId) throw new Error(`agent name ${name} has no removable agent id; refusing cleanup`);
  runner.removeAgent(agent.agentId);
}

function launchAgentFlow(input: AgentLaunchFlowInput, ops: AgentLaunchFlowOps): AgentLaunchFlowResult {
  const runner = ops.runner || createHerdrRunner();
  const { workspaceId, worktreePath } = prepareWorktree(input, runner);
  retireFinishedSameNameAgent(input.name, worktreePath, runner);
  const { tabId } = runner.createTab({ workspaceId, cwd: worktreePath, label: input.name });

  const runDir = path.join(input.stateDir, "runs", path.basename(input.uuid));
  ops.mkdirSync(runDir, { recursive: true });
  const promptFile = path.join(runDir, `${input.promptFilePrefix}.md`);
  const promiseFile = path.join(runDir, "promise.json");
  let worktreeHead: string | undefined;
  if (input.resolveWorktreeHead) {
    worktreeHead = ops.runText(["git", "-C", worktreePath, "rev-parse", "--verify", "HEAD^{commit}"]).trim();
    if (!/^[0-9a-f]{40}$/i.test(worktreeHead)) throw new Error("created worktree HEAD is not an exact commit SHA");
  }
  ops.writeFileSync(promptFile, input.renderPrompt({ promiseFile, worktreePath, worktreeHead }), "utf8");

  ops.beforeAgentStart?.();
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
