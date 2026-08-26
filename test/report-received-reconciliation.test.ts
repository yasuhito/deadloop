import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { reconcileReportReceivedLocked } = require("../extensions/deadloop/automations/reconcile-report-received-attempt.cts");
const {
  createPreparedAttempt,
  readAttemptRecord,
  recordPersistedCompletionReport,
  transitionPersistedAttempt,
} = require("../src/attempt-lifecycle-runtime.cjs");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const HEAD = "a".repeat(40);
const OUTPUT = "b".repeat(40);

function setup(): { args: Record<string, string>; runDir: string; promiseFile: string; projectRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-report-received-reconcile-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const runDir = path.join(stateDir, "runs", "launch-1");
  const promiseFile = path.join(runDir, "promise.json");
  createPreparedAttempt(runDir, {
    attemptId: "launch-1", launchUuid: "launch-1", project: "demo", repository: "octo/demo", role: "worker",
    target: { kind: "issue", number: 12 }, inputRevision: { head: HEAD },
    branch: "agent/issue-12", baseBranch: "origin/main",
    worktreePath: path.join(root, "worktree"), agentName: "dl-w-12-abcdef123456",
    workspaceLabel: "Issue 12", promptFile: path.join(runDir, "prompt.md"), promiseFile,
    workspaceId: "ws-launch-1",
    agentRequest: { role: "worker", label: "agent:implement", eventId: "request-7" },
  });
  transitionPersistedAttempt(runDir, "github_claimed");
  transitionPersistedAttempt(runDir, "workspace_opened");
  transitionPersistedAttempt(runDir, "agent_started");
  recordPersistedCompletionReport(runDir, {
    schemaVersion: 1, attemptId: "launch-1", role: "worker", status: "complete",
    target: { repository: "octo/demo", kind: "issue", number: 12 },
    inputRevision: { head: HEAD }, summary: "implemented",
    result: { outputRevision: OUTPUT }, evidence: { validations: ["npm test passed"] },
  });
  return {
    args: {
      attemptRecord: path.join(runDir, "attempt.json"), projectId: "demo", projectRepo: root,
      githubRepo: "octo/demo", stateDir, enabledAt: "1",
      readyLabel: "ready-for-agent", exploreLabel: "agent:explore", implementLabel: "agent:implement",
      reviewLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
      automationLogins: "deadloop-bot",
    },
    runDir,
    promiseFile,
    projectRoot: root,
  };
}

function stoppedRuntimeDirective(action: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtime: { kind: "owner_absent" },
    directive: { action, accounting: {}, ...extra },
  };
}

/** GitHub double whose timeline starts from this attempt's consumed request and live active state. */
function issueTimeline() {
  const start = Date.parse("2026-08-18T00:00:00Z");
  const events: any[] = [
    { id: "request-7", event: "labeled", created_at: new Date(start).toISOString(), actor: { login: "human" }, label: { name: "agent:implement" } },
    { id: "8", event: "unlabeled", created_at: new Date(start + 1000).toISOString(), actor: { login: "deadloop-bot" }, label: { name: "agent:implement" } },
    { id: "9", event: "labeled", created_at: new Date(start + 2000).toISOString(), actor: { login: "deadloop-bot" }, label: { name: "agent:in-progress" } },
  ];
  const labels = new Set(["agent:in-progress"]);
  const comments: any[] = [];
  let next = 10;
  return {
    events, labels, comments,
    listIssueLabels: () => [...labels].map((name) => ({ name })),
    listIssueTimelineEvents: () => events,
    listIssueComments: () => comments,
    addIssueLabel: (_r: string, _n: number, label: string) => {
      labels.add(label);
      events.push({ id: String(next += 1), event: "labeled", created_at: new Date(start + next * 1000).toISOString(), actor: { login: "deadloop-bot" }, label: { name: label } });
    },
    deleteIssueLabel: (_r: string, _n: number, label: string) => {
      labels.delete(label);
      events.push({ id: String(next += 1), event: "unlabeled", created_at: new Date(start + next * 1000).toISOString(), actor: { login: "deadloop-bot" }, label: { name: label } });
      return { status: 200 };
    },
    commentIssue: (_r: string, _n: number, body: string) => {
      comments.push({ body, user: { login: "deadloop-bot" }, created_at: new Date(start + (++next) * 1000).toISOString(), updated_at: new Date(start + next * 1000).toISOString() });
    },
  };
}

function stopDamagedEvidence() {
  const data = setup();
  fs.writeFileSync(data.promiseFile, "not json", "utf8");
  const timeline = issueTimeline();
  const result = reconcileReportReceivedLocked(data.args, undefined, { automationLogin: "deadloop-bot" }, () => {}, {
    observeDirective: () => stoppedRuntimeDirective("missing_report", { reason: "invalid_completion_report" }),
    github: timeline,
  });
  return { data, timeline, result };
}

