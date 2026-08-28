import { describe, expect, it } from "vitest";

import {
  deliverPendingDriverHandoff,
  isPendingIssueHandoffEligible,
  runScheduledAutomation,
} from "../src/automation-runner";
import type { AttemptMonitoringDirective } from "../src/monitor-handoff-types";
import { normalizeProject, type AutomationFileResolution } from "../src/core";

function foundFile(requested: string | undefined): AutomationFileResolution {
  const name = requested || "";
  return { requested: name, resolved: name, found: name.length > 0 };
}

function executionSupply() {
  return { codeIdentity: "a".repeat(40), lockHash: "b".repeat(64), packageRoot: "/snapshot", automationDir: "/snapshot/automations", dependencyRoot: "/dependencies" };
}

function branchUpdateMonitorHandoff() {
  return {
    kind: "branch-update",
    input: {
      automationDir: "/automation",
      promiseFile: "/runs/one/promise.json",
      attemptRecordFile: "/runs/one/attempt.json",
      actorName: "branch-update worker",
      projectId: "demo",
      repoPath: "/repo",
      githubRepo: "owner/repo",
      stateDir: "/state",
      enabledAt: 1,
      prNumber: 12,
      expectedHeadOid: "a".repeat(40),
      expectedBaseOid: "b".repeat(40),
      branch: "feature",
      reviewLabel: "agent:review",
      implementLabel: "agent:implement",
      updateBranchLabel: "agent:update-branch",
      inProgressLabel: "agent:in-progress",
      blockedLabel: "agent:blocked",
    },
  };
}

function monitorDeliveryFixture(kind = "explorer") {
  const handoff = branchUpdateMonitorHandoff();
  handoff.kind = kind;
  const entry: Record<string, unknown> = {
    pendingDriverHandoff: {
      action: "monitor",
      monitorHandoff: handoff,
      monitorAccounting: { activeMilliseconds: 0, observedAt: new Date(0).toISOString(), runtimeWasWorking: true },
    },
  };
  const state = { automations: { auto: entry } };
  const sent: string[] = [];
  const applied: string[] = [];
  let now = 0;
  let directive: AttemptMonitoringDirective | null = { action: "working", accounting: { activeMilliseconds: 0, observedAt: new Date(0).toISOString(), runtimeWasWorking: true } };
  return {
    entry,
    state,
    sent,
    applied,
    deps: {
      enabledAt: () => 1,
      isEnabled: () => true,
      observeAttemptMonitoring: () => directive,
      applyAttemptMonitoring: (_handoff: Record<string, unknown>, observed: Exclude<AttemptMonitoringDirective, { action: "working" | "ambiguity" | "settled" }>) => {
        applied.push(observed.action === "missing_report" ? observed.reason : observed.action);
        // A model-availability wait keeps the handoff; every stop releases it after one apply.
        return { applied: true, retain: observed.action === "missing_report" && observed.reason === "model_availability" };
      },
      retryModelWait: () => true,
      now: () => now,
      saveState: () => undefined,
      sendUserMessage: (prompt: string) => sent.push(prompt),
    },
    setNow: (value: number) => { now = value; },
    setDisposition: (value: AttemptMonitoringDirective | null) => { directive = value; },
  };
}

async function exerciseDriver(
  stdout: string,
  options: {
    code?: number;
    stderr?: string;
    initialEntry?: Record<string, unknown>;
    isEnabled?: () => boolean;
    enabledAt?: () => number;
    observeAttemptMonitoring?: Parameters<typeof deliverPendingDriverHandoff>[3]["observeAttemptMonitoring"];
    runDriver?: () => void;
    runPrecheck?: () => void;
    sendUserMessageIfEnabled?: (prompt: string) => boolean;
  } = {},
) {
  const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",
    id: "demo",
    automations: [
      { id: "demo:auto", name: "auto", precheckFile: "precheck.sh", promptFile: "full.md", driverFile: "driver.py" },
    ],
  });
  const state = {
    automations: options.initialEntry ? { "demo:demo:auto": { ...options.initialEntry } } : {},
  };
  const sent: string[] = [];

  await runScheduledAutomation(project, project.automations[0], 123, state, {
    isEnabled: options.isEnabled,
    enabledAt: options.enabledAt,
    observeAttemptMonitoring: options.observeAttemptMonitoring,
    isIdle: () => true,
    notify: () => undefined,
    now: () => 456,
    prepareExecutionSupply: executionSupply,
    readPrompt: () => "full prompt",
    resolveAutomationFileInDir: (_kind, _automation, requested) => foundFile(requested),
    runDriver: async () => {
      options.runDriver?.();
      return { code: options.code ?? 0, stdout, stderr: options.stderr ?? "" };
    },
    runPrecheck: async () => {
      options.runPrecheck?.();
      return { code: 0, stdout: "", stderr: "" };
    },
    saveState: () => undefined,
    sendUserMessage: (prompt) => sent.push(prompt),
    sendUserMessageIfEnabled: options.sendUserMessageIfEnabled,
    setStatus: () => undefined,
  });

  return { sent, entry: state.automations["demo:demo:auto"] };
}

