import { describe, expect, it } from "vitest";

const {
  herdrAgentListArgs,
  herdrAgentListCommand,
  herdrAgentStartCommand,
  herdrAgentsFromResult,
  herdrTabCreateCommand,
  herdrOpenWorkspaceId,
  herdrTabId,
  herdrWorktreeCreateCommand,
  herdrWorktreeListArgs,
  herdrWorktreeListCommand,
  herdrWorktreeOpenCommand,
  herdrWorktreePath,
  herdrWorktreesFromResult,
  herdrWorkspaceId,
} = require("../src/herdr-adapter.ts");

describe("Herdr adapter", () => {
  it("builds a Worker worktree create command", () => {
    expect(herdrWorktreeCreateCommand({ repoPath: "/repo", branch: "agent/issue-1", baseBranch: "origin/main", label: "worker" })).toEqual([
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

  it("builds a reviewer worktree open command", () => {
    expect(herdrWorktreeOpenCommand({ repoPath: "/repo", branch: "feature", label: "reviewer" })).toEqual([
      "herdr",
      "worktree",
      "open",
      "--cwd",
      "/repo",
      "--branch",
      "feature",
      "--label",
      "reviewer",
      "--no-focus",
      "--json",
    ]);
  });

  it("builds a tab create command", () => {
    expect(herdrTabCreateCommand({ workspaceId: "w1", cwd: "/wt", label: "worker" })).toEqual([
      "herdr",
      "tab",
      "create",
      "--workspace",
      "w1",
      "--cwd",
      "/wt",
      "--label",
      "worker",
      "--no-focus",
    ]);
  });

  it("builds an agent start command with a dedicated tab", () => {
    expect(herdrAgentStartCommand({ name: "worker", cwd: "/wt", tabId: "t1", agentArgv: ["pi", "@prompt"] })).toEqual([
      "herdr",
      "agent",
      "start",
      "worker",
      "--cwd",
      "/wt",
      "--no-focus",
      "--tab",
      "t1",
      "--",
      "pi",
      "@prompt",
    ]);
  });

  it("extracts worktrees from Herdr result envelopes", () => {
    expect(herdrWorktreesFromResult({ result: { worktrees: [{ path: "/wt" }] } })).toEqual([{ path: "/wt" }]);
  });

  it("extracts agents from Herdr result envelopes", () => {
    expect(herdrAgentsFromResult({ result: { agents: [{ name: "worker" }] } })).toEqual([{ name: "worker" }]);
  });

  it("reads workspace ids across Herdr result shapes", () => {
    expect(herdrWorkspaceId({ nested: { workspaceId: "w2" } })).toBe("w2");
  });

  it("reads open workspace ids without falling back to generic ids", () => {
    expect(herdrOpenWorkspaceId({ id: "record-id", nested: { workspaceId: "w3" } })).toBe("w3");
  });

  it("reads worktree paths across Herdr result shapes", () => {
    expect(herdrWorktreePath({ result: { path: "/wt" } })).toBe("/wt");
  });

  it("reads tab ids across Herdr result shapes", () => {
    expect(herdrTabId({ tab_id: "t2" })).toBe("t2");
  });

  it("builds status worktree list args", () => {
    expect(herdrWorktreeListArgs("/repo")).toEqual(["worktree", "list", "--cwd", "/repo", "--json"]);
  });

  it("builds status worktree list commands", () => {
    expect(herdrWorktreeListCommand("/repo")).toEqual(["herdr", "worktree", "list", "--cwd", "/repo", "--json"]);
  });

  it("builds status agent list args", () => {
    expect(herdrAgentListArgs()).toEqual(["agent", "list"]);
  });

  it("builds status agent list commands", () => {
    expect(herdrAgentListCommand()).toEqual(["herdr", "agent", "list"]);
  });
});
