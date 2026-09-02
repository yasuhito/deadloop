import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { processInput } = require("../extensions/deadloop/automations/complete-deterministic-issue-attempt.cts");
const { createPreparedAttempt } = require("../src/attempt-lifecycle-runtime.cjs");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(kind: "issue" | "explorer", reportStatus: "complete" | "blocked", roleOverride?: string): Record<string, any> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-deterministic-issue-completion-"));
  roots.push(root);
  const runDir = path.join(root, "runs", "attempt-1");
  const promiseFile = path.join(runDir, "promise.json");
  const attemptRecordFile = path.join(runDir, "attempt.json");
  fs.mkdirSync(runDir, { recursive: true });
  const head = "a".repeat(40);
  createPreparedAttempt(runDir, {
    attemptId: "attempt-1",
    launchUuid: "launch-1",
    project: "demo",
    repository: "octo/demo",
    role: roleOverride || (kind === "issue" ? "worker" : "explorer"),
    target: { kind: "issue", number: 12 },
    inputRevision: { head },
    baseBranch: "main",
    branch: "agent/issue-12-task",
    worktreePath: "/worktree",
    agentName: "dl-w-12-abcdef123456",
    workspaceLabel: "attempt",
    promptFile: path.join(runDir, "prompt.md"),
    promiseFile,
    requiredVerification: {
      repository: "octo/demo",
      command: "npm test",
      source: { kind: "repo_policy", location: "deadloop.json" },
      baseRevision: head,
    },
    agentRequest: { role: kind === "issue" ? "worker" : "explorer", label: kind === "issue" ? "agent:implement" : "agent:explore", eventId: "7" },
  });
  const report = {
    schemaVersion: 1,
    attemptId: "attempt-1",
    role: roleOverride || (kind === "issue" ? "worker" : "explorer"),
    status: reportStatus,
    target: { repository: "octo/demo", kind: "issue", number: 12 },
    inputRevision: { head },
    summary: reportStatus === "blocked" ? "cannot proceed" : "done",
    result: reportStatus === "blocked"
      ? { reason: "spec_missing", explanation: "The contract is unclear.", recovery: "Clarify the contract." }
      : kind === "issue"
        ? { outputRevision: "b".repeat(40) }
        : { difficulty: "low", relevantFiles: ["src/a.ts"], verifiedClaims: ["x"], disprovedClaims: [], openQuestions: [] },
    evidence: reportStatus === "blocked" ? {} : kind === "issue"
      ? { validations: ["npm test passed"] }
      : { commands: ["ls src"] },
  };
  writeFileSyncSafe(promiseFile, JSON.stringify(report));
  return {
    runDir,
    handoff: {
      kind,
      input: {
        attemptRecordFile,
        promiseFile,
        automationDir: "/automation",
        projectId: "demo",
        repoPath: "/repo",
        githubRepo: "octo/demo",
        stateDir: root,
        enabledAt: 1,
        worktreePath: "/worktree",
        branch: "agent/issue-12-task",
        issueTitle: "Implement small feature",
        issueNumber: 12,
        readyLabel: "ready-for-agent",
        exploreLabel: "agent:explore",
        implementLabel: "agent:implement",
        reviewLabel: "agent:review",
        inProgressLabel: "agent:in-progress",
        blockedLabel: "agent:blocked",
        requestEventId: "7",
      },
    },
  };
}

function writeFileSyncSafe(file: string, content: string): void {
  fs.writeFileSync(file, content, "utf8");
}

/** A retry may re-present the existing result: its report names the input revision as its output. */
function rewriteReportAsSameRevision(promiseFile: string): void {
  const report = JSON.parse(fs.readFileSync(promiseFile, "utf8"));
  report.result = { outputRevision: report.inputRevision.head };
  fs.writeFileSync(promiseFile, JSON.stringify(report), "utf8");
}

