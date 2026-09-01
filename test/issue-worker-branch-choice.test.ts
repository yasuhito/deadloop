import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const { issueWorkerLaunchPlan, nextIssueWorkerBranch } = require("../extensions/deadloop/automations/issue-coordinator-driver.cts");

const ISSUE = { number: 394, title: "launch failure leftovers block the next request" };

function env(root: string) {
  return {
    projectId: "demo",
    repoPath: path.join(root, "repo"),
    worktreeRoot: path.join(root, "worktrees"),
    baseBranch: "main",
  };
}

function gitOps(existingBranches: string[]) {
  return {
    runText: (args: string[]) => {
      if (args[0] === "git" && args.includes("for-each-ref")) {
        return [...existingBranches].sort().map((branch) => `${branch}\n`).join("");
      }
      return "";
    },
  };
}

describe("fresh issue Worker branch names", () => {
  it("chooses the plain branch when no leftover holds it", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-branch-"));
    try {
      expect(nextIssueWorkerBranch(ISSUE, env(root), gitOps([]))).toBe("agent/issue-394-launch-failure-leftovers-block-the-next-request");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("picks a suffixed branch when the plain name is already taken", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-branch-"));
    try {
      const ops = gitOps(["agent/issue-394-launch-failure-leftovers-block-the-next-request"]);
      expect(nextIssueWorkerBranch(ISSUE, env(root), ops)).toBe("agent/issue-394-launch-failure-leftovers-block-the-next-request-1");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("counts past already suffixed leftovers", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-branch-"));
    try {
      const base = "agent/issue-394-launch-failure-leftovers-block-the-next-request";
      const ops = gitOps([base, `${base}-1`, `${base}-2`]);
      expect(nextIssueWorkerBranch(ISSUE, env(root), ops)).toBe(`${base}-3`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("treats an existing worktree path as a taken name even without a branch", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-branch-"));
    try {
      const project = env(root);
      mkdirSync(path.join(project.worktreeRoot, "agent-issue-394-launch-failure-leftovers-block-the-next-request"), { recursive: true });
      expect(nextIssueWorkerBranch(ISSUE, project, gitOps([]))).toBe("agent/issue-394-launch-failure-leftovers-block-the-next-request-1");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("binds the chosen fresh branch into the launch plan", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-branch-"));
    try {
      const plan = issueWorkerLaunchPlan(ISSUE, env(root), "launch-uuid", "a".repeat(40), null, "a".repeat(40), undefined, "agent/issue-394-sluggish");
      expect({
        branch: plan.branch,
        worktree: { mode: plan.input.worktree.mode, branch: plan.input.worktree.branch },
        intendedWorktreePath: plan.input.intendedWorktreePath,
      }).toEqual({
        branch: "agent/issue-394-sluggish",
        worktree: { mode: "create", branch: "agent/issue-394-sluggish" },
        intendedWorktreePath: path.join(root, "worktrees", "agent-issue-394-sluggish"),
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("still prefers the stopped journal's checkout over any fresh name", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-branch-"));
    try {
      const recovery = {
        branch: "agent/issue-394-recovered",
        worktreePath: path.join(root, "worktrees", "agent-issue-394-recovered"),
        preservedHead: "a".repeat(40),
        stoppedAt: "2026-08-30T00:00:00Z",
        workspaceId: "workspace-1",
        agentName: "dl-w-394-deadbeef0000",
      };
      const plan = issueWorkerLaunchPlan(ISSUE, env(root), "launch-uuid", "a".repeat(40), recovery as never, "a".repeat(40), undefined, "agent/issue-394-sluggish");
      expect({ branch: plan.branch, worktree: { mode: plan.input.worktree.mode, branch: plan.input.worktree.branch } })
        .toEqual({ branch: "agent/issue-394-recovered", worktree: { mode: "open", branch: "agent/issue-394-recovered" } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