describe("deterministic automation driver runner", () => {
  it("clears the current driver error after a monitored launch registers", async () => {
    const result = await exerciseDriver(
      JSON.stringify({ action: "monitor", summary: "recovered", monitorHandoff: { kind: "reviewer", input: { enabledAt: 456 } } }),
      { initialEntry: { lastResult: "driver_error", failureStreak: 8, lastError: "agent_name_taken" } },
    );

    expect({
      failureStreak: result.entry.failureStreak,
      lastError: result.entry.lastError,
      lastResult: result.entry.lastResult,
    }).toEqual({ failureStreak: 0, lastError: undefined, lastResult: "driver_handoff_revalidation_required" });
  });

  it("records the skip driver result", async () => {
    const result = await exerciseDriver(JSON.stringify({ action: "skip", summary: "対象なし" }));

    expect(result.entry.lastResult).toBe("driver_skip");
  });

  it("records the done driver summary", async () => {
    const result = await exerciseDriver(JSON.stringify({ action: "done", summary: "cleanup complete" }));

    expect(result.entry.lastSummary).toBe("cleanup complete");
  });

  it("records invalid driver JSON", async () => {
    const result = await exerciseDriver("not json");

    expect(result.entry.lastResult).toBe("driver_invalid_json");
  });

  it("records a non-zero driver exit", async () => {
    const result = await exerciseDriver("", { code: 2, stderr: "boom" });

    expect(result.entry.lastError).toBe("boom");
  });

  it("records a driver error action", async () => {
    const result = await exerciseDriver(JSON.stringify({ action: "error", error: "operator attention required" }));

    expect(result.entry.lastError).toBe("operator attention required");
  });

  it("does not dispatch a driver after enablement is removed during precheck", async () => {
    let enabled = true;
    const result = await exerciseDriver(JSON.stringify({ action: "done", summary: "cleanup complete" }), {
      isEnabled: () => enabled,
      runPrecheck: () => { enabled = false; },
    });

    expect(result.sent).toEqual([]);
  });

  it("does not start a side-effecting driver when enablement changes after the post-precheck gate", async () => {
    let checks = 0;
    let driverStarted = false;
    await exerciseDriver(JSON.stringify({ action: "done", summary: "cleanup complete" }), {
      isEnabled: () => ++checks === 1,
      runDriver: () => { driverStarted = true; },
    });

    expect(driverStarted).toBe(false);
  });

  it("retains the registered monitor across an enablement removal during driver execution", async () => {
    let enabled = true;
    const result = await exerciseDriver(
      JSON.stringify({ action: "monitor", summary: "launched", monitorHandoff: { kind: "reviewer", input: { enabledAt: 456 } } }),
      {
        isEnabled: () => enabled,
        enabledAt: () => 456,
        observeAttemptMonitoring: () => ({ action: "working", accounting: { activeMilliseconds: 0, observedAt: new Date(456).toISOString(), runtimeWasWorking: true } }),
        runDriver: () => { enabled = false; },
      },
    );

    expect({
      pending: (result.entry.pendingDriverHandoff as Record<string, any>)?.monitorHandoff?.kind,
      sent: result.sent,
    }).toEqual({ pending: "reviewer", sent: [] });
  });

  it("reports a stored prompt-only handoff as unsupported and never redelivers it", () => {
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: { action: "needs_llm", prompt: "driver prompt", launch: { promiseFile: "/runs/1/promise.json" } },
    };
    const state = { automations: { auto: entry } };

    deliverPendingDriverHandoff(entry, state, "auto", {
      isEnabled: () => true,
      now: () => 456,
      saveState: () => undefined,
    });

    expect({
      pending: entry.pendingDriverHandoff,
      lastError: entry.lastError as string,
    }).toEqual({
      pending: undefined,
      lastError: "retained prompt handoff is unsupported; attempt monitoring is deterministic only",
    });
  });

  it("observes reviewer attempts without sending an Automation-host model message", () => {
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "monitor",
        monitorHandoff: { kind: "reviewer", input: { enabledAt: 1 } },
        monitorAccounting: { activeMilliseconds: 0, observedAt: "1970-01-01T00:00:00.000Z", runtimeWasWorking: false },
      },
    };
    const state = { automations: { auto: entry } };
    let observed = 0;

    deliverPendingDriverHandoff(entry, state, "auto", {
      enabledAt: () => 1,
      isEnabled: () => true,
      now: () => 60_000,
      observeAttemptMonitoring: (_handoff, accounting) => {
        observed += 1;
        return { action: "working", accounting: { ...accounting, observedAt: "1970-01-01T00:01:00.000Z", runtimeWasWorking: true } };
      },
      applyAttemptMonitoring: () => ({ applied: false }),
      saveState: () => undefined,
    });

    expect(observed).toBe(1);
  });

  const CHILD_SUMMARY = "registered worktree is not an existing canonical path: /tmp/pi-worktree-5d624d9c-0";

  function completionMonitorEntry(): { entry: Record<string, unknown>; state: { automations: Record<string, Record<string, unknown>> } } {
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "monitor",
        monitorHandoff: { kind: "branch-update", input: { enabledAt: 1 } },
        monitorAccounting: { activeMilliseconds: 0, observedAt: new Date(0).toISOString(), runtimeWasWorking: false },
      },
    };
    return { entry, state: { automations: { auto: entry } } };
  }

  function completionMonitorDeps(application: () => unknown) {
    return {
      enabledAt: () => 1,
      isEnabled: () => true,
      now: () => 60_000,
      observeAttemptMonitoring: () => ({
        action: "completion",
        accounting: { activeMilliseconds: 0, observedAt: new Date(0).toISOString(), runtimeWasWorking: false },
        report: {},
      }) as AttemptMonitoringDirective,
      applyAttemptMonitoring: application as never,
      saveState: () => undefined,
    };
  }

  it("surfaces a child-script summary as lastError when a deterministic completion fails", () => {
    const { entry, state } = completionMonitorEntry();
    deliverPendingDriverHandoff(entry, state, "auto", completionMonitorDeps(() => ({
      applied: false,
      result: { driverAction: "branch_update_stale_head", summary: CHILD_SUMMARY },
    })));

    expect(entry.lastError).toBe(CHILD_SUMMARY);
  });

  it("surfaces a child-script summary as the host-log reason when a deterministic completion fails", () => {
    const { entry, state } = completionMonitorEntry();
    deliverPendingDriverHandoff(entry, state, "auto", completionMonitorDeps(() => ({
      applied: false,
      result: { driverAction: "branch_update_stale_head", summary: CHILD_SUMMARY },
    })));

    expect(entry.lastSummary).toBe(CHILD_SUMMARY);
  });

  it("surfaces a thrown child-script error as lastError when a deterministic completion fails", () => {
    const { entry, state } = completionMonitorEntry();
    deliverPendingDriverHandoff(entry, state, "auto", completionMonitorDeps(() => ({ applied: false, error: CHILD_SUMMARY })));

    expect(entry.lastError).toBe(CHILD_SUMMARY);
  });

  it("surfaces a string completion result as lastError when the deterministic completion fails", () => {
    const { entry, state } = completionMonitorEntry();
    deliverPendingDriverHandoff(entry, state, "auto", completionMonitorDeps(() => ({ applied: false, result: "ci_fallback_gate_stopped" })));

    expect(entry.lastError).toBe("ci_fallback_gate_stopped");
  });

  it("keeps lastError empty for a failed deterministic completion without a readable reason", () => {
    const { entry, state } = completionMonitorEntry();
    deliverPendingDriverHandoff(entry, state, "auto", completionMonitorDeps(() => ({ applied: false })));

    expect(entry.lastError).toBeUndefined();
  });

  it("clears lastError in the tick where the deterministic completion finally succeeds", () => {
    const { entry, state } = completionMonitorEntry();
    let application: Record<string, unknown> = { applied: false, result: { summary: CHILD_SUMMARY } };
    const deps = completionMonitorDeps(() => application);
    deliverPendingDriverHandoff(entry, state, "auto", deps);
    application = { applied: true, result: "review_completion_retained" };
    deliverPendingDriverHandoff(entry, state, "auto", deps);

    expect(entry.lastError).toBeUndefined();
  });

  it("persists paused active-work accounting across deterministic monitor ticks", () => {
    const payload: Record<string, any> = {
      action: "monitor",
      monitorHandoff: { kind: "reviewer", input: { enabledAt: 1 } },
      monitorAccounting: { activeMilliseconds: 0, observedAt: "1970-01-01T00:00:00.000Z", runtimeWasWorking: true },
    };
    const entry: Record<string, unknown> = { pendingDriverHandoff: payload };
    const state = { automations: { auto: entry } };
    let now = 60_000;
    let observedAccounting: Record<string, unknown> = {};

    const deps = {
      enabledAt: () => 1,
      isEnabled: () => true,
      now: () => now,
      observeAttemptMonitoring: (_handoff: Record<string, unknown>, accounting: any) => {
        observedAccounting = accounting;
        return now === 60_000
          ? { action: "missing_report" as const, accounting: { activeMilliseconds: 60_000, observedAt: "1970-01-01T00:01:00.000Z", runtimeWasWorking: false }, reason: "model_availability" as const }
          : { action: "working" as const, accounting: { activeMilliseconds: accounting.activeMilliseconds, observedAt: "1970-01-01T00:02:00.000Z", runtimeWasWorking: true } };
      },
      applyAttemptMonitoring: () => ({ applied: true, retain: true }),
      saveState: () => undefined,
      sendUserMessage: () => undefined,
    };
    deliverPendingDriverHandoff(entry, state, "auto", deps);
    now = 120_000;
    deliverPendingDriverHandoff(entry, state, "auto", deps);

    expect(observedAccounting).toMatchObject({ activeMilliseconds: 60_000, runtimeWasWorking: false });
  });

  it("retains a monitored attempt while the shared directive reports working", () => {
    const fixture = monitorDeliveryFixture("explorer");

    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);

    expect(fixture.entry.pendingDriverHandoff).toMatchObject({
      monitorHandoff: { kind: "explorer" },
    });
  });

  it("clears a monitored attempt after the directive settles", () => {
    const fixture = monitorDeliveryFixture("explorer");

    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    fixture.setDisposition({ action: "settled", accounting: { activeMilliseconds: 0, observedAt: new Date(0).toISOString(), runtimeWasWorking: false } });
    fixture.setNow(60_000);
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);

    expect(fixture.entry.pendingDriverHandoff).toBeUndefined();
  });

  it.each(["reviewer", "branch-update", "repair", "issue", "explorer"])(
    "never redelivers a terminal %s handoff without a report",
    (kind) => {
      const fixture = monitorDeliveryFixture(kind);
      deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
      fixture.setDisposition({
        action: "missing_report",
        accounting: { activeMilliseconds: 0, observedAt: new Date(0).toISOString(), runtimeWasWorking: false },
        reason: "terminal_without_report",
      } as never);

      for (let tick = 1; tick <= 500; tick += 1) {
        fixture.setNow(tick * 60_000);
        deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
      }

      expect({ sent: fixture.sent, applied: fixture.applied, pending: fixture.entry.pendingDriverHandoff }).toEqual({
        sent: [],
        applied: ["terminal_without_report"],
        pending: undefined,
      });
    },
  );

  it("applies a terminal stop once", () => {
    const fixture = monitorDeliveryFixture("explorer");
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    fixture.setDisposition({
      action: "timeout",
      accounting: { activeMilliseconds: 86_400_000, observedAt: new Date(0).toISOString(), runtimeWasWorking: true },
      reason: "active_work_limit",
    } as never);

    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);

    expect(fixture.applied).toEqual(["timeout"]);
  });

  it("preserves ambiguous runtime evidence without applying a stop", () => {
    const fixture = monitorDeliveryFixture("explorer");
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    fixture.setDisposition({
      action: "ambiguity",
      accounting: { activeMilliseconds: 0, observedAt: new Date(0).toISOString(), runtimeWasWorking: false },
      reason: "runtime_ambiguous",
    });

    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);

    expect({ applied: fixture.applied, pending: fixture.entry.pendingDriverHandoff !== undefined }).toEqual({
      applied: [],
      pending: true,
    });
  });

  it("retains one handoff while waiting for model availability", () => {
    const fixture = monitorDeliveryFixture("explorer");
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    fixture.setDisposition({
      action: "missing_report",
      accounting: { activeMilliseconds: 0, observedAt: new Date(0).toISOString(), runtimeWasWorking: false },
      reason: "model_availability",
    });

    for (let tick = 1; tick <= 500; tick += 1) {
      fixture.setNow(tick * 60_000);
      deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    }

    expect(fixture.entry.pendingDriverHandoff).toBeDefined();
  });
  it("posts the model availability transition once", () => {
    const fixture = monitorDeliveryFixture("explorer");
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    fixture.setDisposition({
      action: "missing_report",
      accounting: { activeMilliseconds: 0, observedAt: new Date(0).toISOString(), runtimeWasWorking: false },
      reason: "model_availability",
    });

    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);

    expect(fixture.applied).toEqual(["model_availability"]);
  });

  it.each(["reviewer", "branch-update", "repair"])("discards a pre-disable %s monitor handoff for deterministic re-evaluation", (kind) => {
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "monitor",
        monitorHandoff: { kind, input: { enabledAt: 1 } },
      },
    };
    const state = { automations: { auto: entry } };

    deliverPendingDriverHandoff(entry, state, "auto", {
      enabledAt: () => 2,
      isEnabled: () => true,
      now: () => 456,
      saveState: () => undefined,
    });

    expect({ result: entry.lastResult, pending: entry.pendingDriverHandoff }).toEqual({
      result: "driver_handoff_revalidation_required",
      pending: undefined,
    });
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["nonnumeric", "invalid"],
  ])("discards a monitor handoff with a %s persisted generation", (_description, enabledAt) => {
    const input = enabledAt === undefined ? {} : { enabledAt };
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "monitor",
        monitorHandoff: { kind: "reviewer", input },
      },
    };
    const state = { automations: { auto: entry } };

    deliverPendingDriverHandoff(entry, state, "auto", {
      enabledAt: () => 2,
      isEnabled: () => true,
      now: () => 456,
      saveState: () => undefined,
    });

    expect(entry.lastResult).toBe("driver_handoff_revalidation_required");
  });

  const issueHandoff = {
    kind: "issue",
    input: {
      issueNumber: 12,
      issueTitle: "Implement feature",
      issueBody: "## Acceptance criteria\n- Done",
      readyLabel: "ready-for-agent",
      inProgressLabel: "agent:in-progress",
      blockedLabel: "agent:blocked",
      humanLabel: "ready-for-human",
      needsInfoLabel: "needs-info",
      wontfixLabel: "wontfix",
    },
  };
  const eligibleIssue = {
    number: 12,
    title: "Implement feature",
    body: "## Acceptance criteria\n- Done",
    state: "OPEN",
    labels: [{ name: "ready-for-agent" }, { name: "agent:in-progress" }],
  };

  it("rejects a closed issue during pending handoff revalidation", () => {
    expect(isPendingIssueHandoffEligible(issueHandoff, { ...eligibleIssue, state: "CLOSED" })).toBe(false);
  });

  it("rejects an issue missing a required label during pending handoff revalidation", () => {
    expect(isPendingIssueHandoffEligible(issueHandoff, { ...eligibleIssue, labels: [{ name: "agent:in-progress" }] })).toBe(false);
  });

  it.each(["agent:blocked", "needs-info", "ready-for-human", "wontfix"])(
    "rejects an issue with the %s blocking label during pending handoff revalidation",
    (blockingLabel) => {
      expect(isPendingIssueHandoffEligible(issueHandoff, {
        ...eligibleIssue,
        labels: [...eligibleIssue.labels, { name: blockingLabel }],
      })).toBe(false);
    },
  );

  it("rejects an issue whose title changed during pending handoff revalidation", () => {
    expect(isPendingIssueHandoffEligible(issueHandoff, { ...eligibleIssue, title: "Different feature" })).toBe(false);
  });

  it("rejects an issue whose body changed during pending handoff revalidation", () => {
    expect(isPendingIssueHandoffEligible(issueHandoff, { ...eligibleIssue, body: "Different contract" })).toBe(false);
  });

  it("accepts the same open in-progress issue during pending handoff revalidation", () => {
    expect(isPendingIssueHandoffEligible(issueHandoff, eligibleIssue)).toBe(true);
  });

  it("discards a pre-disable issue handoff when current eligibility cannot be confirmed", () => {
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "monitor",
        monitorHandoff: { kind: "issue", input: { enabledAt: 1 } },
      },
    };
    const state = { automations: { auto: entry } };

    deliverPendingDriverHandoff(entry, state, "auto", {
      enabledAt: () => 2,
      isEnabled: () => true,
      now: () => 456,
      saveState: () => undefined,
    });

    expect(entry.lastResult).toBe("driver_handoff_revalidation_required");
  });

  it("continues deterministic monitoring for a revalidated pre-disable issue handoff without a host-model prompt", () => {
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "monitor",
        monitorHandoff: { kind: "issue", input: { enabledAt: 1, promiseFile: "/runs/one/promise.json", reviewLabel: "custom:review" } },
      },
    };
    const state = { automations: { auto: entry } };
    const observed: string[] = [];

    deliverPendingDriverHandoff(entry, state, "auto", {
      enabledAt: () => 2,
      isEnabled: () => true,
      now: () => 456,
      revalidatePendingDriverHandoff: () => true,
      observeAttemptMonitoring: () => {
        observed.push("observe");
        return {
          action: "working" as const,
          accounting: { activeMilliseconds: 0, observedAt: new Date(456).toISOString(), runtimeWasWorking: true },
        };
      },
      saveState: () => undefined,
    });

    expect({ observed, lastResult: entry.lastResult, pending: entry.pendingDriverHandoff !== undefined }).toEqual({
      observed: ["observe"],
      lastResult: "driver_attempt_working",
      pending: true,
    });
  });

  it("does not dispatch a prompt when disable wins the enqueue lock", async () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",
      id: "demo",
      automations: [{ id: "demo:auto", name: "auto", precheckFile: "precheck.sh", promptFile: "full.md" }],
    });
    const state = { automations: {} };
    const sent: string[] = [];

    await runScheduledAutomation(project, project.automations[0], 123, state, {
      isEnabled: () => true,
      now: () => 456,
      prepareExecutionSupply: executionSupply,
      readPrompt: () => "full prompt",
      resolveAutomationFileInDir: (_kind, _automation, requested) => foundFile(requested),
      runDriver: async () => ({ code: 99, stdout: "should not run", stderr: "" }),
      runPrecheck: async () => ({ code: 0, stdout: "", stderr: "" }),
      saveState: () => undefined,
      sendUserMessage: (prompt) => sent.push(prompt),
      sendUserMessageIfEnabled: () => false,
    });

    expect(sent).toEqual([]);
  });

  it("does not start precheck when execution supply cannot be fixed", async () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",
      id: "demo",
      automations: [{ id: "demo:auto", name: "auto", precheckFile: "precheck.sh", promptFile: "full.md" }],
    });
    let precheckStarted = false;

    let message = "";
    try {
      await runScheduledAutomation(project, project.automations[0], 123, { automations: {} }, {
        now: () => 456,
        prepareExecutionSupply: () => { throw new Error("dependency snapshot unavailable"); },
        readPrompt: () => "full prompt",
        resolveAutomationFileInDir: (_kind, _automation, requested) => foundFile(requested),
        runDriver: async () => ({ code: 0 }),
        runPrecheck: async () => { precheckStarted = true; return { code: 0 }; },
        saveState: () => undefined,
        sendUserMessage: () => undefined,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect({ message, precheckStarted }).toEqual({ message: "dependency snapshot unavailable", precheckStarted: false });
  });

  it("does not dispatch a prompt after enablement is removed during precheck", async () => {
    const project = normalizeProject({ workerModel: "test-model", reviewerModel: "review-model",
      id: "demo",
      automations: [{ id: "demo:auto", name: "auto", precheckFile: "precheck.sh", promptFile: "full.md" }],
    });
    const state = { automations: {} };
    const sent: string[] = [];
    let enabled = true;

    await runScheduledAutomation(project, project.automations[0], 123, state, {
      isEnabled: () => enabled,
      now: () => 456,
      prepareExecutionSupply: executionSupply,
      readPrompt: () => "full prompt",
      resolveAutomationFileInDir: (_kind, _automation, requested) => foundFile(requested),
      runDriver: async () => ({ code: 99, stdout: "should not run", stderr: "" }),
      runPrecheck: async () => {
        enabled = false;
        return { code: 0, stdout: "", stderr: "" };
      },
      saveState: () => undefined,
      sendUserMessage: (prompt) => sent.push(prompt),
    });

    expect(sent).toEqual([]);
  });
});