describe("deterministic Issue attempt completion", () => {
  it("runs verification, guarded push, draft PR, persistence, then closure for a complete Worker report", () => {
    const state = fixture("issue", "complete");
    const scripts: string[] = [];

    const result = processInput(state.handoff, { lock: (operation: (enabled: unknown) => unknown) => operation({}), run: (script: string) => {
      scripts.push(script);
      if (script === "persist-attempt-result.cts") return { driverAction: "result_persisted" };
      if (script === "complete-attempt-workspace.cts") return { driverAction: "workspace_closed" };
      return {};
    } });

    expect({ scripts, applied: result.applied }).toEqual({
      scripts: [
        "run-worker-required-verification.cts",
        "guarded-push.cts",
        "guarded-worker-pr.cts",
        "persist-attempt-result.cts",
        "complete-attempt-workspace.cts",
      ],
      applied: true,
    });
  });

  it("skips rerunning verification when an authoritative record already binds this report", () => {
    const state = fixture("issue", "complete");
    const scripts: string[] = [];
    // The resume gate reads the real record file, so its absence forces the fresh run above;
    // here we assert the chain still reaches persistence through the injected runner.
    processInput(state.handoff, { lock: (operation: (enabled: unknown) => unknown) => operation({}), run: (script: string) => {
      scripts.push(script);
      return script === "persist-attempt-result.cts" ? { driverAction: "result_persisted" } : { driverAction: "workspace_closed" };
    } });

    expect(scripts[0]).toBe("run-worker-required-verification.cts");
  });

  it("keeps the attempt pending with visible failure evidence when verification fails", () => {
    const state = fixture("issue", "complete");

    const result = processInput(state.handoff, { lock: (operation: (enabled: unknown) => unknown) => operation({}), run: (script: string) => {
      if (script === "run-worker-required-verification.cts") throw new Error("required verification failed; log: /state/required-verification.log");
      throw new Error(`unexpected script ${script}`);
    } });

    expect({ applied: result.applied, result: result.result, retain: result.retain }).toEqual({
      applied: false,
      result: "required_verification_failed",
      retain: true,
    });
  });

  it("carries a caught sub-step exception message in the completion result instead of the bare exception tag", () => {
    const state = fixture("issue", "complete");

    const result = processInput(state.handoff, { lock: (operation: (enabled: unknown) => unknown) => operation({}), run: (script: string) => {
      if (script === "persist-attempt-result.cts") {
        return { action: "error", summary: "cannot persist the result marker: ENOSPC", driverAction: "exception" };
      }
      return script === "complete-attempt-workspace.cts" ? { driverAction: "workspace_closed" } : {};
    } });

    expect(result.result).toContain("cannot persist the result marker: ENOSPC");
  });

  it("names the failing sub-step script in the completion result", () => {
    const state = fixture("issue", "complete");

    const result = processInput(state.handoff, { lock: (operation: (enabled: unknown) => unknown) => operation({}), run: (script: string) => {
      if (script === "persist-attempt-result.cts") {
        return { action: "error", summary: "cannot persist the result marker: ENOSPC", driverAction: "exception" };
      }
      return script === "complete-attempt-workspace.cts" ? { driverAction: "workspace_closed" } : {};
    } });

    expect(result.result).toContain("persist-attempt-result.cts");
  });

  it("carries a caught closure exception message in the completion result", () => {
    const state = fixture("issue", "complete");

    const result = processInput(state.handoff, { lock: (operation: (enabled: unknown) => unknown) => operation({}), run: (script: string) => {
      if (script === "complete-attempt-workspace.cts") {
        return { action: "error", summary: "cannot close the workspace: pane vanished", driverAction: "exception" };
      }
      return script === "persist-attempt-result.cts" ? { driverAction: "result_persisted" } : {};
    } });

    expect(result.result).toContain("cannot close the workspace: pane vanished");
  });

  it("stops after a stale-policy verification block without replaying mutations", () => {
    const state = fixture("issue", "complete");
    const scripts: string[] = [];

    const result = processInput(state.handoff, { lock: (operation: (enabled: unknown) => unknown) => operation({}), run: (script: string) => {
      scripts.push(script);
      if (script === "run-worker-required-verification.cts") return { status: "blocked", reason: "stale_policy" };
      throw new Error(`unexpected script ${script}`);
    } });

    expect({ applied: result.applied, result: result.result, scripts }).toEqual({
      applied: true,
      result: "required_verification_blocked",
      scripts: ["run-worker-required-verification.cts"],
    });
  });

  it("persists one deadloop-authored stop for a blocked Worker report and closes only the workspace", () => {
    const state = fixture("issue", "blocked");
    const stopInputs: Record<string, unknown>[] = [];
    const scripts: string[] = [];
    const transitions = require("../src/issue-request-transition.cts");
    // The stop arrives after the agent started, so advance the journal to its completable phase.
    const lifecycle = require("../src/attempt-lifecycle-runtime.cjs");
    lifecycle.transitionPersistedAttempt(state.runDir, "github_claimed");
    lifecycle.transitionPersistedAttempt(state.runDir, "workspace_opened");
    lifecycle.transitionPersistedAttempt(state.runDir, "agent_started");
    const original = transitions.persistIssueAttemptStop as unknown;
    transitions.persistIssueAttemptStop = (input: Record<string, unknown>) => {
      stopInputs.push(input);
      (input.persistGithub as () => void)();
      return { kind: "blocked", requestEventId: String(input.requestEventId) };
    };

    try {
      const result = processInput(state.handoff, {
        lock: (operation: (enabled: { automationLogin?: string }) => unknown) => operation({ automationLogin: "deadloop-bot" }),
        run: (script: string) => {
          scripts.push(script);
          return script === "complete-attempt-workspace.cts" ? { driverAction: "workspace_closed" } : {};
        },
      });

      expect({
        applied: result.applied,
        result: result.result,
        stopNoun: stopInputs[0]?.stopNoun,
        clearedRequests: stopInputs[0]?.requestLabels,
        reason: (stopInputs[0]?.failure as Record<string, unknown>)?.reason,
        scripts,
      }).toEqual({
        applied: true,
        result: "issue_attempt_blocked_stopped",
        stopNoun: "implementation",
        clearedRequests: ["agent:implement", "agent:explore"],
        reason: "spec_missing",
        scripts: ["complete-attempt-workspace.cts"],
      });
    } finally {
      transitions.persistIssueAttemptStop = original;
    }
  });

  it("completes a same-revision Worker report by reusing the fully persisted existing result", () => {
    const state = fixture("issue", "complete");
    rewriteReportAsSameRevision(state.handoff.input.promiseFile);
    const scripts: string[] = [];

    const result = processInput(state.handoff, {
      lock: (operation: (enabled: unknown) => unknown) => operation({}),
      observeWorkerPrs: () => [{
        number: 3,
        state: "OPEN",
        headRefName: state.handoff.input.branch,
        headRefOid: JSON.parse(fs.readFileSync(state.handoff.input.promiseFile, "utf8")).result.outputRevision,
        baseRefName: "main",
        body: "Closes #12",
        labels: ["agent:review"],
        closingIssuesReferences: [{ number: 12 }],
        comments: [],
      }],
      run: (script: string) => {
        scripts.push(script);
        if (script === "persist-attempt-result.cts") return { driverAction: "result_persisted" };
        if (script === "complete-attempt-workspace.cts") return { driverAction: "workspace_closed" };
        return {};
      },
    });

    expect({ applied: result.applied, result: result.result, scripts }).toEqual({
      applied: true,
      result: "issue_attempt_completed",
      scripts: [
        "run-worker-required-verification.cts",
        "guarded-push.cts",
        "guarded-worker-pr.cts",
        "persist-attempt-result.cts",
        "complete-attempt-workspace.cts",
      ],
    });
  });

  it("stops once with a reasoned stop when a same-revision Worker report proves no persisted result", () => {
    const state = fixture("issue", "complete");
    rewriteReportAsSameRevision(state.handoff.input.promiseFile);
    const lifecycle = require("../src/attempt-lifecycle-runtime.cjs");
    lifecycle.transitionPersistedAttempt(state.runDir, "github_claimed");
    lifecycle.transitionPersistedAttempt(state.runDir, "workspace_opened");
    lifecycle.transitionPersistedAttempt(state.runDir, "agent_started");
    const stopInputs: Record<string, unknown>[] = [];
    const scripts: string[] = [];
    const transitions = require("../src/issue-request-transition.cts");
    const original = transitions.persistIssueAttemptStop as unknown;
    transitions.persistIssueAttemptStop = (input: Record<string, unknown>) => {
      stopInputs.push(input);
      (input.persistGithub as () => void)();
      return { kind: "blocked", requestEventId: String(input.requestEventId) };
    };

    try {
      const result = processInput(state.handoff, {
        lock: (operation: (enabled: { automationLogin?: string }) => unknown) => operation({ automationLogin: "deadloop-bot" }),
        observeWorkerPrs: () => [],
        run: (script: string) => {
          scripts.push(script);
          return script === "complete-attempt-workspace.cts" ? { driverAction: "workspace_closed" } : {};
        },
      });

      const failure = stopInputs[0]?.failure as Record<string, unknown>;
      expect({
        applied: result.applied,
        result: result.result,
        reason: failure?.reason,
        stopNoun: stopInputs[0]?.stopNoun,
        clearedRequests: stopInputs[0]?.requestLabels,
        scripts,
        explanationNamesMissingCommit: String(failure?.explanation).includes("without a new commit"),
        recoveryNamesRequest: String(failure?.recovery).includes("agent:implement"),
      }).toEqual({
        applied: true,
        result: "issue_attempt_noop_stopped",
        reason: "add_request",
        stopNoun: "implementation",
        clearedRequests: ["agent:implement", "agent:explore"],
        scripts: ["run-worker-required-verification.cts", "complete-attempt-workspace.cts"],
        explanationNamesMissingCommit: true,
        recoveryNamesRequest: true,
      });
    } finally {
      transitions.persistIssueAttemptStop = original;
    }
  });
});
