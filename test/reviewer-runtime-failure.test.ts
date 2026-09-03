import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { reportObservation } = require("../src/monitor-handoff-observation.cts");
const { decideAttemptMonitoring } = require("../src/attempt-monitoring.cts");
const { decideMonitorContainment } = require("../src/monitor-handoff-containment.cts");
const { applyDeterministicAttemptMonitoring } = require("../src/deterministic-attempt-monitor-runtime.cts");
const { applyTerminalMonitorDisposition } = require("../extensions/deadloop/automations/contain-terminal-monitor.cts");

const HEAD = "a".repeat(40);
const started = "2026-08-26T00:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
});

function unreadableReport(error: NodeJS.ErrnoException) {
  return vi.spyOn(fs, "readFileSync").mockImplementation(() => {
    throw error;
  });
}

describe("formal storage-exhaustion evidence from deadloop's own processing", () => {
  it("classifies an ENOSPC completion-report read failure as observed storage exhaustion", () => {
    const record = { promiseFile: "/runs/attempt-1/promise.json" };
    unreadableReport(Object.assign(new Error("read failed"), { code: "ENOSPC" }));

    expect(reportObservation(record)).toEqual({ kind: "invalid", cause: "storage_exhaustion" });
  });

  it("classifies an EDQUOT completion-report read failure the same way", () => {
    const record = { promiseFile: "/runs/attempt-1/promise.json" };
    unreadableReport(Object.assign(new Error("quota exceeded"), { code: "EDQUOT" }));

    expect(reportObservation(record)).toEqual({ kind: "invalid", cause: "storage_exhaustion" });
  });

  it("keeps an ordinary unreadable report a generic invalid observation", () => {
    const record = { promiseFile: "/runs/attempt-1/promise.json" };
    unreadableReport(Object.assign(new Error("permission denied"), { code: "EACCES" }));

    expect(reportObservation(record)).toEqual({ kind: "invalid" });
  });

  it("carries the validator message when the report lacks a summary", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-report-detail-"));
    const runDir = path.join(root, "runs", "attempt-1");
    fs.mkdirSync(runDir, { recursive: true });
    const record = {
      attemptId: "attempt-1",
      launchUuid: "launch-1",
      project: "demo",
      repository: "octo/demo",
      role: "reviewer",
      target: { kind: "pull-request", number: 42 },
      inputRevision: { head: HEAD },
      branch: "pr-42",
      worktreePath: path.join(root, "worktree"),
      agentName: "reviewer",
      workspaceLabel: "reviewer 42",
      promptFile: path.join(runDir, "prompt.md"),
      promiseFile: path.join(runDir, "promise.json"),
      phase: "agent_started",
      lastSuccessfulPhase: "agent_started",
    };
    fs.writeFileSync(record.promiseFile, JSON.stringify({
      schemaVersion: 1,
      attemptId: "attempt-1",
      role: "reviewer",
      target: { repository: "octo/demo", kind: "pull-request", number: 42 },
      inputRevision: { head: HEAD },
      status: "complete",
      result: { outcome: "approved", reviewedHead: HEAD, findings: [] },
      evidence: { reviewed: ["diff and configured checks"] },
    }));

    expect(String((reportObservation(record) as { detail?: string }).detail)).toContain("summary");
  });
});