describe("report_received attempt reconciliation", () => {
  it("retains the attempt while the execution runtime still reports active work", () => {
    const data = setup();
    const result = reconcileReportReceivedLocked(data.args, undefined, { automationLogin: "deadloop-bot" }, () => {}, {
      observeDirective: () => ({ runtime: { kind: "working" }, directive: { action: "working", accounting: {} } }),
    });
    expect(result.driverAction).toBe("recovery_retained");
  });

  it("persists the bound completion report once the execution runtime stops reporting active work", () => {
    const data = setup();
    const result = reconcileReportReceivedLocked(data.args, undefined, { automationLogin: "deadloop-bot" }, () => {}, {
      observeDirective: () => stoppedRuntimeDirective("completion"),
      runCompletion: () => ({ applied: true, result: "issue_attempt_completed" }),
    });
    expect(result.driverAction).toBe("report_received_persisted");
  });

  it("binds the completion handoff to this attempt's journal, branch, and Issue", () => {
    const data = setup();
    let captured: Record<string, any> | undefined;
    reconcileReportReceivedLocked(data.args, undefined, { automationLogin: "deadloop-bot" }, () => {}, {
      observeDirective: () => stoppedRuntimeDirective("completion"),
      runCompletion: (handoff: Record<string, any>) => { captured = handoff; return { applied: true }; },
    });
    expect({
      kind: captured?.kind,
      attemptRecordFile: captured?.input?.attemptRecordFile,
      branch: captured?.input?.branch,
      issueNumber: captured?.input?.issueNumber,
      requestEventId: captured?.input?.requestEventId,
    }).toEqual({ kind: "issue", attemptRecordFile: data.args.attemptRecord, branch: "agent/issue-12", issueNumber: 12, requestEventId: "request-7" });
  });

  it("keeps the attempt pending when the deterministic completion chain cannot finish", () => {
    const data = setup();
    const result = reconcileReportReceivedLocked(data.args, undefined, { automationLogin: "deadloop-bot" }, () => {}, {
      observeDirective: () => stoppedRuntimeDirective("completion"),
      runCompletion: () => ({ applied: false, retain: true, result: "required_verification_failed", error: "npm test failed" }),
    });
    expect(result.driverAction).toBe("report_received_completion_pending");
  });

  it("releases the journal authority when the completion report no longer proves its binding", () => {
    const stop = stopDamagedEvidence();
    expect(readAttemptRecord(stop.data.runDir).phase).toBe("authority_released");
  });

  it("replaces the dangling claim with exactly the terminal blocked state", () => {
    const stop = stopDamagedEvidence();
    expect([...stop.timeline.labels].sort()).toEqual(["agent:blocked"]);
  });

  it("names the manual recovery steps in its single stop explanation", () => {
    const stop = stopDamagedEvidence();
    expect(stop.timeline.comments[0]?.body).toContain('add "agent:implement" again');
  });

  it("never overwrites a newer live attempt that owns the same checkout", () => {
    const data = setup();
    const newerRunDir = path.join(path.dirname(data.runDir), "launch-2");
    createPreparedAttempt(newerRunDir, {
      attemptId: "launch-2", launchUuid: "launch-2", project: "demo", repository: "octo/demo", role: "worker",
      target: { kind: "issue", number: 12 }, inputRevision: { head: HEAD },
      branch: "agent/issue-12-b", worktreePath: data.projectRoot && path.join(data.projectRoot, "worktree"),
      agentName: "dl-w-12-aaaa11112222", workspaceLabel: "Issue 12 again",
      promptFile: path.join(newerRunDir, "prompt.md"), promiseFile: path.join(newerRunDir, "promise.json"),
    });
    transitionPersistedAttempt(newerRunDir, "github_claimed");
    transitionPersistedAttempt(newerRunDir, "workspace_opened");
    const result = reconcileReportReceivedLocked(data.args, undefined, { automationLogin: "deadloop-bot" }, () => {}, {
      observeDirective: () => stoppedRuntimeDirective("completion"),
      runCompletion: () => ({ applied: true, result: "issue_attempt_completed" }),
    });
    expect(result.driverAction).toBe("recovery_retained_newer_owner");
  });

  it("is idempotent for a journal that already left report_received", () => {
    const data = setup();
    transitionPersistedAttempt(data.runDir, "github_persisted");
    const result = reconcileReportReceivedLocked(data.args, undefined, { automationLogin: "deadloop-bot" }, () => {}, {
      observeDirective: () => stoppedRuntimeDirective("completion"),
      runCompletion: () => ({ applied: true }),
    });
    expect(result.driverAction).toBe("recovery_not_applicable");
  });
});
