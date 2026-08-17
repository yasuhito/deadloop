import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const {
  assertOwnedExplorationWorkspace,
  persistExplorationDiagnostic,
  persistExplorationOutcome,
  persistExplorationWorktreeCleanup,
  publicUnprovableExplorationFailure,
  readOnlyExplorationFailure,
  removeExplorationWorktree,
  renderExplorationResult,
} = require("../extensions/deadloop/automations/complete-issue-exploration.ts");

const record = {
  workspaceId: "workspace-1",
  worktreePath: "/worktrees/explore-42",
  branch: "agent/explore-42",
};

const report = {
  schemaVersion: 1,
  role: "explorer",
  status: "complete",
  attemptId: "attempt-42",
  target: { repository: "owner/repo", kind: "issue", number: 42 },
  inputRevision: { head: "a".repeat(40) },
  summary: "The change is straightforward.",
  result: {
    difficulty: "low",
    relevantFiles: ["src/example.ts"],
    verifiedClaims: ["The seam already exists."],
    disprovedClaims: [],
    openQuestions: ["Which name should be public?"],
    approach: "Extend the existing seam.",
  },
  evidence: { commands: [] },
};

const outcomeRecord = {
  attemptId: "attempt-42",
  launchUuid: "launch-42",
  project: "demo",
  repository: "owner/repo",
  role: "explorer",
  target: { kind: "issue", number: 42 },
  inputRevision: { head: "a".repeat(40) },
  branch: "agent/explore-42",
  worktreePath: "/worktrees/explore-42",
  agentName: "dl-e-42-deadbeef0000",
  workspaceLabel: "explorer 42",
  promptFile: "/runs/attempt-42/prompt.md",
  promiseFile: "/runs/attempt-42/promise.json",
  phase: "agent_started",
  lastSuccessfulPhase: "agent_started",
  workspaceId: "workspace-1",
  tabId: "tab-1",
  rootPaneId: "pane-1",
  agentRequest: { role: "explorer", label: "agent:explore", eventId: "request-42" },
};

const failure = {
  reason: "exploration_failed",
  explanation: "Exploration failed.",
  recovery: "Retry after fixing it.",
};

function blockedReport() {
  return {
    ...report,
    status: "blocked",
    summary: failure.explanation,
    result: failure,
    evidence: {},
  };
}

describe("Issue exploration completion", () => {
  it("renders the authorized human-readable result", () => {
    expect(renderExplorationResult(report)).toContain("### Verified claims\n- The seam already exists.");
  });

  it("persists cleanup evidence bound to the explorer checkout", () => {
    const runDir = mkdtempSync(path.join(os.tmpdir(), "deadloop-exploration-cleanup-"));
    try {
      persistExplorationWorktreeCleanup(runDir, outcomeRecord);
      const receipt = JSON.parse(readFileSync(path.join(runDir, "exploration-worktree-cleaned.json"), "utf8"));
      expect({ branch: receipt.branch, worktreePath: receipt.worktreePath }).toEqual({
        branch: outcomeRecord.branch,
        worktreePath: path.resolve(outcomeRecord.worktreePath),
      });
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("keeps a durably chosen successful outcome when a retry presents a blocked report", () => {
    const runDir = mkdtempSync(path.join(os.tmpdir(), "deadloop-exploration-outcome-"));
    try {
      persistExplorationOutcome(runDir, outcomeRecord, report, null);
      expect(persistExplorationOutcome(runDir, outcomeRecord, blockedReport(), failure).outcome).toBe("persisted");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("keeps a durably chosen blocked outcome when a retry presents success", () => {
    const runDir = mkdtempSync(path.join(os.tmpdir(), "deadloop-exploration-outcome-"));
    try {
      persistExplorationOutcome(runDir, outcomeRecord, blockedReport(), failure);
      expect(persistExplorationOutcome(runDir, outcomeRecord, report, null).outcome).toBe("blocked");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("uses a path-free public unprovable-state explanation", () => {
    expect(publicUnprovableExplorationFailure().explanation).toBe(
      "deadloop could not prove that the read-only explorer left its owned checkout unchanged.",
    );
  });

  it("retains an unprovable-state path only in local diagnostics", () => {
    const runDir = mkdtempSync(path.join(os.tmpdir(), "deadloop-exploration-diagnostic-"));
    try {
      persistExplorationDiagnostic(runDir, outcomeRecord, "attempt worktree is missing: /home/operator/private");
      expect(readFileSync(path.join(runDir, "exploration-diagnostic.json"), "utf8")).toContain("/home/operator/private");
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  it("rejects an exploration result after repository HEAD changes", () => {
    expect(readOnlyExplorationFailure({ inputRevision: { head: "a".repeat(40) } }, "b".repeat(40), "")?.reason)
      .toBe("explorer_repository_changed");
  });

  it("rejects an exploration result after repository files change", () => {
    expect(readOnlyExplorationFailure({ inputRevision: { head: "a".repeat(40) } }, "a".repeat(40), " M src/example.ts\n")?.reason)
      .toBe("explorer_repository_changed");
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
