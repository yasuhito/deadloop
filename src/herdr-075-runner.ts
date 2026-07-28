type JsonObject = Record<string, unknown>;

type RunText = (command: string, args: string[]) => string;
type RunJson = (command: string, args: string[]) => unknown;

type Herdr075WorktreeLaunch = {
  workspaceId: string;
  tabId: string;
  rootPaneId: string;
  canonicalWorktreePath: string;
};

type Herdr075Runner = {
  createWorktree(input: {
    repoPath: string;
    branch: string;
    baseBranch: string;
    label: string;
  }): Herdr075WorktreeLaunch;
  openWorktree(input: { repoPath: string; branch: string }): Herdr075WorktreeLaunch;
  startAgent(input: { name: string; kind: string; rootPaneId: string; nativeAgentArgv: string[] }): string;
  closeWorkspace(input: {
    workspaceId: string;
    repoPath: string;
    canonicalWorktreePath: string;
    branch: string;
  }): string;
};

class Herdr075RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Herdr075RunnerError";
  }
}

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Herdr075RunnerError(`${field} must be an object`);
  return value as JsonObject;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Herdr075RunnerError(`${field} must be a non-empty string`);
  return value;
}

function field(record: JsonObject, name: string): string {
  return text(record[name.slice(name.lastIndexOf(".") + 1)], name);
}

function launchFromResponse(
  payload: unknown,
  expectedType: "worktree_created" | "worktree_opened",
): Herdr075WorktreeLaunch {
  const result = object(object(payload, "Herdr response").result, "Herdr response result");
  if (result.type !== expectedType) throw new Herdr075RunnerError(`expected ${expectedType} response`);
  if (expectedType === "worktree_opened" && result.already_open !== false) {
    throw new Herdr075RunnerError("worktree_opened must explicitly report already_open: false");
  }
  const workspace = object(result.workspace, "workspace");
  const tab = object(result.tab, "tab");
  const rootPane = object(result.root_pane, "root_pane");
  const worktree = object(result.worktree, "worktree");
  const workspaceId = field(workspace, "workspace.workspace_id");
  const tabId = field(tab, "tab.tab_id");
  const rootPaneId = field(rootPane, "root_pane.pane_id");
  const canonicalWorktreePath = field(worktree, "worktree.path");
  if (field(tab, "tab.workspace_id") !== workspaceId) throw new Herdr075RunnerError("tab belongs to another workspace");
  if (field(rootPane, "root_pane.workspace_id") !== workspaceId)
    throw new Herdr075RunnerError("root pane belongs to another workspace");
  if (field(rootPane, "root_pane.tab_id") !== tabId) throw new Herdr075RunnerError("root pane belongs to another tab");
  if (field(rootPane, "root_pane.cwd") !== canonicalWorktreePath)
    throw new Herdr075RunnerError("root pane cwd is not the canonical worktree path");
  return { workspaceId, tabId, rootPaneId, canonicalWorktreePath };
}

function createArgs(input: { repoPath: string; branch: string; baseBranch: string; label: string }): string[] {
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

function openArgs(input: { repoPath: string; branch: string }): string[] {
  return ["worktree", "open", "--cwd", input.repoPath, "--branch", input.branch, "--no-focus", "--json"];
}

function workspaceIds(payload: unknown): string[] {
  const result = object(object(payload, "workspace list response").result, "workspace list result");
  if (!Array.isArray(result.workspaces)) throw new Herdr075RunnerError("workspace list result has no workspaces array");
  return result.workspaces.map((item, index) =>
    field(object(item, `workspaces[${index}]`), `workspaces[${index}].workspace_id`),
  );
}

function worktreeExists(payload: unknown, expectedPath: string, expectedBranch: string): boolean {
  const result = object(object(payload, "worktree list response").result, "worktree list result");
  if (!Array.isArray(result.worktrees)) throw new Herdr075RunnerError("worktree list result has no worktrees array");
  return result.worktrees.some((item, index) => {
    const worktree = object(item, `worktrees[${index}]`);
    return (
      field(worktree, `worktrees[${index}].path`) === expectedPath &&
      field(worktree, `worktrees[${index}].branch`) === expectedBranch
    );
  });
}

function createHerdr075Runner(ops: { runText: RunText; runJson: RunJson }): Herdr075Runner {
  return {
    createWorktree(input) {
      return launchFromResponse(ops.runJson("herdr", createArgs(input)), "worktree_created");
    },
    openWorktree(input) {
      return launchFromResponse(ops.runJson("herdr", openArgs(input)), "worktree_opened");
    },
    startAgent(input) {
      return ops.runText("herdr", [
        "agent",
        "start",
        input.name,
        "--kind",
        input.kind,
        "--pane",
        input.rootPaneId,
        "--",
        ...input.nativeAgentArgv,
      ]);
    },
    closeWorkspace(input) {
      const output = ops.runText("herdr", ["workspace", "close", input.workspaceId]);
      if (workspaceIds(ops.runJson("herdr", ["workspace", "list", "--json"])).includes(input.workspaceId)) {
        throw new Herdr075RunnerError(`workspace ${input.workspaceId} remains after close`);
      }
      if (
        !worktreeExists(
          ops.runJson("herdr", ["worktree", "list", "--cwd", input.repoPath, "--json"]),
          input.canonicalWorktreePath,
          input.branch,
        )
      ) {
        throw new Herdr075RunnerError(`worktree ${input.canonicalWorktreePath} is absent after workspace close`);
      }
      return output;
    },
  };
}

module.exports = { Herdr075RunnerError, createHerdr075Runner };
