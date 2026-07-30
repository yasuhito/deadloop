import fs from "node:fs";

import { describe, expect, it } from "vitest";

const { RunnerAdapterError, createAsyncHerdrRunner, createHerdrRunner, normalizeHerdrWorktreeRecord } = require("../src/herdr-runner.ts");

const workspaceList075 = JSON.parse(fs.readFileSync("test/fixtures/herdr-0.7.5-workspace-list.json", "utf8"));
const agentList075 = JSON.parse(fs.readFileSync("test/fixtures/herdr-0.7.5-agent-list.json", "utf8"));

const opened = {
  result: {
    type: "worktree_opened", already_open: false,
    workspace: { workspace_id: "w1" },
    tab: { tab_id: "t1", workspace_id: "w1" },
    root_pane: { pane_id: "p1", tab_id: "t1", workspace_id: "w1", cwd: "/wt" },
    worktree: { path: "/wt" },
  },
};
const created = { result: { ...opened.result, type: "worktree_created", already_open: undefined } };
function create(payload: unknown) {
  return createHerdrRunner({ runJson: () => payload, runText: () => "" })
    .createWorktree({ repoPath: "/repo", branch: "agent/issue-1", baseBranch: "origin/main", label: "worker", intendedPath: "/wt" });
}
function open(payload: unknown) {
  return createHerdrRunner({ runJson: () => payload, runText: () => "" })
    .openWorktree({ repoPath: "/repo", branch: "feature/review" });
}

