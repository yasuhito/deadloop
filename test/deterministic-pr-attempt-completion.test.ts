import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { processInput } = require("../extensions/deadloop/automations/complete-deterministic-pr-attempt.cts");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(role: "reviewer" | "branch-update", reportResult: Record<string, unknown>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-deterministic-pr-completion-"));
  roots.push(root);
  const promiseFile = path.join(root, "promise.json");
  const attemptRecordFile = path.join(root, "attempt.json");
  const head = "a".repeat(40);
  const record = {
    attemptId: "attempt-1", launchUuid: "launch-1", project: "demo", repository: "octo/demo", role,
    target: { kind: "pull-request", number: 24 }, inputRevision: { head, ...(role === "branch-update" ? { base: "b".repeat(40) } : {}) },
    branch: "feature", worktreePath: "/worktree", agentName: "agent", workspaceLabel: "attempt",
    promptFile: path.join(root, "prompt.md"), promiseFile, phase: "agent_started", lastSuccessfulPhase: "agent_started",
    workspaceId: "workspace", tabId: "tab", rootPaneId: "pane", reviewHistoryRequired: role === "reviewer",
  };
  const report = {
    schemaVersion: 1, attemptId: "attempt-1", role, status: "complete",
    target: { kind: "pull-request", number: 24, repository: "octo/demo" }, inputRevision: record.inputRevision,
    summary: "done", result: reportResult,
    evidence: role === "reviewer" ? { reviewed: ["diff"] } : {
      validations: [{ command: "npm test", result: "passed" }],
      finalizer: {
        action: "pushed", reason: "branch_update_pushed", originalHeadOid: head,
        baseHeadOid: "b".repeat(40), headOid: String(reportResult.outputRevision),
        checks: [{ command: "npm test", result: "passed" }],
      },
    },
  };
  fs.writeFileSync(attemptRecordFile, JSON.stringify(record));
  fs.writeFileSync(promiseFile, JSON.stringify(report));
  return {
    handoff: { kind: role, input: {
      attemptRecordFile, promiseFile, automationDir: "/automation", projectId: "demo", repoPath: "/repo",
      githubRepo: "octo/demo", stateDir: "/state", enabledAt: 1, prNumber: 24, expectedHeadOid: head,
      branch: "feature", worktreeRoot: "/worktrees", worktreePath: "/worktree", projectCheckCommand: "npm test",
      reviewLabel: "agent:review", implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch",
      inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked", autoMerge: false,
    } },
  };
}

describe("deterministic PR attempt completion", () => {
  it("routes a branch-update report through its bound completion handler", () => {
    const state = fixture("branch-update", { outcome: "branch_update_pushed", outputRevision: "c".repeat(40) });
    const scripts: string[] = [];

    processInput(state.handoff, { run: (script: string) => {
      scripts.push(script);
      if (script === "pr-branch-update-complete.cts") return { driverAction: "branch_update_review_requested" };
      if (script === "persist-attempt-result.cts") return { driverAction: "result_persisted" };
      return { driverAction: "workspace_closed" };
    } });

    expect(scripts).toEqual(["pr-branch-update-complete.cts", "persist-attempt-result.cts", "complete-attempt-workspace.cts"]);
  });

  it("dispatches a failed reviewer verification to the existing approval stop", () => {
    const state = fixture("reviewer", { outcome: "approved", reviewedHead: "a".repeat(40) });
    const scripts: string[] = [];

    processInput(state.handoff, { run: (script: string) => {
      scripts.push(script);
      if (script === "run-worker-required-verification.cts") throw new Error("required verification failed");
      return { action: "done", driverAction: "review_verification_blocked" };
    } });

    expect(scripts).toEqual(["run-worker-required-verification.cts", "pr-review-repair-dispatch.cts"]);
  });

  it("closes a stale-history reviewer after requesting a fresh review", () => {
    const state = fixture("reviewer", { outcome: "human_required", reviewedHead: "a".repeat(40) });
    const scripts: string[] = [];

    processInput(state.handoff, { run: (script: string) => {
      scripts.push(script);
      return script === "pr-review-repair-dispatch.cts"
        ? { action: "done", driverAction: "review_stale_history" }
        : { driverAction: "workspace_closed" };
    } });

    expect(scripts).toEqual(["pr-review-repair-dispatch.cts", "complete-attempt-workspace.cts"]);
  });

  it("routes actionable reviewer findings into deterministic repair dispatch", () => {
    const state = fixture("reviewer", { outcome: "changes_requested", reviewedHead: "a".repeat(40), findings: [{ title: "bug", body: "fix it", severity: "major" }] });

    const result = processInput(state.handoff, { run: () => ({
      action: "needs_llm", driverAction: "review_repair_monitor_request", monitorHandoff: { kind: "repair", input: {} },
    }) });

    expect(result.nextHandoff?.monitorHandoff?.kind).toBe("repair");
  });
});
