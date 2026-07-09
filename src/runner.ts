export type RunnerWorktreeRequest = {
  repoPath: string;
  branch: string;
  label: string;
};

export type RunnerWorktreeCreateRequest = RunnerWorktreeRequest & {
  baseBranch: string;
};

export type RunnerTabCreateRequest = {
  workspaceId: string;
  cwd: string;
  label: string;
};

export type RunnerAgentStartRequest = {
  name: string;
  cwd: string;
  tabId?: string;
  agentArgv: string[];
};

export type RunnerWorktree = Record<string, any> & {
  workspaceId?: string;
  path?: string;
  branch?: string;
};

export type RunnerAgent = Record<string, any> & {
  name?: string;
};

export type RunnerWorktreeLaunch = {
  workspaceId: string;
  worktreePath: string;
};

export type RunnerTab = {
  tabId: string;
};

export type RunnerAdapter = {
  createWorktree(input: RunnerWorktreeCreateRequest): RunnerWorktreeLaunch;
  openWorktree(input: RunnerWorktreeRequest): RunnerWorktreeLaunch;
  createTab(input: RunnerTabCreateRequest): RunnerTab;
  startAgent(input: RunnerAgentStartRequest): string;
  listWorktrees(repoPath: string): RunnerWorktree[];
  listAgents(): RunnerAgent[];
  removeWorktree(workspaceId: string): string;
};

export type AsyncRunnerAdapter = {
  createWorktree(input: RunnerWorktreeCreateRequest): Promise<RunnerWorktreeLaunch>;
  openWorktree(input: RunnerWorktreeRequest): Promise<RunnerWorktreeLaunch>;
  createTab(input: RunnerTabCreateRequest): Promise<RunnerTab>;
  startAgent(input: RunnerAgentStartRequest): Promise<string>;
  listWorktrees(repoPath: string): Promise<RunnerWorktree[]>;
  listAgents(): Promise<RunnerAgent[]>;
  removeWorktree(workspaceId: string): Promise<string>;
};
