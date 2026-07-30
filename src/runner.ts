export type RunnerWorktreeRequest = {
  repoPath: string;
  branch: string;
};

export type RunnerWorktreeCreateRequest = RunnerWorktreeRequest & {
  baseBranch: string;
  label: string;
  intendedPath: string;
};

export type RunnerWorktreeRemoveRequest = RunnerWorktreeRequest & {
  worktreePath: string;
};

export type RunnerAgentStartRequest = {
  name: string;
  kind: string;
  rootPaneId: string;
  nativeAgentArgv: string[];
};

export type RunnerWorktree = Record<string, any> & {
  workspaceId?: string;
  path?: string;
  branch?: string;
};

export type RunnerAgent = Record<string, any> & {
  agentId?: string;
  name?: string;
  status?: string;
  cwd?: string;
  paneId?: string;
};

export type RunnerWorkspace = Record<string, any> & {
  workspaceId?: string;
  worktreePath?: string;
  paneCount?: number;
  tabCount?: number;
};

export type RunnerWorktreeLaunch = {
  workspaceId: string;
  tabId: string;
  rootPaneId: string;
  worktreePath: string;
};

export type RunnerAdapter = {
  createWorktree(input: RunnerWorktreeCreateRequest): RunnerWorktreeLaunch;
  openWorktree(input: RunnerWorktreeRequest): RunnerWorktreeLaunch;
  renameWorkspace(workspaceId: string, label: string): string;
  startAgent(input: RunnerAgentStartRequest): string;
  closeWorkspace(workspaceId: string): string;
  listWorkspaces(): RunnerWorkspace[];
  listWorktrees(repoPath: string): RunnerWorktree[];
  listAgents(): RunnerAgent[];
  removeWorktree(input: RunnerWorktreeRemoveRequest): string;
};

export type AsyncRunnerAdapter = {
  listWorkspaces(): Promise<RunnerWorkspace[]>;
  listWorktrees(repoPath: string): Promise<RunnerWorktree[]>;
  listAgents(): Promise<RunnerAgent[]>;
  removeWorktree(input: RunnerWorktreeRemoveRequest): Promise<string>;
};
