import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { deliverPendingDriverHandoff } from "../src/automation-runner";
const { applyDeterministicAttemptMonitoring } = require("../src/deterministic-attempt-monitor-runtime.cts");
const { applyTerminalMonitorDisposition } = require("../extensions/deadloop/automations/contain-terminal-monitor.cts");
const { readAttemptRecord } = require("../src/attempt-lifecycle-runtime.cjs");
const { observeAttemptMonitoringDirective } = require("../src/monitor-handoff-observation.cts");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(evidence = "terminal failure", targetKind: "issue" | "pull-request" = "issue") {
  const pullRequest = targetKind === "pull-request";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-terminal-monitor-"));
  roots.push(root);
  const runDir = path.join(root, "runs", "attempt-1");
  const worktreePath = path.join(root, "worktree");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(worktreePath);
  const attemptRecordFile = path.join(runDir, "attempt.json");
  fs.writeFileSync(attemptRecordFile, JSON.stringify({
    attemptId: "attempt-1",
    launchUuid: "launch-1",
    project: "demo",
    repository: "octo/demo",
    role: pullRequest ? "reviewer" : "worker",
    target: { kind: targetKind, number: 42 },
    inputRevision: { head: "a".repeat(40) },
    ...(pullRequest ? { reviewHistoryRequired: true } : {
      requiredVerification: {
        repository: "octo/demo",
        command: "npm test",
        source: { kind: "repo_policy", location: "deadloop.json" },
        baseRevision: "a".repeat(40),
      },
    }),
    branch: "agent/issue-42",
    worktreePath,
    agentName: "owner",
    workspaceLabel: "worker 42",
    promptFile: path.join(runDir, "prompt.md"),
    promiseFile: path.join(runDir, "promise.json"),
    phase: "agent_started",
    lastSuccessfulPhase: "agent_started",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    rootPaneId: "pane-1",
  }));
  const target = {
    number: 42,
    title: pullRequest ? "PR title" : "Issue title",
    body: pullRequest ? "PR body" : "Issue body",
    state: "OPEN",
    ...(pullRequest ? { headRefOid: "a".repeat(40) } : {}),
    labels: [pullRequest ? "agent:review" : "agent:implement", "agent:in-progress", "triage"],
  };
  const comments: Record<string, unknown>[] = [];
  let open = true;
  let agentStatus = "done";
  const runner = {
    listAgents: () => open ? [{ name: "owner", paneId: "pane-1", cwd: worktreePath, status: agentStatus }] : [],
    listWorkspaces: () => open ? [{ workspaceId: "workspace-1", worktreePath, tabCount: 1, paneCount: 1 }] : [],
    listWorktrees: () => [{ path: worktreePath }],
    closeWorkspace: () => { open = false; },
  };
  const commandRunner = {
    runText: () => evidence,
    runJson: (_args: string[], options: { input?: string } = {}) => {
      if (options.input) target.labels = JSON.parse(options.input).labels;
      return target.labels;
    },
  };
  const github = {
    getIssue: () => ({ ...target, labels: [...target.labels] }),
    getPr: () => ({ ...target, labels: [...target.labels] }),
    listIssueComments: () => [...comments],
    listPrComments: () => [...comments],
    commentIssue: (_repo: string, _number: number, body: string) => comments.push({
      user: { login: "deadloop-bot" }, body, created_at: "2026-08-21T00:00:00Z", updated_at: "2026-08-21T00:00:00Z",
    }),
    commentPr: (_repo: string, _number: number, body: string) => comments.push({
      user: { login: "deadloop-bot" }, body, created_at: "2026-08-21T00:00:00Z", updated_at: "2026-08-21T00:00:00Z",
    }),
  };
  const handoffInput = pullRequest
    ? {
        attemptRecordFile,
        promiseFile: path.join(runDir, "promise.json"),
        prNumber: 42,
        expectedHeadOid: "a".repeat(40),
        branch: "agent/issue-42",
        automationDir: "/automation",
        actorName: "reviewer",
        projectId: "demo",
        repoPath: root,
        worktreeRoot: root,
        worktreePath,
        githubRepo: "octo/demo",
        stateDir: root,
        enabledAt: 1,
        checkCommand: "npm test",
        projectCheckCommand: "npm test",
        workerAgent: "pi",
        workerModel: "",
        repairRemote: "origin",
        autoMerge: false,
        implementLabel: "agent:implement",
        updateBranchLabel: "agent:update-branch",
        reviewLabel: "agent:review",
        inProgressLabel: "agent:in-progress",
        blockedLabel: "agent:blocked",
      }
    : { attemptRecordFile, enabledAt: 1, issueNumber: 42, issueTitle: "Issue title", issueBody: "Issue body" };
  const input = {
    handoff: { kind: pullRequest ? "reviewer" : "issue", input: handoffInput },
    disposition: { action: "stop", reason: "missing_completion_report" },
    project: {
      id: "demo",
      repoPath: root,
      githubRepo: "octo/demo",
      stateDir: root,
      enabledAt: 1,
      automationLogin: "deadloop-bot",
      labels: {
        explore: "agent:explore",
        implement: "agent:implement",
        review: "agent:review",
        updateBranch: "agent:update-branch",
        inProgress: "agent:in-progress",
        blocked: "agent:blocked",
      },
    },
  };
  const dependencies = {
    commandRunner,
    runner,
    github,
    withEnabledProjectLock: (_project: unknown, operation: (enabled: unknown, recheck: () => void) => boolean) => operation({}, () => undefined),
  };
  return { attemptRecordFile, comments, dependencies, input, runner, setAgentStatus: (status: string) => { agentStatus = status; }, target };
}

