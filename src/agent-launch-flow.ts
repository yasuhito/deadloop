const path = require("node:path") as typeof import("node:path");

type JsonObject = Record<string, any>;

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
  runJson: (args: string[]) => JsonObject;
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

function findStringValue(value: unknown, keys: string[]): string {
  if (!value || typeof value !== "object") return "";
  const record = value as JsonObject;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) return record[key];
  }
  for (const child of Object.values(record)) {
    const found = findStringValue(child, keys);
    if (found) return found;
  }
  return "";
}

function worktreeCommand(input: AgentLaunchFlowInput): string[] {
  if (input.worktree.mode === "create") {
    return [
      "herdr",
      "worktree",
      "create",
      "--cwd",
      input.repoPath,
      "--branch",
      input.worktree.branch,
      "--base",
      input.worktree.baseBranch,
      "--label",
      input.name,
      "--no-focus",
      "--json",
    ];
  }

  return [
    "herdr",
    "worktree",
    "open",
    "--cwd",
    input.repoPath,
    "--branch",
    input.worktree.branch,
    "--label",
    input.name,
    "--no-focus",
    "--json",
  ];
}

function launchAgentFlow(input: AgentLaunchFlowInput, ops: AgentLaunchFlowOps): AgentLaunchFlowResult {
  const worktreeResult = ops.runJson(worktreeCommand(input));
  const workspaceId = findStringValue(worktreeResult, ["workspace_id", "workspaceId", "id"]);
  const worktreePath = findStringValue(worktreeResult, ["path", "worktreePath"]);
  if (!workspaceId || !worktreePath) {
    const action = input.worktree.mode === "create" ? "create" : "open";
    throw new Error(`herdr worktree ${action} did not return workspace id and path`);
  }

  const tabResult = ops.runJson([
    "herdr",
    "tab",
    "create",
    "--workspace",
    workspaceId,
    "--cwd",
    worktreePath,
    "--label",
    input.name,
    "--no-focus",
  ]);
  const tabId = findStringValue(tabResult, ["tab_id", "tabId", "id"]);
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
