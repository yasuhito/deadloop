import { describe, expect, it } from "vitest";

const {
  assertOwnedExplorationWorkspace,
  removeExplorationWorktree,
  renderExplorationResult,
} = require("../extensions/deadloop/automations/complete-issue-exploration.ts");

const record = {
  workspaceId: "workspace-1",
  worktreePath: "/worktrees/explore-42",
  branch: "agent/explore-42",
};

const report = {
  summary: "The change is straightforward.",
  result: {
    difficulty: "low",
    relevantFiles: ["src/example.ts"],
    verifiedClaims: ["The seam already exists."],
    disprovedClaims: [],
    openQuestions: ["Which name should be public?"],
    approach: "Extend the existing seam.",
  },
};

describe("Issue exploration completion", () => {
  it("renders the authorized human-readable result", () => {
    expect(renderExplorationResult(report)).toContain("### Verified claims\n- The seam already exists.");
  });

  it("rejects a workspace identity bound to another checkout", () => {
    expect(() => assertOwnedExplorationWorkspace(record, {
      listWorkspaces: () => [{ workspaceId: "workspace-1", worktreePath: "/other" }],
    })).toThrow("not exact");
  });

  it("accepts cleanup retry after the exact exploration worktree is already absent", () => {
    let removals = 0;
    removeExplorationWorktree(record, "/repo", {
      listWorktrees: () => [],
      removeWorktree: () => { removals += 1; },
    });
    expect(removals).toBe(0);
  });

  it("rejects ambiguous exploration worktree identity", () => {
    expect(() => removeExplorationWorktree(record, "/repo", {
      listWorktrees: () => [
        { path: record.worktreePath, branch: record.branch },
        { path: "/other", branch: record.branch },
      ],
      removeWorktree: () => undefined,
    })).toThrow("ambiguous");
  });

  it("confirms exploration worktree removal", () => {
    let present = true;
    removeExplorationWorktree(record, "/repo", {
      listWorktrees: () => present ? [{ path: record.worktreePath, branch: record.branch }] : [],
      removeWorktree: () => { present = false; },
    });
    expect(present).toBe(false);
  });
});
