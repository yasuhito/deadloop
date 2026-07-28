import { describe, expect, it } from "vitest";

import { buildNativeAgentArgv } from "../src/agent-profiles.cjs";
import { Herdr075CompatibilityError, parseHerdr075Compatibility } from "../src/herdr-075-compat";
import { deriveHerdr075AgentName } from "../src/herdr-agent-name";

const { Herdr075RunnerError, createHerdr075Runner } = require("../src/herdr-075-runner.ts");

const created = {
  result: {
    type: "worktree_created",
    workspace: { workspace_id: "w1" },
    tab: { tab_id: "w1:t1", workspace_id: "w1" },
    root_pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1", cwd: "/worktrees/issue-1" },
    worktree: { path: "/worktrees/issue-1" },
  },
};

const opened = {
  result: {
    type: "worktree_opened",
    already_open: false,
    workspace: { workspace_id: "w2" },
    tab: { tab_id: "w2:t1", workspace_id: "w2" },
    root_pane: { pane_id: "w2:p1", tab_id: "w2:t1", workspace_id: "w2", cwd: "/worktrees/issue-1" },
    worktree: { path: "/worktrees/issue-1" },
  },
};

describe("dormant Herdr 0.7.5 runner", () => {
  it("accepts stable compatible client and server probes", () => {
    expect(
      parseHerdr075Compatibility("herdr 0.7.5+build.9", "status: running\nversion: 0.8.0\ncompatible: yes"),
    ).toEqual({
      clientVersion: "0.7.5+build.9",
      serverVersion: "0.8.0",
    });
  });

  it.each([
    ["herdr 0.7.5-rc.1", "status: running\nversion: 0.7.5\ncompatible: yes"],
    ["herdr 0.7", "status: running\nversion: 0.7.5\ncompatible: yes"],
    ["herdr 0.7.5 extra", "status: running\nversion: 0.7.5\ncompatible: yes"],
    ["herdr 0.7.5", "status: running\nversion: 0.7.5\ncompatible: no"],
    ["herdr 0.7.5", "status: protocol_mismatch\nversion: 0.7.5\ncompatible: yes"],
    ["herdr 0.7.4", "status: running\nversion: 0.7.5\ncompatible: yes"],
  ])("rejects an incompatible probe", (client, server) => {
    expect(() => parseHerdr075Compatibility(client, server)).toThrow(Herdr075CompatibilityError);
  });

  it("derives the bounded Herdr agent name", () => {
    expect(
      deriveHerdr075AgentName({
        repository: "octo/deadloop",
        role: "review-repair",
        target: 2147483647,
        launchUuid: "launch-1",
      }),
    ).toMatch(/^dl-x-2147483647-[a-f0-9]{12}$/);
  });

  it.each([0, 1.2, 2147483648])("rejects an invalid Herdr target number", (target) => {
    expect(() =>
      deriveHerdr075AgentName({ repository: "octo/deadloop", role: "worker", target, launchUuid: "launch-1" }),
    ).toThrow();
  });

  it("rejects a live duplicate Herdr agent name", () => {
    const name = deriveHerdr075AgentName({
      repository: "octo/deadloop",
      role: "worker",
      target: 1,
      launchUuid: "launch-1",
    });

    expect(() =>
      deriveHerdr075AgentName({
        repository: "octo/deadloop",
        role: "worker",
        target: 1,
        launchUuid: "launch-1",
        liveNames: [name],
      }),
    ).toThrow(/live/);
  });

  it("builds native argv without the selected executable", () => {
    expect(
      buildNativeAgentArgv({
        agent: "pi",
        name: "dl-w-1-123456789abc",
        level: "medium",
        promptFile: "/p",
        promptText: "",
      }),
    ).toEqual(["--name", "dl-w-1-123456789abc", "--thinking", "medium", "--approve", "@/p"]);
  });

  it("accepts only a worktree_created response for creation", () => {
    const runner = createHerdr075Runner({ runJson: () => opened, runText: () => "" });

    expect(() =>
      runner.createWorktree({ repoPath: "/repo", branch: "agent/issue-1", baseBranch: "main", label: "Issue 1" }),
    ).toThrow(Herdr075RunnerError);
  });

  it("requires already_open false for an existing worktree", () => {
    const runner = createHerdr075Runner({
      runJson: () => ({ ...opened, result: { ...opened.result, already_open: true } }),
      runText: () => "",
    });

    expect(() => runner.openWorktree({ repoPath: "/repo", branch: "agent/issue-1" })).toThrow(Herdr075RunnerError);
  });

  it("returns cross-checked Herdr workspace ownership", () => {
    const runner = createHerdr075Runner({ runJson: () => created, runText: () => "" });

    expect(
      runner.createWorktree({ repoPath: "/repo", branch: "agent/issue-1", baseBranch: "main", label: "Issue 1" }),
    ).toEqual({
      workspaceId: "w1",
      tabId: "w1:t1",
      rootPaneId: "w1:p1",
      canonicalWorktreePath: "/worktrees/issue-1",
    });
  });

  it("rejects a root pane from another tab", () => {
    const runner = createHerdr075Runner({
      runJson: () => ({
        ...created,
        result: { ...created.result, root_pane: { ...created.result.root_pane, tab_id: "w1:t2" } },
      }),
      runText: () => "",
    });

    expect(() =>
      runner.createWorktree({ repoPath: "/repo", branch: "agent/issue-1", baseBranch: "main", label: "Issue 1" }),
    ).toThrow(Herdr075RunnerError);
  });

  it("opens an existing worktree without a label", () => {
    const commands: unknown[] = [];
    const runner = createHerdr075Runner({
      runJson: (command: string, args: string[]) => {
        commands.push([command, ...args]);
        return opened;
      },
      runText: () => "",
    });

    runner.openWorktree({ repoPath: "/repo", branch: "agent/issue-1" });

    expect(commands).toEqual([
      ["herdr", "worktree", "open", "--cwd", "/repo", "--branch", "agent/issue-1", "--no-focus", "--json"],
    ]);
  });

  it("builds the exact 0.7.5 agent start argv", () => {
    const commands: unknown[] = [];
    const runner = createHerdr075Runner({
      runJson: () => created,
      runText: (command: string, args: string[]) => {
        commands.push([command, ...args]);
        return "started";
      },
    });

    runner.startAgent({
      name: "dl-w-1-123456789abc",
      kind: "pi",
      rootPaneId: "w1:p1",
      nativeAgentArgv: ["--approve", "@/p"],
    });

    expect(commands).toEqual([
      ["herdr", "agent", "start", "dl-w-1-123456789abc", "--kind", "pi", "--pane", "w1:p1", "--", "--approve", "@/p"],
    ]);
  });

  it("closes only the workspace and verifies its absence while retaining the worktree", () => {
    const commands: unknown[] = [];
    const runner = createHerdr075Runner({
      runText: (command: string, args: string[]) => {
        commands.push([command, ...args]);
        return "closed";
      },
      runJson: (command: string, args: string[]) => {
        commands.push([command, ...args]);
        if (args[0] === "workspace") return { result: { workspaces: [] } };
        return { result: { worktrees: [{ path: "/worktrees/issue-1", branch: "agent/issue-1" }] } };
      },
    });

    expect(
      runner.closeWorkspace({
        workspaceId: "w1",
        repoPath: "/repo",
        canonicalWorktreePath: "/worktrees/issue-1",
        branch: "agent/issue-1",
      }),
    ).toBe("closed");
  });
});
