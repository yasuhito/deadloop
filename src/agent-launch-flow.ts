const path = require("node:path") as typeof import("node:path");
const {
  herdrTabCreateCommand,
  herdrTabId,
  herdrWorktreeCreateCommand,
  herdrWorktreeOpenCommand,
  herdrWorktreePath,
  herdrWorkspaceId,
} = require("./herdr-adapter.ts");

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
  runJson: (args: string[]) => Record<string, any>;
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

function worktreeCommand(input: AgentLaunchFlowInput): string[] {
  if (input.worktree.mode === "create") {
    return herdrWorktreeCreateCommand({
      repoPath: input.repoPath,
      branch: input.worktree.branch,
      baseBranch: input.worktree.baseBranch,
      label: input.name,
    });
  }

  return herdrWorktreeOpenCommand({ repoPath: input.repoPath, branch: input.worktree.branch, label: input.name });
}

function launchAgentFlow(input: AgentLaunchFlowInput, ops: AgentLaunchFlowOps): AgentLaunchFlowResult {
  const worktreeResult = ops.runJson(worktreeCommand(input));
  const workspaceId = herdrWorkspaceId(worktreeResult);
  const worktreePath = herdrWorktreePath(worktreeResult);
  if (!workspaceId || !worktreePath) {
    const action = input.worktree.mode === "create" ? "create" : "open";
    throw new Error(`herdr worktree ${action} did not return workspace id and path`);
  }

  const tabResult = ops.runJson(herdrTabCreateCommand({ workspaceId, cwd: worktreePath, label: input.name }));
  const tabId = herdrTabId(tabResult);
  if (!tabId) throw new Error("herdr tab create did not return tab id");

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