describe("model availability waiting in deterministic attempt monitoring", () => {
  const accounting = { activeMilliseconds: 60_000, observedAt: "1970-01-01T00:01:00.000Z", runtimeWasWorking: false };

  function modelWaitFixture(kind = "reviewer") {
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "monitor",
        monitorHandoff: { kind, input: { enabledAt: 1 } },
        monitorAccounting: accounting,
      },
    };
    const state = { automations: { auto: entry } };
    const sent: string[] = [];
    const applied: Array<Record<string, any>> = [];
    const retries: Array<Record<string, unknown>> = [];
    const hostLogEvents: Array<Record<string, unknown>> = [];
    let enabled = true;
    let reusable = true;
    let directive: AttemptMonitoringDirective | undefined;
    let application: Record<string, any> | ((_handoff: Record<string, unknown>, observed: Record<string, any>) => Record<string, unknown>) = { applied: true, retain: true };
    let now = Date.parse("2026-08-21T00:00:00.000Z");
    const deps = {
      enabledAt: () => 1,
      isEnabled: () => enabled,
      notify: () => undefined,
      now: () => now,
      observeAttemptMonitoring: () => directive ?? null,
      applyAttemptMonitoring: (handoff: Record<string, unknown>, observed: Record<string, any>) => {
        applied.push(observed);
        return typeof application === "function" ? application(handoff, observed) : application;
      },
      retryModelWait: (handoff: Record<string, unknown>) => {
        retries.push(handoff);
        return reusable;
      },
      saveState: () => undefined,
      sendUserMessage: (prompt: string) => sent.push(prompt),
      emitHostLog: (event) => hostLogEvents.push(event as Record<string, unknown>),
    };
    const tick = (logContext?: Record<string, string>) => deliverPendingDriverHandoff(entry, state, "auto", deps, logContext as never);
    return {
      applied, deps, entry, retries, sent, hostLogEvents, tick,
      payload: () => entry.pendingDriverHandoff as Record<string, any>,
      setApplication: (value: typeof application) => { application = value; },
      setDirective: (value: AttemptMonitoringDirective) => { directive = value; },
      setEnabled: (value: boolean) => { enabled = value; },
      setNow: (value: number) => { now = value; },
      setReusable: (value: boolean) => { reusable = value; },
    };
  }

  function rejectionDirective(providerRetryAt: string | null, activeMilliseconds = 60_000): AttemptMonitoringDirective {
    return {
      action: "missing_report" as const,
      accounting: { ...accounting, activeMilliseconds },
      reason: "model_availability" as const,
      providerRetryAt,
    };
  }

  it("records a waiting_for_model wait on the first terminal known billing rejection", () => {
    const fixture = modelWaitFixture();
    fixture.setDirective(rejectionDirective(null));

    fixture.tick();

    expect({
      result: fixture.entry.lastResult,
      summary: fixture.entry.lastSummary,
      wait: fixture.payload().modelWait,
      retained: fixture.entry.pendingDriverHandoff !== undefined,
    }).toEqual({
      result: "driver_monitor_waiting_for_model",
      summary: "waiting for model availability",
      wait: { startedAt: "2026-08-21T00:00:00.000Z", nextRetryAt: null },
      retained: true,
    });
  });

  it("logs each model-wait transition observationally with its automation identity", () => {
    const fixture = modelWaitFixture();
    fixture.setDirective(rejectionDirective(null));

    fixture.tick({ projectId: "demo", automationId: "demo:ticker" });
    const established = fixture.hostLogEvents[0];
    expect(established).toMatchObject({
      kind: "model_wait_transitioned",
      projectId: "demo",
      automationId: "demo:ticker",
      result: "driver_monitor_waiting_for_model",
      reason: "waiting for model availability",
    });

    fixture.setNow(Date.parse("2026-08-21T00:10:00.000Z"));
    fixture.tick({ projectId: "demo", automationId: "demo:ticker" });
    expect(fixture.hostLogEvents[1]).toMatchObject({
      kind: "model_wait_transitioned",
      result: "driver_monitor_model_retry",
      reason: "model availability retry sent",
    });
  });

  it("keeps the tick outcome intact when the host log sink throws during a model-wait transition", () => {
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "monitor",
        monitorHandoff: { kind: "reviewer", input: { enabledAt: 1 } },
        monitorAccounting: accounting,
      },
    };
    const state = { automations: { auto: entry } };
    deliverPendingDriverHandoff(entry, state, "auto", {
      enabledAt: () => 1,
      isEnabled: () => true,
      notify: () => undefined,
      now: () => Date.parse("2026-08-21T00:00:00.000Z"),
      observeAttemptMonitoring: () => rejectionDirective(null),
      applyAttemptMonitoring: () => ({ applied: true, retain: true }),
      saveState: () => undefined,
      emitHostLog: () => { throw new Error("log write exploded"); },
    });
    expect(entry.lastResult).toBe("driver_monitor_waiting_for_model");
  });

  it("posts the model availability explanation once while waiting holds", () => {
    const fixture = modelWaitFixture();
    fixture.setDirective(rejectionDirective("2026-08-21T01:00:00.000Z"));

    fixture.setNow(Date.parse("2026-08-21T00:00:00.000Z"));
    fixture.tick();
    fixture.setNow(Date.parse("2026-08-21T00:10:00.000Z"));
    fixture.tick();
    fixture.setNow(Date.parse("2026-08-21T00:20:00.000Z"));
    fixture.tick();

    expect(fixture.applied).toHaveLength(1);
  });

  it("honors provider retry timing before firing the retry mutation", () => {
    const fixture = modelWaitFixture();
    fixture.setDirective(rejectionDirective("2026-08-21T01:00:00.000Z"));

    fixture.tick();
    fixture.setNow(Date.parse("2026-08-21T00:59:59.999Z"));
    fixture.tick();
    const beforeDue = fixture.retries.length;
    fixture.setNow(Date.parse("2026-08-21T01:00:00.000Z"));
    fixture.setDirective({ action: "working", accounting: { ...accounting, runtimeWasWorking: true } });
    fixture.setDirective(rejectionDirective("2026-08-21T01:00:00.000Z"));
    fixture.tick();

    expect({ beforeDue, afterDue: fixture.retries.length }).toEqual({ beforeDue: 0, afterDue: 1 });
  });

  it("uses the normal next scheduler tick as the only retry trigger without provider timing", () => {
    const fixture = modelWaitFixture();
    fixture.setDirective(rejectionDirective(null));

    fixture.tick();
    const atEnter = fixture.retries.length;
    fixture.setNow(Date.parse("2026-08-21T00:10:00.000Z"));
    fixture.tick();

    expect({ atEnter, atNextTick: fixture.retries.length }).toEqual({ atEnter: 0, atNextTick: 1 });
  });

  it("stops through the ordinary deterministic path when the same session cannot be reused", () => {
    const fixture = modelWaitFixture();
    fixture.setDirective(rejectionDirective(null));
    fixture.setReusable(false);
    fixture.setApplication((_handoff, observed) => {
      if (observed.reason === "terminal_without_report") return { applied: true, retain: false };
      return { applied: true, retain: true };
    });

    fixture.tick();
    fixture.setNow(Date.parse("2026-08-21T00:10:00.000Z"));
    fixture.tick();

    expect({
      stopReasons: fixture.applied.map((observed) => observed.reason),
      pendingCleared: fixture.entry.pendingDriverHandoff === undefined,
    }).toEqual({ stopReasons: ["model_availability", "terminal_without_report"], pendingCleared: true });
  });

  it("starts no retry mutation when the repository is disabled", () => {
    const fixture = modelWaitFixture();
    fixture.setDirective(rejectionDirective(null));

    fixture.tick();
    fixture.setEnabled(false);
    fixture.setNow(Date.parse("2026-08-21T00:10:00.000Z"));
    fixture.tick();

    expect({
      retries: fixture.retries.length,
      result: fixture.entry.lastResult,
      retained: fixture.entry.pendingDriverHandoff !== undefined,
    }).toEqual({ retries: 0, result: "disabled_before_model_retry", retained: true });
  });

  it("records waiting but schedules no successor for a one-shot caller", () => {
    const fixture = modelWaitFixture();
    fixture.setDirective(rejectionDirective(null));

    fixture.tick();

    expect({ sent: fixture.sent, retriesAtSameTick: fixture.retries.length }).toEqual({
      sent: [],
      retriesAtSameTick: 0,
    });
  });

  it("keeps waiting and retrying free of Automation-host model calls", () => {
    const fixture = modelWaitFixture();
    fixture.setDirective(rejectionDirective(null));

    for (let index = 0; index < 100; index += 1) {
      fixture.setNow(Date.parse("2026-08-21T00:00:00.000Z") + index * 60_000);
      fixture.tick();
    }

    expect(fixture.sent).toEqual([]);
  });

  it("routes reviewer completion to the ordinary path after model access recovers", () => {
    const fixture = modelWaitFixture();
    fixture.setDirective(rejectionDirective(null));

    fixture.tick();
    fixture.setNow(Date.parse("2026-08-21T00:10:00.000Z"));
    fixture.tick();
    fixture.setDirective({ action: "working", accounting: { ...accounting, runtimeWasWorking: true } });
    fixture.setNow(Date.parse("2026-08-21T00:20:00.000Z"));
    fixture.tick();
    const completionApplied = fixture.applied.length;
    fixture.setDirective({
      action: "completion",
      accounting: { ...accounting, runtimeWasWorking: true },
      report: { status: "complete" },
    });
    fixture.setApplication(() => ({ applied: true }));
    fixture.setNow(Date.parse("2026-08-21T00:30:00.000Z"));
    fixture.tick();

    expect({
      completionReached: fixture.applied.slice(completionApplied).map((observed) => observed.action),
      retries: fixture.retries.length,
    }).toEqual({ completionReached: ["completion"], retries: 1 });
  });

  it("counts retries across repeated model-wait episodes", () => {
    const fixture = modelWaitFixture();
    fixture.setDirective(rejectionDirective(null));

    fixture.tick();
    fixture.setNow(Date.parse("2026-08-21T00:10:00.000Z"));
    fixture.tick();
    fixture.setNow(Date.parse("2026-08-21T00:20:00.000Z"));
    fixture.tick();
    fixture.setNow(Date.parse("2026-08-21T00:30:00.000Z"));
    fixture.tick();

    expect(fixture.payload().modelRetryCount).toBe(2);
  });

  it("waits for model availability on a repair handoff without any Automation-host model call", () => {
    const fixture = modelWaitFixture("repair");
    fixture.setDirective(rejectionDirective(null));

    fixture.tick();
    expect({
      result: fixture.entry.lastResult,
      retained: fixture.entry.pendingDriverHandoff !== undefined,
      retries: fixture.retries.length,
      promptsSent: fixture.sent,
    }).toEqual({ result: "driver_monitor_waiting_for_model", retained: true, retries: 0, promptsSent: [] });

    fixture.setNow(Date.parse("2026-08-21T00:10:00.000Z"));
    fixture.tick();
    expect({ retries: fixture.retries.length, promptsSent: fixture.sent }).toEqual({ retries: 1, promptsSent: [] });
  });
});