describe("the monitor observation of a reviewer report missing its review-history disposition", () => {
  const input = {
    attempt: { phase: "agent_started" },
    accounting: { activeMilliseconds: 0, observedAt: started, runtimeWasWorking: true },
    maxActiveMilliseconds: 86_400_000,
    now: started,
  };
  const record = {
    attemptId: "attempt-1",
    launchUuid: "launch-1",
    project: "demo",
    repository: "octo/demo",
    role: "reviewer",
    target: { kind: "pull-request", number: 42 },
    inputRevision: { head: HEAD },
    branch: "pr-42",
    worktreePath: "/worktrees/pr-42",
    agentName: "reviewer",
    workspaceLabel: "reviewer 42",
    promptFile: "/runs/attempt-1/prompt.md",
    promiseFile: "/runs/attempt-1/promise.json",
    phase: "agent_started",
    lastSuccessfulPhase: "agent_started",
  };
  // The observed incident: an ended reviewer wrote a complete-shaped report whose review-history
  // disposition was missing, and the pending handoff retried the same rejection every tick (#427).
  const report = {
    schemaVersion: 1,
    attemptId: "attempt-1",
    role: "reviewer",
    target: { repository: "octo/demo", kind: "pull-request", number: 42 },
    inputRevision: { head: HEAD },
    status: "complete",
    summary: "review finished",
    result: { outcome: "changes_requested", reviewedHead: HEAD, findings: [{ title: "Bug", body: "Fix it", severity: "major" }] },
    evidence: { reviewed: ["diff and configured checks"] },
  };

  it("classifies the report as invalid and names the missing disposition", () => {
    const observed = reportObservation({ ...record, promiseFile: writeReport(report) } as never) as { kind: string; detail?: string };

    expect(observed.kind).toBe("invalid");
  });

  it("directs the ended reviewer to the invalid-report stop that carries the detail", () => {
    const observed = reportObservation({ ...record, promiseFile: writeReport(report) } as never) as { kind: string; detail?: string };
    const directive = decideAttemptMonitoring({
      ...input,
      report: observed,
      runtime: { kind: "terminal", status: "done" },
    });

    expect(directive).toMatchObject({ action: "missing_report", reason: "invalid_completion_report" });
  });

  function writeReport(value: unknown): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-history-"));
    const file = path.join(root, "promise.json");
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  }
});

describe("the reviewer stop classification for a storage-broken report", () => {
  const input = {
    attempt: { phase: "agent_started" },
    accounting: { activeMilliseconds: 0, observedAt: started, runtimeWasWorking: true },
    maxActiveMilliseconds: 86_400_000,
    now: started,
  };

  it("directs it to the storage-exhaustion missing-report reason", () => {
    expect(decideAttemptMonitoring({
      ...input,
      report: { kind: "invalid", cause: "storage_exhaustion" },
      runtime: { kind: "terminal", status: "done" },
    })).toMatchObject({ action: "missing_report", reason: "storage_exhaustion" });
  });

  it("stops with the same reason on the containment observation path", () => {
    expect(decideMonitorContainment({
      record: { phase: "agent_started" },
      report: { kind: "invalid", cause: "storage_exhaustion" },
      runtime: { kind: "owner_absent" },
    })).toEqual({ action: "stop", reason: "storage_exhaustion" });
  });

  it("applies the capacity-stop disposition through the deterministic monitoring boundary", () => {
    const appliedDispositions: unknown[] = [];
    applyDeterministicAttemptMonitoring(
      { input: {} },
      { action: "missing_report", reason: "storage_exhaustion", accounting: input.accounting },
      (_handoff, disposition) => {
        appliedDispositions.push(disposition);
        return true;
      },
    );

    expect(appliedDispositions).toEqual([{ action: "stop", reason: "storage_exhaustion" }]);
  });

  it("carries the validation detail on the invalid-report directive", () => {
    expect(decideAttemptMonitoring({
      ...input,
      report: { kind: "invalid", detail: "completion report summary must be a non-empty string" },
      runtime: { kind: "terminal", status: "done" },
    })).toMatchObject({
      action: "missing_report",
      reason: "invalid_completion_report",
      detail: "completion report summary must be a non-empty string",
    });
  });

  it("carries the validation detail on the stop disposition", () => {
    const appliedDispositions: unknown[] = [];
    applyDeterministicAttemptMonitoring(
      { input: {} },
      {
        action: "missing_report",
        reason: "invalid_completion_report",
        detail: "completion report summary must be a non-empty string",
        accounting: input.accounting,
      },
      (_handoff, disposition) => {
        appliedDispositions.push(disposition);
        return true;
      },
    );

    expect(appliedDispositions).toEqual([{
      action: "stop",
      reason: "invalid_completion_report",
      detail: "completion report summary must be a non-empty string",
    }]);
  });
});