describe("terminal monitor transition", () => {
  it("stops the exact Issue and releases the terminal attempt", () => {
    const state = fixture();

    const applied = applyTerminalMonitorDisposition(state.input, state.dependencies);

    expect({ applied, labels: state.target.labels, phase: readAttemptRecord(path.dirname(state.attemptRecordFile)).phase }).toEqual({
      applied: true,
      labels: ["triage", "agent:blocked"],
      phase: "authority_released",
    });
  });

  it("posts one human-readable stop explanation", () => {
    const state = fixture();

    applyTerminalMonitorDisposition(state.input, state.dependencies);

    expect(state.comments).toHaveLength(1);
  });

  it("retains the same runtime while waiting for model availability", () => {
    const state = fixture("Your credit balance is too low to access this model");
    state.input.disposition = { action: "wait_for_model", reason: "model_availability" };

    const applied = applyTerminalMonitorDisposition(state.input, state.dependencies);

    expect({ applied, agents: state.runner.listAgents().length, phase: readAttemptRecord(path.dirname(state.attemptRecordFile)).phase }).toEqual({
      applied: true,
      agents: 1,
      phase: "agent_started",
    });
  });

  it("stops working PR activity at the configured active-work limit", () => {
    const state = fixture("", "pull-request");
    state.setAgentStatus("working");
    state.input.disposition = {
      action: "stop",
      reason: "active_work_timeout",
      accounting: { activeMilliseconds: 86_400_000 },
      maxActiveMilliseconds: 86_400_000,
    } as any;

    applyTerminalMonitorDisposition(state.input, state.dependencies);

    expect(readAttemptRecord(path.dirname(state.attemptRecordFile)).authorityRelease.reason).toBe("runtime_timeout");
  });

  it("releases an attempt after interruption immediately following workspace close", () => {
    const state = fixture();
    const closeWorkspace = state.runner.closeWorkspace;
    let interrupted = true;
    state.runner.closeWorkspace = () => {
      closeWorkspace();
      if (interrupted) {
        interrupted = false;
        throw new Error("interrupted after close");
      }
    };
    try {
      applyTerminalMonitorDisposition(state.input, state.dependencies);
    } catch {}

    const applied = applyTerminalMonitorDisposition(state.input, state.dependencies);

    expect({ applied, phase: readAttemptRecord(path.dirname(state.attemptRecordFile)).phase }).toEqual({
      applied: true,
      phase: "authority_released",
    });
  });

  it("posts one model availability explanation across repeated ticks", () => {
    const state = fixture("Your credit balance is too low to access this model");
    state.input.disposition = { action: "wait_for_model", reason: "model_availability" };

    applyTerminalMonitorDisposition(state.input, state.dependencies);
    applyTerminalMonitorDisposition(state.input, state.dependencies);

    expect(state.comments).toHaveLength(1);
  });

  it("keeps the overnight PR #331 sequence free of Automation-host model turns across hundreds of ticks", () => {
    const state = fixture("terminal failure", "pull-request");
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "needs_llm",
        monitorHandoff: state.input.handoff,
        prompt: "reviewer monitor",
      },
    };
    const automationState = { automations: { reviewer: entry } };
    const monitorTurns: string[] = [];
    let now = 0;
    const dependencies = {
      enabledAt: () => 1,
      isEnabled: () => true,
      observeAttemptMonitoring: (_handoff: Record<string, unknown>, accounting: any, observedAt: number) => {
        const record = readAttemptRecord(path.dirname(state.attemptRecordFile));
        return observeAttemptMonitoringDirective(record, accounting, observedAt, 86_400_000, {
          runner: state.runner,
          readTerminalEvidence: () => "terminal failure",
        });
      },
      applyAttemptMonitoring: (handoff: Record<string, unknown>) => ({
        applied: applyTerminalMonitorDisposition(
          { handoff, disposition: { action: "stop", reason: "missing_completion_report" }, project: state.input.project },
          state.dependencies,
        ),
      }),
      now: () => now,
      saveState: () => undefined,
      sendUserMessage: (prompt: string) => monitorTurns.push(prompt),
    };

    for (let tick = 0; tick < 500; tick += 1) {
      now = tick * 60_000;
      deliverPendingDriverHandoff(entry, automationState, "PR reviewer", dependencies);
    }

    expect({ comments: state.comments.length, monitorTurns }).toEqual({ comments: 1, monitorTurns: [] });
  });

  it("keeps the shared issue Worker sequence free of Automation-host model turns across hundreds of ticks", () => {
    const state = fixture("terminal failure", "issue");
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "monitor",
        monitorHandoff: { kind: "issue", input: state.input.handoff.input },
        monitorAccounting: { activeMilliseconds: 0, observedAt: new Date(0).toISOString(), runtimeWasWorking: true },
      },
    };
    const automationState = { automations: { coordinator: entry } };
    const hostModelTurns: string[] = [];
    let now = 0;
    const dependencies = {
      enabledAt: () => 1,
      isEnabled: () => true,
      observeAttemptMonitoring: (_handoff: Record<string, unknown>, accounting: any, observedAt: number) => {
        const record = readAttemptRecord(path.dirname(state.attemptRecordFile));
        return observeAttemptMonitoringDirective(record, accounting, observedAt, 86_400_000, {
          runner: state.runner,
          readTerminalEvidence: () => "terminal failure",
        });
      },
      applyAttemptMonitoring: (handoff: Record<string, unknown>) => ({
        applied: applyTerminalMonitorDisposition(
          { handoff, disposition: { action: "stop", reason: "missing_completion_report" }, project: state.input.project },
          state.dependencies,
        ),
      }),
      now: () => now,
      saveState: () => undefined,
      sendUserMessage: (prompt: string) => hostModelTurns.push(prompt),
    };

    for (let tick = 0; tick < 500; tick += 1) {
      now = tick * 60_000;
      deliverPendingDriverHandoff(entry, automationState, "issue coordinator", dependencies);
    }

    expect({ comments: state.comments.length, hostModelTurns }).toEqual({ comments: 1, hostModelTurns: [] });
  });

  it("posts one model-availability explanation across waiting and retries on the deterministic reviewer path", () => {
    const state = fixture("Your credit balance is too low to access this model", "pull-request");
    const runDir = path.dirname(state.attemptRecordFile);
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "monitor",
        monitorHandoff: { kind: "reviewer", input: state.input.handoff.input },
        monitorAccounting: { activeMilliseconds: 60_000, observedAt: new Date(0).toISOString(), runtimeWasWorking: false },
      },
    };
    const automationState = { automations: { reviewer: entry } };
    const hostModelTurns: string[] = [];
    let now = 0;

    const dependencies = {
      enabledAt: () => 1,
      isEnabled: () => true,
      observeAttemptMonitoring: (_handoff: Record<string, unknown>, accounting: any, observedAt: number) =>
        observeAttemptMonitoringDirective(
          readAttemptRecord(runDir), accounting, observedAt, 86_400_000,
          { runner: state.runner, readTerminalEvidence: () => "Your credit balance is too low to access this model" },
        ),
      applyAttemptMonitoring: (handoff: Record<string, unknown>, directive: Record<string, any>) =>
        applyDeterministicAttemptMonitoring(handoff, directive as never, (currentHandoff: Record<string, unknown>, disposition: Record<string, unknown>) =>
          applyTerminalMonitorDisposition(
            { handoff: currentHandoff, disposition, project: state.input.project },
            state.dependencies,
          )),
      retryModelWait: () => {
        // The same agent session accepts the continuation input; the turn resumes working.
        state.setAgentStatus("working");
        return true;
      },
      now: () => now,
      saveState: () => undefined,
      sendUserMessage: (prompt: string) => hostModelTurns.push(prompt),
    };
    const tick = () => deliverPendingDriverHandoff(entry, automationState, "PR reviewer", dependencies);

    tick();
    const waitRecorded = (entry.pendingDriverHandoff as Record<string, any>).modelWait?.nextRetryAt === null;
    now = 60_000;
    tick();
    state.setAgentStatus("done");
    now = 120_000;
    tick();
    now = 180_000;
    tick();

    expect({
      comments: state.comments.length,
      hostModelTurns,
      waitRecorded,
      retriesAcrossEpisodes: (entry.pendingDriverHandoff as Record<string, any>).modelRetryCount,
    }).toEqual({ comments: 1, hostModelTurns: [], waitRecorded: true, retriesAcrossEpisodes: 2 });
  });
});