describe("deterministic monitoring of repair attempts", () => {
  const accounting = { activeMilliseconds: 60_000, observedAt: "1970-01-01T00:01:00.000Z", runtimeWasWorking: false };

  function repairMonitorFixture() {
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "monitor",
        monitorHandoff: { kind: "repair", input: { enabledAt: 1 } },
        monitorAccounting: { activeMilliseconds: 0, observedAt: "2026-08-21T00:00:00.000Z", runtimeWasWorking: false },
      },
    };
    const state = { automations: { auto: entry } };
    const sent: string[] = [];
    let directive: AttemptMonitoringDirective | undefined;
    const deps = {
      enabledAt: () => 1,
      isEnabled: () => true,
      notify: () => undefined,
      now: () => Date.parse("2026-08-21T00:05:00.000Z"),
      observeAttemptMonitoring: () => directive ?? null,
      applyAttemptMonitoring: () => ({ applied: true }),
      saveState: () => undefined,
      sendUserMessage: (prompt: string) => sent.push(prompt),
    };
    return {
      deps, entry, sent, state,
      setDirective: (value: AttemptMonitoringDirective) => { directive = value; },
    };
  }

  it.each(["working", "completion", "missing_report", "timeout", "ambiguity"] as const)("handles the %s directive for a repair handoff without a monitor prompt", (action) => {
    const fixture = repairMonitorFixture();
    fixture.setDirective(action === "working"
      ? { action: "working", accounting: accounting }
      : action === "completion"
        ? { action: "completion", accounting: accounting, report: { status: "complete" } }
        : action === "missing_report"
          ? { action: "missing_report", accounting: accounting, reason: "terminal_without_report" }
          : action === "timeout"
            ? { action: "timeout", accounting: accounting, reason: "active_work_limit" }
            : { action: "ambiguity", accounting: accounting, reason: "runtime_ambiguous" });

    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);

    expect(fixture.sent).toEqual([]);
  });

  it("keeps a working repair check active with its persisted active-work accounting", () => {
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "monitor",
        monitorHandoff: { kind: "repair", input: { enabledAt: 1 } },
        monitorAccounting: { activeMilliseconds: 0, observedAt: "1970-01-01T00:00:00.000Z", runtimeWasWorking: true },
      },
    };
    const state = { automations: { auto: entry } };
    const directives: AttemptMonitoringDirective[] = [];
    let now = 60_000;

    deliverPendingDriverHandoff(entry, state, "auto", {
      enabledAt: () => 1,
      isEnabled: () => true,
      now: () => now,
      observeAttemptMonitoring: (_handoff: Record<string, unknown>, accounting: any) => {
        directives.push(JSON.parse(JSON.stringify(directives.length ? accounting : { runtimeWasWorking: true })));
        return { action: "working", accounting: { activeMilliseconds: 60_000, observedAt: "1970-01-01T00:01:00.000Z", runtimeWasWorking: true } };
      },
      saveState: () => undefined,
    });

    expect({
      payloadAccounting: (entry.pendingDriverHandoff as Record<string, any>).monitorAccounting,
      lastResult: entry.lastResult,
    }).toEqual({
      payloadAccounting: { activeMilliseconds: 60_000, observedAt: "1970-01-01T00:01:00.000Z", runtimeWasWorking: true },
      lastResult: "driver_attempt_working",
    });
  });
});
