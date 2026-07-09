type JsonObject = Record<string, any>;

type WorktreeCreateInput = {
  repoPath: string;
  branch: string;
  baseBranch: string;
  label: string;
};

type WorktreeOpenInput = {
  repoPath: string;
  branch: string;
  label: string;
};

type TabCreateInput = {
  workspaceId: string;
  cwd: string;
  label: string;
};

type AgentStartInput = {
  name: string;
  cwd: string;
  tabId?: string;
  agentArgv: string[];
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

function herdrWorktreeCreateCommand(input: WorktreeCreateInput): string[] {
  return [
    "herdr",
    "worktree",
    "create",
    "--cwd",
    input.repoPath,
    "--branch",
    input.branch,
    "--base",
    input.baseBranch,
    "--label",
    input.label,
    "--no-focus",
    "--json",
  ];
}

function herdrWorktreeOpenCommand(input: WorktreeOpenInput): string[] {
  return [
    "herdr",
    "worktree",
    "open",
    "--cwd",
    input.repoPath,
    "--branch",
    input.branch,
    "--label",
    input.label,
    "--no-focus",
    "--json",
  ];
}

function herdrTabCreateCommand(input: TabCreateInput): string[] {
  return [
    "herdr",
    "tab",
    "create",
    "--workspace",
    input.workspaceId,
    "--cwd",
    input.cwd,
    "--label",
    input.label,
    "--no-focus",
  ];
}

function herdrAgentStartCommand(input: AgentStartInput): string[] {
  const command = ["herdr", "agent", "start", input.name, "--cwd", input.cwd, "--no-focus"];
  if (input.tabId) command.push("--tab", input.tabId);
  command.push("--", ...input.agentArgv);
  return command;
}

function herdrWorktreeListArgs(repoPath: string): string[] {
  return ["worktree", "list", "--cwd", repoPath, "--json"];
}

function herdrWorktreeListCommand(repoPath: string): string[] {
  return ["herdr", ...herdrWorktreeListArgs(repoPath)];
}

function herdrAgentListArgs(): string[] {
  return ["agent", "list"];
}

function herdrAgentListCommand(): string[] {
  return ["herdr", ...herdrAgentListArgs()];
}

function herdrWorktreeRemoveCommand(workspaceId: string): string[] {
  return ["herdr", "worktree", "remove", "--workspace", workspaceId, "--json"];
}

function herdrWorktreesFromResult(data: unknown): JsonObject[] {
  if (Array.isArray(data)) return data.filter((item) => item && typeof item === "object") as JsonObject[];
  if (!data || typeof data !== "object") return [];
  const result = (data as JsonObject).result;
  const worktrees = result && typeof result === "object" ? (result as JsonObject).worktrees : undefined;
  return Array.isArray(worktrees) ? worktrees.filter((item) => item && typeof item === "object") as JsonObject[] : [];
}

function herdrAgentsFromResult(data: unknown): JsonObject[] {
  if (Array.isArray(data)) return data.filter((item) => item && typeof item === "object") as JsonObject[];
  if (!data || typeof data !== "object") return [];
  const result = (data as JsonObject).result;
  const agents = result && typeof result === "object" ? (result as JsonObject).agents : undefined;
  return Array.isArray(agents) ? agents.filter((item) => item && typeof item === "object") as JsonObject[] : [];
}

function herdrWorkspaceId(value: unknown): string {
  return findStringValue(value, ["open_workspace_id", "workspace_id", "workspaceId", "id"]);
}

function herdrOpenWorkspaceId(value: unknown): string {
  return findStringValue(value, ["open_workspace_id", "workspaceId"]);
}

function herdrWorktreePath(value: unknown): string {
  return findStringValue(value, ["path", "worktreePath"]);
}

function herdrTabId(value: unknown): string {
  return findStringValue(value, ["tab_id", "tabId", "id"]);
}

module.exports = {
  herdrAgentListArgs,
  herdrAgentListCommand,
  herdrAgentStartCommand,
  herdrAgentsFromResult,
  herdrTabCreateCommand,
  herdrTabId,
  herdrWorktreeCreateCommand,
  herdrWorktreeListArgs,
  herdrWorktreeListCommand,
  herdrOpenWorkspaceId,
  herdrWorktreeOpenCommand,
  herdrWorktreePath,
  herdrWorktreeRemoveCommand,
  herdrWorktreesFromResult,
  herdrWorkspaceId,
};
