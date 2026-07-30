const { execFileSync } = require("node:child_process") as typeof import("node:child_process");

import type {
  AsyncRunnerAdapter,
  RunnerAdapter,
  RunnerAgent,
  RunnerAgentStartRequest,
  RunnerWorkspace,
  RunnerWorktree,
  RunnerWorktreeCreateRequest,
  RunnerWorktreeLaunch,
  RunnerWorktreeRequest,
  RunnerWorktreeRemoveRequest,
} from "./runner";

type JsonObject = Record<string, any>;
type SyncOps = {
  runText?: (command: string, args: string[]) => string;
  runJson?: (command: string, args: string[]) => unknown;
};
type AsyncOps = {
  runText?: (command: string, args: string[]) => Promise<string>;
  runJson: (command: string, args: string[]) => Promise<unknown>;
};

class RunnerAdapterError extends Error {
  operation: string;
  missing: string[];

  constructor(operation: string, missing: string[], payload?: unknown) {
    super(`Herdr runner ${operation} result missing required value(s): ${missing.join(", ")}`);
    this.name = "RunnerAdapterError";
    this.operation = operation;
    this.missing = missing;
    if (payload !== undefined) (this as Error & { payload?: unknown }).payload = payload;
  }
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RunnerAdapterError(name, ["object"], value);
  }
  return value as JsonObject;
}

function nonEmpty(value: unknown, name: string, payload?: unknown): string {
  if (typeof value !== "string" || !value) throw new RunnerAdapterError(name, [name], payload);
  return value;
}

function result(payload: unknown, operation: string): JsonObject {
  return object(object(payload, operation).result, `${operation} result`);
}

function launchFromResponse(
  payload: unknown,
  expectedType: "worktree_created" | "worktree_opened",
): RunnerWorktreeLaunch {
  const launch = result(payload, expectedType);
  if (launch.type !== expectedType) throw new RunnerAdapterError(expectedType, [`type=${expectedType}`], payload);
  if (expectedType === "worktree_opened" && launch.already_open !== false) {
    throw new RunnerAdapterError(expectedType, ["already_open=false"], payload);
  }
  const workspace = object(launch.workspace, "workspace");
  const tab = object(launch.tab, "tab");
  const pane = object(launch.root_pane, "root_pane");
  const worktree = object(launch.worktree, "worktree");
  const workspaceId = nonEmpty(workspace.workspace_id, "workspace_id", payload);
  const tabId = nonEmpty(tab.tab_id, "tab_id", payload);
  const rootPaneId = nonEmpty(pane.pane_id, "pane_id", payload);
  const worktreePath = nonEmpty(worktree.path, "worktree.path", payload);
  if (tab.workspace_id !== workspaceId) throw new RunnerAdapterError(expectedType, ["tab.workspace_id"], payload);
  if (pane.workspace_id !== workspaceId || pane.tab_id !== tabId) {
    throw new RunnerAdapterError(expectedType, ["root_pane ownership"], payload);
  }
  if (pane.cwd !== worktreePath) throw new RunnerAdapterError(expectedType, ["root_pane.cwd"], payload);
  return { workspaceId, tabId, rootPaneId, worktreePath };
}

function createArgs(input: RunnerWorktreeCreateRequest): string[] {
  return [
    "worktree", "create", "--cwd", input.repoPath, "--branch", input.branch,
    "--base", input.baseBranch, "--path", input.intendedPath,
    "--label", input.label, "--no-focus", "--json",
  ];
}

function openArgs(input: RunnerWorktreeRequest): string[] {
  return ["worktree", "open", "--cwd", input.repoPath, "--branch", input.branch, "--no-focus", "--json"];
}

function agentStartArgs(input: RunnerAgentStartRequest): string[] {
  return [
    "agent", "start", input.name, "--kind", input.kind, "--pane", input.rootPaneId,
    "--", ...input.nativeAgentArgv,
  ];
}

function arrayFromResult(payload: unknown, field: string): unknown[] {
  const values = result(payload, `${field} list`)[field];
  if (!Array.isArray(values)) throw new RunnerAdapterError(`${field} list`, [field], payload);
  return values;
}

function normalizeWorktree(value: unknown): RunnerWorktree {
  const item = object(value, "worktree");
  const workspaceId = typeof item.open_workspace_id === "string"
    ? item.open_workspace_id
    : typeof item.workspace_id === "string" ? item.workspace_id : undefined;
  return { ...item, ...(workspaceId ? { workspaceId } : {}) };
}

function nonNegativeInteger(value: unknown, name: string, payload: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new RunnerAdapterError(name, [name], payload);
  return value as number;
}

function normalizeWorkspace(value: unknown): RunnerWorkspace {
  const item = object(value, "workspace");
  const workspaceId = nonEmpty(item.workspace_id, "workspace_id", value);
  const paneCount = nonNegativeInteger(item.pane_count, "pane_count", value);
  const tabCount = nonNegativeInteger(item.tab_count, "tab_count", value);
  let worktreePath: string | undefined;
  if (item.worktree !== undefined && item.worktree !== null) {
    const worktree = object(item.worktree, "workspace.worktree");
    worktreePath = nonEmpty(worktree.checkout_path, "worktree.checkout_path", value);
  }
  return {
    ...item,
    workspaceId,
    paneCount,
    tabCount,
    ...(worktreePath ? { worktreePath } : {}),
  };
}