function fixture(dispositionReason = "missing_completion_report") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-reviewer-failure-"));
  const runDir = path.join(root, "runs", "attempt-1");
  const worktreePath = path.join(root, "worktrees", "pr-42");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  const promiseFile = path.join(runDir, "promise.json");
  fs.writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
    attemptId: "attempt-1",
    launchUuid: "launch-1",
    project: "demo",
    repository: "octo/demo",
    role: "reviewer",
    target: { kind: "pull-request", number: 42 },
    inputRevision: { head: HEAD },
    branch: "pr-42",
    worktreePath,
    agentName: "reviewer",
    workspaceLabel: "reviewer 42",
    promptFile: path.join(runDir, "prompt.md"),
    promiseFile,
    phase: "agent_started",
    lastSuccessfulPhase: "agent_started",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    rootPaneId: "pane-1",
  }));
  const target = {
    number: 42,
    state: "OPEN",
    headRefOid: HEAD,
    labels: ["agent:review", "agent:in-progress", "triage"],
  };
  const comments: Record<string, unknown>[] = [];
  let open = true;
  let headReads = 0;
  const runner = {
    listAgents: () => open ? [{ name: "reviewer", paneId: "pane-1", cwd: worktreePath, status: "done" }] : [],
    listWorkspaces: () => open ? [{ workspaceId: "workspace-1", worktreePath, tabCount: 1, paneCount: 1 }] : [],
    listWorktrees: () => [{ path: worktreePath }],
    closeWorkspace: () => { open = false; },
  };
  const commandRunner = {
    runText: () => "terminal failure",
    runJson: (_args: string[], options: { input?: string } = {}) => {
      if (options.input) target.labels = JSON.parse(options.input).labels;
      return target.labels;
    },
  };
  const github = {
    getIssue: () => ({ ...target }),
    getPr: () => ({ ...target }),
    listIssueComments: () => [...comments],
    listPrComments: () => [...comments],
    commentIssue: (_repo: string, _number: number, body: string) => comments.push({
      user: { login: "deadloop-bot" }, body, created_at: "2026-08-26T00:00:00Z", updated_at: "2026-08-26T00:00:00Z",
    }),
    commentPr: (_repo: string, _number: number, body: string) => comments.push({
      user: { login: "deadloop-bot" }, body, created_at: "2026-08-26T00:00:00Z", updated_at: "2026-08-26T00:00:00Z",
    }),
  };
  const handoffInput = {
    attemptRecordFile: path.join(runDir, "attempt.json"),
    promiseFile,
    prNumber: 42,
    expectedHeadOid: HEAD,
    branch: "pr-42",
    automationDir: "/automation",
    actorName: "reviewer",
    projectId: "demo",
    repoPath: root,
    githubRepo: "octo/demo",
    stateDir: root,
    enabledAt: 1,
  };
  const input = {
    handoff: { kind: "reviewer", input: handoffInput },
    disposition: { action: "stop", reason: dispositionReason },
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
    withEnabledProjectLock: (_project: unknown, operation: (enabled: unknown, recheck: () => void) => boolean) =>
      operation({}, () => undefined),
  };
  return {
    comments,
    dependencies,
    github,
    input,
    promiseFile,
    root,
    target,
    worktreePath,
    /** The formal channel: the attempt's report file exists, but deadloop cannot read it. */
    breakPromiseRead() {
      const real = fs.readFileSync;
      vi.spyOn(fs, "readFileSync").mockImplementation(((file: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) => {
        if (String(file) === promiseFile) throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
        return (real as (...args: unknown[]) => string)(file, ...rest);
      }) as typeof fs.readFileSync);
    },
    setChangedHeadAfterFirstObservation() {
      const changed = `${"b".repeat(39)}c`;
      github.getPr = () => {
        headReads += 1;
        return headReads > 1 ? { ...target, headRefOid: changed } : { ...target };
      };
    },
    setChangedHeadBeforeComment() {
      const changed = `${"b".repeat(39)}c`;
      github.commentPr = (repo: string, number_: number, body: string) => {
        target.headRefOid = changed;
        return github.commentPr(repo, number_, body);
      };
    },
  };
}

