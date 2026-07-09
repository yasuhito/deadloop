const { execFileSync } = require("node:child_process") as typeof import("node:child_process");

import type {
  AsyncRunnerAdapter,
  RunnerAdapter,
  RunnerAgent,
  RunnerAgentStartRequest,
  RunnerTab,
  RunnerTabCreateRequest,
  RunnerWorktree,
  RunnerWorktreeCreateRequest,
  RunnerWorktreeLaunch,
  RunnerWorktreeRequest,
} from "./runner";

type JsonObject = Record<string, any>;

type SyncHerdrRunnerOps = {
  runText?: (command: string, args: string[]) => string;
  runJson?: (command: string, args: string[]) => unknown;
};

type AsyncHerdrRunnerOps = {
  runText?: (command: string, args: string[]) => Promise<string>;
  runJson: (command: string, args: string[]) => Promise<unknown>;
};

class RunnerAdapterError extends Error {
  operation: string;
  missing: string[];

  constructor(operation: string, missing: string[], payload?: unknown) {
    const detail = missing.join(", ");
    super(`Herdr runner ${operation} result missing required value(s): ${detail}`);
    this.name = "RunnerAdapterError";
    this.operation = operation;
    this.missing = missing;
    if (payload !== undefined) (this as Error & { payload?: unknown }).payload = payload;
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: unknown, keys: string[]): string {
  if (!isObject(record)) return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function objectCandidates(value: unknown, names: string[]): JsonObject[] {
  const candidates: JsonObject[] = [];
  if (isObject(value)) candidates.push(value);
  if (isObject(value) && isObject(value.result)) {
    candidates.push(value.result);
    for (const name of names) {
      if (isObject(value.result[name])) candidates.push(value.result[name]);
    }
  }
  if (isObject(value)) {
    for (const name of names) {
      if (isObject(value[name])) candidates.push(value[name]);
    }
  }
  return candidates;
}

function firstField(value: unknown, names: string[], keys: string[]): string {
  for (const candidate of objectCandidates(value, names)) {
    const found = stringField(candidate, keys);
    if (found) return found;
  }
  return "";
}

function requireFields<T extends Record<string, string>>(operation: string, payload: unknown, fields: T): T {
  const missing = Object.entries(fields)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) throw new RunnerAdapterError(operation, missing, payload);
  return fields;
}

function normalizeHerdrWorktreeRecord(record: unknown): RunnerWorktree {
  if (!isObject(record)) return {};
  const workspaceId = firstField(record, ["worktree", "workspace"], ["open_workspace_id", "workspace_id", "workspaceId"]);
  const normalized: RunnerWorktree = { ...record };
  if (workspaceId) normalized.workspaceId = workspaceId;
  return normalized;
}

function normalizeHerdrAgentRecord(record: unknown): RunnerAgent {
  return isObject(record) ? { ...record } : {};
}

function parseWorktreeLaunch(operation: string, payload: unknown): RunnerWorktreeLaunch {
  const workspaceId = firstField(payload, ["worktree", "workspace"], ["open_workspace_id", "workspace_id", "workspaceId"]);
  const worktreePath = firstField(payload, ["worktree", "workspace"], ["path", "worktreePath"]);
  return requireFields(operation, payload, { workspaceId, worktreePath });
}

function parseTab(operation: string, payload: unknown): RunnerTab {
  const tabId = firstField(payload, ["tab"], ["tab_id", "tabId", "id"]);
  return requireFields(operation, payload, { tabId });
}

function parseWorktreeList(payload: unknown): RunnerWorktree[] {
  if (Array.isArray(payload)) return payload.map(normalizeHerdrWorktreeRecord).filter((item) => Object.keys(item).length);
  const result = isObject(payload) ? payload.result : undefined;
  const worktrees = isObject(result) ? result.worktrees : undefined;
  return Array.isArray(worktrees) ? worktrees.map(normalizeHerdrWorktreeRecord).filter((item) => Object.keys(item).length) : [];
}

function parseAgentList(payload: unknown): RunnerAgent[] {
  if (Array.isArray(payload)) return payload.map(normalizeHerdrAgentRecord).filter((item) => Object.keys(item).length);
  const result = isObject(payload) ? payload.result : undefined;
  const agents = isObject(result) ? result.agents : undefined;
  return Array.isArray(agents) ? agents.map(normalizeHerdrAgentRecord).filter((item) => Object.keys(item).length) : [];
}

function defaultRunText(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8" });
}

function jsonFromText(runText: (command: string, args: string[]) => string, command: string, args: string[]): unknown {
  return JSON.parse(runText(command, args) || "null");
}

function worktreeCreateArgs(input: RunnerWorktreeCreateRequest): string[] {
  return [
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

function worktreeOpenArgs(input: RunnerWorktreeRequest): string[] {
  return ["worktree", "open", "--cwd", input.repoPath, "--branch", input.branch, "--label", input.label, "--no-focus", "--json"];
}

function tabCreateArgs(input: RunnerTabCreateRequest): string[] {
  return ["tab", "create", "--workspace", input.workspaceId, "--cwd", input.cwd, "--label", input.label, "--no-focus"];
}

function agentStartArgs(input: RunnerAgentStartRequest): string[] {
  const args = ["agent", "start", input.name, "--cwd", input.cwd, "--no-focus"];
  if (input.tabId) args.push("--tab", input.tabId);
  args.push("--", ...input.agentArgv);
  return args;
}

function worktreeListArgs(repoPath: string): string[] {
  return ["worktree", "list", "--cwd", repoPath, "--json"];
}

function agentListArgs(): string[] {
  return ["agent", "list"];
}

function worktreeRemoveArgs(workspaceId: string): string[] {
  return ["worktree", "remove", "--workspace", workspaceId, "--json"];
}

function createHerdrRunner(ops: SyncHerdrRunnerOps = {}): RunnerAdapter {
  const runText = ops.runText || defaultRunText;
  const runJson = ops.runJson || ((command: string, args: string[]) => jsonFromText(runText, command, args));
  return {
    createWorktree(input) {
      return parseWorktreeLaunch("worktree create", runJson("herdr", worktreeCreateArgs(input)));
    },
    openWorktree(input) {
      return parseWorktreeLaunch("worktree open", runJson("herdr", worktreeOpenArgs(input)));
    },
    createTab(input) {
      return parseTab("tab create", runJson("herdr", tabCreateArgs(input)));
    },
    startAgent(input) {
      return runText("herdr", agentStartArgs(input));
    },
    listWorktrees(repoPath) {
      return parseWorktreeList(runJson("herdr", worktreeListArgs(repoPath)));
    },
    listAgents() {
      return parseAgentList(runJson("herdr", agentListArgs()));
    },
    removeWorktree(workspaceId) {
      return runText("herdr", worktreeRemoveArgs(workspaceId));
    },
  };
}

function createAsyncHerdrRunner(ops: AsyncHerdrRunnerOps): AsyncRunnerAdapter {
  const runText = ops.runText || (async (command: string, args: string[]) => JSON.stringify(await ops.runJson(command, args)));
  return {
    async createWorktree(input) {
      return parseWorktreeLaunch("worktree create", await ops.runJson("herdr", worktreeCreateArgs(input)));
    },
    async openWorktree(input) {
      return parseWorktreeLaunch("worktree open", await ops.runJson("herdr", worktreeOpenArgs(input)));
    },
    async createTab(input) {
      return parseTab("tab create", await ops.runJson("herdr", tabCreateArgs(input)));
    },
    async startAgent(input) {
      return await runText("herdr", agentStartArgs(input));
    },
    async listWorktrees(repoPath) {
      return parseWorktreeList(await ops.runJson("herdr", worktreeListArgs(repoPath)));
    },
    async listAgents() {
      return parseAgentList(await ops.runJson("herdr", agentListArgs()));
    },
    async removeWorktree(workspaceId) {
      return await runText("herdr", worktreeRemoveArgs(workspaceId));
    },
  };
}

module.exports = {
  RunnerAdapterError,
  createAsyncHerdrRunner,
  createHerdrRunner,
  normalizeHerdrAgentRecord,
  normalizeHerdrWorktreeRecord,
};