function normalizeAgent(value: unknown): RunnerAgent {
  const item = object(value, "agent");
  const agentId = nonEmpty(item.terminal_id, "terminal_id", value);
  const paneId = nonEmpty(item.pane_id, "pane_id", value);
  const status = nonEmpty(item.agent_status, "agent_status", value).toLowerCase();
  const cwd = typeof item.cwd === "string" ? item.cwd : typeof item.foreground_cwd === "string" ? item.foreground_cwd : undefined;
  return { ...item, agentId, paneId, status, ...(cwd ? { cwd } : {}) };
}

function defaultRunText(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8" });
}

function removeLinkedWorktree(
  input: RunnerWorktreeRemoveRequest,
  listWorktrees: (repoPath: string) => RunnerWorktree[],
  runText: (command: string, args: string[]) => string,
): string {
  const expectedPath = require("node:path").resolve(input.worktreePath);
  const matches = listWorktrees(input.repoPath).filter((worktree) =>
    String(worktree.branch || "") === input.branch
    && typeof worktree.path === "string"
    && require("node:path").resolve(worktree.path) === expectedPath
  );
  if (matches.length !== 1) throw new Error("linked worktree removal requires one exact path and branch identity");
  if (matches[0].workspaceId) throw new Error("linked worktree removal requires its attempt workspace to be closed");
  const output = runText("git", ["-C", input.repoPath, "worktree", "remove", input.worktreePath]);
  const remains = listWorktrees(input.repoPath).some((worktree) =>
    String(worktree.branch || "") === input.branch
    || (typeof worktree.path === "string" && require("node:path").resolve(worktree.path) === expectedPath)
  );
  if (remains) throw new Error("linked worktree remains after exact removal");
  return output;
}

function createHerdrRunner(ops: SyncOps = {}): RunnerAdapter {
  const runText = ops.runText || defaultRunText;
  const runJson = ops.runJson || ((command: string, args: string[]) => JSON.parse(runText(command, args) || "null"));
  return {
    createWorktree(input) { return launchFromResponse(runJson("herdr", createArgs(input)), "worktree_created"); },
    openWorktree(input) { return launchFromResponse(runJson("herdr", openArgs(input)), "worktree_opened"); },
    renameWorkspace(workspaceId, label) { return runText("herdr", ["workspace", "rename", workspaceId, label]); },
    startAgent(input) { return runText("herdr", agentStartArgs(input)); },
    closeWorkspace(workspaceId) { return runText("herdr", ["workspace", "close", workspaceId]); },
    listWorkspaces() { return arrayFromResult(runJson("herdr", ["workspace", "list"]), "workspaces").map(normalizeWorkspace); },
    listWorktrees(repoPath) { return arrayFromResult(runJson("herdr", ["worktree", "list", "--cwd", repoPath, "--json"]), "worktrees").map(normalizeWorktree); },
    listAgents() { return arrayFromResult(runJson("herdr", ["agent", "list"]), "agents").map(normalizeAgent); },
    removeWorktree(input) { return removeLinkedWorktree(input, (repoPath) => arrayFromResult(runJson("herdr", ["worktree", "list", "--cwd", repoPath, "--json"]), "worktrees").map(normalizeWorktree), runText); },
  };
}

function createAsyncHerdrRunner(ops: AsyncOps): AsyncRunnerAdapter {
  const runText = ops.runText || (async (command: string, args: string[]) => JSON.stringify(await ops.runJson(command, args)));
  return {
    async listWorkspaces() { return arrayFromResult(await ops.runJson("herdr", ["workspace", "list"]), "workspaces").map(normalizeWorkspace); },
    async listWorktrees(repoPath) { return arrayFromResult(await ops.runJson("herdr", ["worktree", "list", "--cwd", repoPath, "--json"]), "worktrees").map(normalizeWorktree); },
    async listAgents() { return arrayFromResult(await ops.runJson("herdr", ["agent", "list"]), "agents").map(normalizeAgent); },
    async removeWorktree(input) {
      const list = async () => arrayFromResult(await ops.runJson("herdr", ["worktree", "list", "--cwd", input.repoPath, "--json"]), "worktrees").map(normalizeWorktree);
      const expectedPath = require("node:path").resolve(input.worktreePath);
      const matches = (await list()).filter((worktree) => String(worktree.branch || "") === input.branch
        && typeof worktree.path === "string" && require("node:path").resolve(worktree.path) === expectedPath);
      if (matches.length !== 1 || matches[0].workspaceId) throw new Error("linked worktree removal requires one exact closed path and branch identity");
      const output = await runText("git", ["-C", input.repoPath, "worktree", "remove", input.worktreePath]);
      if ((await list()).some((worktree) => String(worktree.branch || "") === input.branch
        || (typeof worktree.path === "string" && require("node:path").resolve(worktree.path) === expectedPath))) throw new Error("linked worktree remains after exact removal");
      return output;
    },
  };
}

module.exports = {
  RunnerAdapterError,
  createAsyncHerdrRunner,
  createHerdrRunner,
  normalizeHerdrAgentRecord: normalizeAgent,
  normalizeHerdrWorktreeRecord: normalizeWorktree,
};
