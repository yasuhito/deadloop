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

function repairFixture(outcome: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-deterministic-pr-completion-"));
  roots.push(root);
  const promiseFile = path.join(root, "promise.json");
  const attemptRecordFile = path.join(root, "attempt.json");
  const head = "a".repeat(40);
  const newHead = "b".repeat(40);
  const record = {
    attemptId: "attempt-1", launchUuid: "launch-1", project: "demo", repository: "octo/demo", role: "review-repair",
    target: { kind: "pull-request", number: 24 }, inputRevision: { head },
    branch: "feature", worktreePath: "/worktree", agentName: "agent", workspaceLabel: "attempt",
    promptFile: path.join(root, "prompt.md"), promiseFile, phase: "agent_started", lastSuccessfulPhase: "agent_started",
    workspaceId: "workspace", tabId: "tab", rootPaneId: "pane",
  };
  const pushed = outcome === "repair_pushed";
  const blocked = outcome === "blocked";
  const report = blocked
    ? {
        schemaVersion: 1, attemptId: "attempt-1", role: "review-repair", status: "blocked",
        target: { kind: "pull-request", number: 24, repository: "octo/demo" }, inputRevision: { head },
        summary: "stuck", result: { reason: "inconclusive_repair_completion", explanation: "receipt missing", recovery: "inspect the worktree" },
        evidence: {},
      }
    : {
        schemaVersion: 1, attemptId: "attempt-1", role: "review-repair", status: "complete",
        target: { kind: "pull-request", number: 24, repository: "octo/demo" }, inputRevision: { head },
        summary: "done",
        result: pushed
          ? { outcome, outputRevision: newHead, repairs: [{ title: "Fix", summary: "fixed", paths: ["src/a.ts"] }] }
          : { outcome, outputRevision: newHead },
        evidence: {
          validations: [{ command: "npm test", result: "passed" }],
          finalizer: {
            action: pushed ? "pushed" : "stale_head", reason: outcome, originalHeadOid: head,
            ...(pushed ? { headOid: newHead } : { currentRemoteHeadOid: newHead }),
            checks: [{ command: "npm test", result: "passed" }],
          },
        },
      };
  fs.writeFileSync(attemptRecordFile, JSON.stringify(record));
  fs.writeFileSync(promiseFile, JSON.stringify(report));
  return {
    attemptKey: record.attemptId,
    handoff: { kind: "repair", input: {
      attemptRecordFile, promiseFile, automationDir: "/automation", projectId: "demo", repoPath: "/repo",
      githubRepo: "octo/demo", stateDir: "/state", enabledAt: 1, prNumber: 24, expectedHeadOid: head,
      branch: "feature", reviewLabel: "agent:review", implementLabel: "agent:implement",
      updateBranchLabel: "agent:update-branch", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
      attemptKey: record.attemptId,
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
      action: "monitor", driverAction: "review_repair_monitor_request", monitorHandoff: { kind: "repair", input: {} },
    }) });

    expect(result.nextHandoff?.monitorHandoff?.kind).toBe("repair");
  });

  it("closes an approved non-autoMerge review through the explicit human handoff expectation", () => {
    const state = fixture("reviewer", { outcome: "approved", reviewedHead: "a".repeat(40) });
    const invocations: string[][] = [];

    processInput(state.handoff, { run: (script: string, args: string[]) => {
      invocations.push([script, ...args]);
      return script === "pr-review-repair-dispatch.cts" ? { action: "done", driverAction: "review_approved" } : { driverAction: "workspace_closed" };
    } });

    const closure = invocations.find((invocation) => invocation[0] === "complete-attempt-workspace.cts");
    expect(closure?.includes("--handoff-review-label")).toBe(true);
  });

  it("closes a handed-off human_required review through the explicit human handoff expectation", () => {
    const state = fixture("reviewer", { outcome: "human_required", reviewedHead: "a".repeat(40) });
    const invocations: string[][] = [];

    processInput(state.handoff, { run: (script: string, args: string[]) => {
      invocations.push([script, ...args]);
      return script === "pr-review-repair-dispatch.cts" ? { action: "done", driverAction: "review_human_handoff" } : { driverAction: "workspace_closed" };
    } });

    const closure = invocations.find((invocation) => invocation[0] === "complete-attempt-workspace.cts");
    expect(closure?.includes("--handoff-blocked-label")).toBe(true);
  });

  it("routes a pushed repair report through its completion handler and closes the workspace", () => {
    const state = repairFixture("repair_pushed");
    const scripts: string[] = [];

    const result = processInput(state.handoff, { run: (script: string) => {
      scripts.push(script);
      return script === "pr-review-repair-complete.cts"
        ? { action: "done", driverAction: "repair_result_posted" }
        : { driverAction: "workspace_closed" };
    } });

    expect({ scripts, result }).toEqual({
      scripts: ["pr-review-repair-complete.cts", "complete-attempt-workspace.cts"],
      result: { applied: true, result: "repair_result_posted" },
    });
  });

  it("binds the repair completion handler to the canonical receipt and contract files", () => {
    const state = repairFixture("repair_pushed");
    let args: string[] = [];

    processInput(state.handoff, { run: (script: string, invocationArgs: string[]) => {
      if (script === "pr-review-repair-complete.cts") args = invocationArgs;
      return { driverAction: "repair_human_blocked" };
    } });

    const value = (name: string) => args[args.indexOf(name) + 1];
    expect({ result: value("--result"), contract: value("--contract"), attemptKey: value("--attempt-key") }).toEqual({
      result: path.join(path.dirname(value("--promise")), "finalizer-result.json"),
      contract: path.join(path.dirname(value("--promise")), "review-contract.json"),
      attemptKey: state.attemptKey,
    });
  });

  it("keeps a human-blocked repair workspace retained without a workspace close", () => {
    const state = repairFixture("blocked");
    const scripts: string[] = [];

    const result = processInput(state.handoff, { run: (script: string) => {
      scripts.push(script);
      return script === "pr-review-repair-complete.cts" ? { driverAction: "repair_human_blocked" } : { driverAction: "workspace_closed" };
    } });

    expect({ scripts, result }).toEqual({
      scripts: ["pr-review-repair-complete.cts"],
      result: { applied: true, result: { driverAction: "repair_human_blocked" } },
    });
  });

  it("closes a stale-head repair after its bound handler reports no public success", () => {
    const state = repairFixture("stale_head");
    const scripts: string[] = [];

    const result = processInput(state.handoff, { run: (script: string) => {
      scripts.push(script);
      return script === "pr-review-repair-complete.cts" ? { driverAction: "repair_stale_head" } : { driverAction: "workspace_closed" };
    } });

    expect({ scripts, result }).toEqual({
      scripts: ["pr-review-repair-complete.cts", "complete-attempt-workspace.cts"],
      result: { applied: true, result: "repair_stale_head" },
    });
  });
});