describe("the published reviewer failure record", () => {
  it("names the capacity stop and its recovery steps for an ENOSPC-evidenced stop", () => {
    const world = fixture("storage_exhaustion");
    world.breakPromiseRead();
    applyTerminalMonitorDisposition(world.input, world.dependencies);

    expect(String(world.comments[0]?.body)).toContain("free up storage on the machine running deadloop");
  });

  it("binds the hidden marker to the attempt, the selection-time head, and the reason", () => {
    const world = fixture("storage_exhaustion");
    world.breakPromiseRead();
    applyTerminalMonitorDisposition(world.input, world.dependencies);

    expect(String(world.comments[0]?.body))
      .toContain(`<!-- deadloop:terminal-monitor-stop attempt=attempt-1 head=${HEAD} reason=free_storage -->`);
  });

  it("omits local worktree and completion-report paths from the public comment", () => {
    const world = fixture("storage_exhaustion");
    world.breakPromiseRead();
    applyTerminalMonitorDisposition(world.input, world.dependencies);
    const body = String(world.comments[0]?.body || "");

    expect([world.worktreePath, world.promiseFile].some((localPath) => body.includes(localPath))).toBe(false);
  });

  it("posts one comment when the same failure is processed again", () => {
    const world = fixture("storage_exhaustion");
    world.breakPromiseRead();
    applyTerminalMonitorDisposition(world.input, world.dependencies);
    applyTerminalMonitorDisposition(world.input, world.dependencies);

    expect(world.comments).toHaveLength(1);
  });

  it("binds the generic technical-failure marker to the same triple", () => {
    const world = fixture();
    applyTerminalMonitorDisposition(world.input, world.dependencies);

    expect(String(world.comments[0]?.body))
      .toContain(`<!-- deadloop:terminal-monitor-stop attempt=attempt-1 head=${HEAD} reason=add_request -->`);
  });

  it("names the rejected field when the report is invalid", () => {
    const world = fixture("invalid_completion_report");
    fs.writeFileSync(world.promiseFile, JSON.stringify({
      schemaVersion: 1,
      attemptId: "attempt-1",
      role: "reviewer",
      target: { repository: "octo/demo", kind: "pull-request", number: 42 },
      inputRevision: { head: HEAD },
      status: "complete",
      result: { outcome: "approved", reviewedHead: HEAD, findings: [] },
      evidence: { reviewed: ["diff and configured checks"] },
    }));
    world.input.disposition = {
      action: "stop",
      reason: "invalid_completion_report",
      detail: "completion report summary must be a non-empty string",
    } as any;

    applyTerminalMonitorDisposition(world.input, world.dependencies);

    expect(String(world.comments[0]?.body)).toContain("summary");
  });
});

describe("the exact-head guards around the stop mutations", () => {
  it("does not post the comment when the head changes just before posting", () => {
    const world = fixture();
    world.setChangedHeadBeforeComment();
    try {
      applyTerminalMonitorDisposition(world.input, world.dependencies);
    } catch {}

    expect(world.comments).toHaveLength(0);
  });

  it("does not move labels when the head changes just before the label move", () => {
    const world = fixture();
    world.setChangedHeadAfterFirstObservation();
    try {
      applyTerminalMonitorDisposition(world.input, world.dependencies);
    } catch {}

    expect(world.target.labels).toEqual(["agent:review", "agent:in-progress", "triage"]);
  });

  it("honors a completion report that appeared before the stop applies", () => {
    const world = fixture();
    fs.writeFileSync(world.promiseFile, JSON.stringify({
      schemaVersion: 1,
      attemptId: "attempt-1",
      role: "reviewer",
      status: "complete",
      summary: "approved after all",
      target: { repository: "octo/demo", kind: "pull-request", number: 42 },
      inputRevision: { head: HEAD },
      result: { outcome: "approved", reviewedHead: HEAD },
      evidence: { reviewed: ["read the diff"] },
    }));

    const applied = applyTerminalMonitorDisposition(world.input, world.dependencies);

    expect(applied).toBe(false);
  });
});
