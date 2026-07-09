import { describe, expect, it } from "vitest";

const { RunnerAdapterError, createHerdrRunner, normalizeHerdrWorktreeRecord } = require("../src/herdr-runner.ts");

describe("Herdr runner", () => {
  it("creates a Worker worktree through Herdr", () => {
    const commands: unknown[] = [];
    const runner = createHerdrRunner({
      runJson: (command: string, args: string[]) => {
        commands.push([command, ...args]);
        return { workspace_id: "w1", path: "/wt" };
      },
    });

    runner.createWorktree({ repoPath: "/repo", branch: "agent/issue-1", baseBranch: "origin/main", label: "worker" });

    expect(commands[0]).toEqual([
      "herdr",
      "worktree",
      "create",
      "--cwd",
      "/repo",
      "--branch",
      "agent/issue-1",
      "--base",
      "origin/main",
      "--label",
      "worker",
      "--no-focus",
      "--json",
    ]);
  });

  it("normalizes a created worktree result", () => {
    const runner = createHerdrRunner({ runJson: () => ({ result: { worktree: { workspaceId: "w2", worktreePath: "/wt" } } }) });

    expect(runner.createWorktree({ repoPath: "/repo", branch: "agent/issue-1", baseBranch: "origin/main", label: "worker" })).toEqual({
      workspaceId: "w2",
      worktreePath: "/wt",
    });
  });

  it("rejects a worktree result without a workspace id", () => {
    const runner = createHerdrRunner({ runJson: () => ({ result: { worktree: { path: "/wt" } } }) });

    expect(() => runner.createWorktree({ repoPath: "/repo", branch: "agent/issue-1", baseBranch: "origin/main", label: "worker" })).toThrow(RunnerAdapterError);
  });

  it("creates a tab through Herdr", () => {
    const commands: unknown[] = [];
    const runner = createHerdrRunner({
      runJson: (command: string, args: string[]) => {
        commands.push([command, ...args]);
        return { tab_id: "t1" };
      },
    });

    runner.createTab({ workspaceId: "w1", cwd: "/wt", label: "worker" });

    expect(commands[0]).toEqual(["herdr", "tab", "create", "--workspace", "w1", "--cwd", "/wt", "--label", "worker", "--no-focus"]);
  });

  it("ignores Herdr command ids when parsing created tab ids", () => {
    const runner = createHerdrRunner({ runJson: () => ({ id: "cli:tab:create", result: { tab: { id: "w1:t2" } } }) });

    expect(runner.createTab({ workspaceId: "w1", cwd: "/wt", label: "worker" })).toEqual({ tabId: "w1:t2" });
  });

  it("starts an agent through Herdr", () => {
    const commands: unknown[] = [];
    const runner = createHerdrRunner({
      runText: (command: string, args: string[]) => {
        commands.push([command, ...args]);
        return "started";
      },
    });

    runner.startAgent({ name: "worker", cwd: "/wt", tabId: "t1", agentArgv: ["pi", "@prompt"] });

    expect(commands[0]).toEqual(["herdr", "agent", "start", "worker", "--cwd", "/wt", "--no-focus", "--tab", "t1", "--", "pi", "@prompt"]);
  });

  it("lists normalized worktrees", () => {
    const runner = createHerdrRunner({ runJson: () => ({ result: { worktrees: [{ branch: "b", open_workspace_id: "w", path: "/wt" }] } }) });

    expect(runner.listWorktrees("/repo")).toEqual([{ branch: "b", open_workspace_id: "w", path: "/wt", workspaceId: "w" }]);
  });

  it("parses JSON from the supplied text runner", () => {
    const runner = createHerdrRunner({ runText: () => JSON.stringify({ result: { worktrees: [{ branch: "b" }] } }) });

    expect(runner.listWorktrees("/repo")).toEqual([{ branch: "b" }]);
  });

  it("lists agents", () => {
    const runner = createHerdrRunner({ runJson: () => ({ result: { agents: [{ name: "worker" }] } }) });

    expect(runner.listAgents()).toEqual([{ name: "worker" }]);
  });

  it("removes a worktree through Herdr", () => {
    const commands: unknown[] = [];
    const runner = createHerdrRunner({
      runText: (command: string, args: string[]) => {
        commands.push([command, ...args]);
        return "removed";
      },
    });

    runner.removeWorktree("w1");

    expect(commands[0]).toEqual(["herdr", "worktree", "remove", "--workspace", "w1", "--json"]);
  });

  it("normalizes fixture worktree records", () => {
    expect(normalizeHerdrWorktreeRecord({ open_workspace_id: "w1", path: "/wt" })).toEqual({ open_workspace_id: "w1", path: "/wt", workspaceId: "w1" });
  });
});