describe("selected Herdr runner", () => {
  it("creates a fresh worktree with the exact selected argv", () => {
    const commands: unknown[] = [];
    const runner = createHerdrRunner({ runJson: (command: string, args: string[]) => (commands.push([command, ...args]), created), runText: () => "" });
    runner.createWorktree({ repoPath: "/repo", branch: "agent/issue-1", baseBranch: "origin/main", label: "worker", intendedPath: "/custom/worker" });
    expect(commands[0]).toEqual(["herdr", "worktree", "create", "--cwd", "/repo", "--branch", "agent/issue-1", "--base", "origin/main", "--path", "/custom/worker", "--label", "worker", "--no-focus", "--json"]);
  });

  it("returns every owned identity from a create response", () => {
    expect(create(created)).toEqual({ workspaceId: "w1", tabId: "t1", rootPaneId: "p1", worktreePath: "/wt" });
  });

  it("opens an existing worktree without a label", () => {
    const commands: unknown[] = [];
    const runner = createHerdrRunner({ runJson: (command: string, args: string[]) => (commands.push([command, ...args]), opened), runText: () => "" });
    runner.openWorktree({ repoPath: "/repo", branch: "feature/review" });
    expect(commands[0]).toEqual(["herdr", "worktree", "open", "--cwd", "/repo", "--branch", "feature/review", "--no-focus", "--json"]);
  });

  it("rejects a reused open workspace", () => {
    expect(() => open({ result: { ...opened.result, already_open: true } })).toThrow(/already_open=false/);
  });

  it("rejects an open response with missing reuse metadata", () => {
    const { already_open: _ignored, ...result } = opened.result;
    expect(() => open({ result })).toThrow(/already_open=false/);
  });

  it("rejects a malformed top-level response", () => {
    expect(() => create([])).toThrow(RunnerAdapterError);
  });

  it("rejects a missing operation result", () => {
    expect(() => create({})).toThrow(RunnerAdapterError);
  });

  it("rejects a response for another operation", () => {
    expect(() => create(opened)).toThrow(/type=worktree_created/);
  });

  it("rejects a missing workspace identity", () => {
    expect(() => create({ result: { ...created.result, workspace: {} } })).toThrow(/workspace_id/);
  });

  it("rejects a missing tab identity", () => {
    expect(() => create({ result: { ...created.result, tab: { workspace_id: "w1" } } })).toThrow(/tab_id/);
  });

  it("rejects a missing root pane identity", () => {
    expect(() => create({ result: { ...created.result, root_pane: { ...created.result.root_pane, pane_id: "" } } })).toThrow(/pane_id/);
  });

  it("rejects a missing canonical worktree path", () => {
    expect(() => create({ result: { ...created.result, worktree: {} } })).toThrow(/worktree.path/);
  });

  it("rejects a tab owned by another workspace", () => {
    expect(() => create({ result: { ...created.result, tab: { ...created.result.tab, workspace_id: "w2" } } })).toThrow(/tab.workspace_id/);
  });

  it("rejects a root pane owned by another tab", () => {
    expect(() => create({ result: { ...created.result, root_pane: { ...created.result.root_pane, tab_id: "t2" } } })).toThrow(/root_pane ownership/);
  });

  it("rejects a root pane outside the returned worktree", () => {
    expect(() => create({ result: { ...created.result, root_pane: { ...created.result.root_pane, cwd: "/other" } } })).toThrow(/root_pane.cwd/);
  });

  it("starts the native agent directly in the owned root pane", () => {
    const commands: unknown[] = [];
    const runner = createHerdrRunner({ runJson: () => opened, runText: (command: string, args: string[]) => (commands.push([command, ...args]), "started") });
    runner.startAgent({ name: "dl-r-44-123456789abc", kind: "pi", rootPaneId: "p1", nativeAgentArgv: ["--approve", "@/prompt"] });
    expect(commands[0]).toEqual(["herdr", "agent", "start", "dl-r-44-123456789abc", "--kind", "pi", "--pane", "p1", "--", "--approve", "@/prompt"]);
  });

  it("normalizes nested 0.7.5 workspace ownership and layout counts", () => {
    const runner = createHerdrRunner({ runJson: () => workspaceList075, runText: () => "" });
    expect(runner.listWorkspaces()).toEqual([{ ...workspaceList075.result.workspaces[0], workspaceId: "w-issue-12", worktreePath: "/worktrees/issue-12", paneCount: 1, tabCount: 1 }]);
  });

  it("uses the argument-free 0.7.5 workspace list command", () => {
    const commands: unknown[] = [];
    const runner = createHerdrRunner({
      runJson: (command: string, args: string[]) => (commands.push([command, ...args]), workspaceList075),
      runText: () => "",
    });
    runner.listWorkspaces();
    expect(commands).toEqual([["herdr", "workspace", "list"]]);
  });

  it("rejects a malformed selected workspace list envelope", () => {
    const runner = createHerdrRunner({ runJson: () => ({ result: { workspaces: {} } }), runText: () => "" });
    expect(() => runner.listWorkspaces()).toThrow(RunnerAdapterError);
  });

  it.each([
    { worktree: "/worktrees/issue-12" },
    { worktree: {} },
    { worktree: { checkout_path: "" } },
  ])("rejects malformed nested WorkspaceInfo worktree shape %#", (replacement) => {
    const workspace = { ...workspaceList075.result.workspaces[0], ...replacement };
    const runner = createHerdrRunner({ runJson: () => ({ result: { type: "workspace_list", workspaces: [workspace] } }), runText: () => "" });
    expect(() => runner.listWorkspaces()).toThrow(RunnerAdapterError);
  });

  it("rejects malformed nested WorkspaceInfo in the asynchronous doctor/status boundary", async () => {
    const workspace = { ...workspaceList075.result.workspaces[0], worktree: {} };
    const runner = createAsyncHerdrRunner({ runJson: async () => ({ result: { type: "workspace_list", workspaces: [workspace] } }) });
    await expect(runner.listWorkspaces()).rejects.toThrow(RunnerAdapterError);
  });

  it.each([
    { pane_count: undefined },
    { pane_count: -1 },
    { tab_count: "1" },
  ])("rejects malformed WorkspaceInfo layout counts %#", (replacement) => {
    const workspace = { ...workspaceList075.result.workspaces[0], ...replacement };
    const runner = createHerdrRunner({ runJson: () => ({ result: { type: "workspace_list", workspaces: [workspace] } }), runText: () => "" });
    expect(() => runner.listWorkspaces()).toThrow(RunnerAdapterError);
  });

  it("normalizes the 0.7.5 agent terminal, pane ownership, status, and cwd", () => {
    const runner = createHerdrRunner({ runJson: () => agentList075, runText: () => "" });
    expect(runner.listAgents()).toEqual([{ ...agentList075.result.agents[0], agentId: "terminal-1", paneId: "w-issue-12:p1", status: "done", cwd: "/worktrees/issue-12" }]);
  });

  it("uses the argument-free 0.7.5 agent list command", () => {
    const commands: unknown[] = [];
    const runner = createHerdrRunner({
      runJson: (command: string, args: string[]) => (commands.push([command, ...args]), agentList075),
      runText: () => "",
    });
    runner.listAgents();
    expect(commands).toEqual([["herdr", "agent", "list"]]);
  });

  it("closes only the selected workspace", () => {
    const commands: unknown[] = [];
    const runner = createHerdrRunner({ runJson: () => opened, runText: (command: string, args: string[]) => (commands.push([command, ...args]), "") });
    runner.closeWorkspace("w1");
    expect(commands[0]).toEqual(["herdr", "workspace", "close", "w1"]);
  });

  it("removes a closed linked worktree by exact repository, path, and branch without a workspace id", () => {
    const commands: unknown[] = [];
    let removed = false;
    const runner = createHerdrRunner({
      runJson: () => ({ result: { worktrees: removed ? [] : [{ path: "/wt", branch: "agent/issue-1", is_linked_worktree: true }] } }),
      runText: (command: string, args: string[]) => { commands.push([command, ...args]); removed = true; return "removed"; },
    });
    runner.removeWorktree({ repoPath: "/repo", branch: "agent/issue-1", worktreePath: "/wt" });
    expect(commands).toEqual([["git", "-C", "/repo", "worktree", "remove", "/wt"]]);
  });

  it("refuses to remove a linked worktree that still has an open workspace", () => {
    const runner = createHerdrRunner({
      runJson: () => ({ result: { worktrees: [{ path: "/wt", branch: "agent/issue-1", open_workspace_id: "w1" }] } }),
      runText: () => "",
    });
    expect(() => runner.removeWorktree({ repoPath: "/repo", branch: "agent/issue-1", worktreePath: "/wt" })).toThrow(/closed/);
  });

  it("keeps worktree record normalization available to fixture adapters", () => {
    expect(normalizeHerdrWorktreeRecord({ open_workspace_id: "w1", path: "/wt" })).toEqual({ open_workspace_id: "w1", path: "/wt", workspaceId: "w1" });
  });
});
