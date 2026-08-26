import { describe, expect, it } from "vitest";

import {
  deliverPendingDriverHandoff,
  isPendingIssueHandoffEligible,
  type MonitorHandoffDisposition,
  runScheduledAutomation,
} from "../src/automation-runner";
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

function monitorDeliveryFixture(kind = "branch-update") {
  const handoff = branchUpdateMonitorHandoff();
  handoff.kind = kind;
  const entry: Record<string, unknown> = {
    pendingDriverHandoff: {
      action: "needs_llm",
      monitorHandoff: handoff,
      prompt: "monitor prompt",
    },
  };
  const state = { automations: { auto: entry } };
  const sent: string[] = [];
  const applied: string[] = [];
  let now = 0;
  let disposition: MonitorHandoffDisposition = { action: "continue_legacy_monitor" };
  return {
    entry,
    state,
    sent,
    applied,
    deps: {
      enabledAt: () => 1,
      isEnabled: () => true,
      monitorHandoffDisposition: () => disposition,
      applyMonitorHandoffDisposition: (_handoff: Record<string, unknown>, decision: Record<string, unknown>) => {
        applied.push(String(decision.action));
        return true;
      },
      now: () => now,
      saveState: () => undefined,
      sendUserMessage: (prompt: string) => sent.push(prompt),
    },
    setNow: (value: number) => { now = value; },
    setDisposition: (value: MonitorHandoffDisposition) => { disposition = value; },
  };
}

async function exerciseDriver(
  stdout: string,
  options: {
    code?: number;
    stderr?: string;
    initialEntry?: Record<string, unknown>;
    isEnabled?: () => boolean;
    runDriver?: () => void;
    runPrecheck?: () => void;
    sendUserMessageIfEnabled?: (prompt: string) => boolean;
  } = {},
) {
  const project = normalizeProject({
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
  it("clears the current driver error after a recovered launch is queued", async () => {
    const result = await exerciseDriver(
      JSON.stringify({ action: "needs_llm", summary: "recovered", prompt: "monitor" }),
      { initialEntry: { lastResult: "driver_error", failureStreak: 8, lastError: "agent_name_taken" } },
    );

    expect({
      failureStreak: result.entry.failureStreak,
      lastError: result.entry.lastError,
      lastResult: result.entry.lastResult,
    }).toEqual({ failureStreak: 0, lastError: undefined, lastResult: "driver_needs_llm_queued" });
  });

  it("records the skip driver result", async () => {
    const result = await exerciseDriver(JSON.stringify({ action: "skip", summary: "対象なし" }));

    expect(result.entry.lastResult).toBe("driver_skip");
  });

  it("records the done driver summary", async () => {
    const result = await exerciseDriver(JSON.stringify({ action: "done", summary: "cleanup complete" }));

    expect(result.entry.lastSummary).toBe("cleanup complete");
  });

  it("records the needs_llm queue result", async () => {
    const result = await exerciseDriver(
      JSON.stringify({ action: "needs_llm", summary: "判断待ち", prompt: "short prompt" }),
    );

    expect(result.entry.lastResult).toBe("driver_needs_llm_queued");
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
    const result = await exerciseDriver(JSON.stringify({ action: "needs_llm", prompt: "driver prompt" }), {
      isEnabled: () => enabled,
      runPrecheck: () => { enabled = false; },
    });

    expect(result.sent).toEqual([]);
  });

  it("does not start a side-effecting driver when enablement changes after the post-precheck gate", async () => {
    let checks = 0;
    let driverStarted = false;
    await exerciseDriver(JSON.stringify({ action: "needs_llm", prompt: "driver prompt" }), {
      isEnabled: () => ++checks === 1,
      runDriver: () => { driverStarted = true; },
    });

    expect(driverStarted).toBe(false);
  });

  it("does not dispatch a driver prompt after enablement is removed during driver execution", async () => {
    let enabled = true;
    const result = await exerciseDriver(JSON.stringify({ action: "needs_llm", prompt: "driver prompt" }), {
      isEnabled: () => enabled,
      runDriver: () => { enabled = false; },
    });

    expect(result.sent).toEqual([]);
  });

  it("persists the complete driver handoff when enablement is removed during driver execution", async () => {
    let enabled = true;
    const payload = { action: "needs_llm", prompt: "driver prompt", launch: { promiseFile: "/runs/1/promise.json" } };
    const result = await exerciseDriver(JSON.stringify(payload), {
      isEnabled: () => enabled,
      runDriver: () => { enabled = false; },
    });

    expect(result.entry.pendingDriverHandoff).toEqual(payload);
  });

  it("records disabled-before-driver-prompt when enablement is removed during driver execution", async () => {
    let enabled = true;
    const result = await exerciseDriver(JSON.stringify({ action: "needs_llm", prompt: "driver prompt" }), {
      isEnabled: () => enabled,
      runDriver: () => { enabled = false; },
    });

    expect(result.entry.lastResult).toBe("disabled_before_driver_prompt");
  });

  it("delivers and clears a persisted driver handoff after re-enable", () => {
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: { action: "needs_llm", prompt: "driver prompt", launch: { promiseFile: "/runs/1/promise.json" } },
    };
    const state = { automations: { auto: entry } };
    const sent: string[] = [];

    deliverPendingDriverHandoff(entry, state, "auto", {
      isEnabled: () => true,
      now: () => 456,
      saveState: () => undefined,
      sendUserMessage: (prompt) => sent.push(prompt),
    });

    expect({ sent, pending: entry.pendingDriverHandoff }).toEqual({ sent: ["driver prompt"], pending: undefined });
  });

  it("retains a queued monitor handoff until the attempt settles", () => {
    const fixture = monitorDeliveryFixture();

    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);

    expect(fixture.entry.pendingDriverHandoff).toMatchObject({
      monitorHandoff: { kind: "branch-update" },
    });
  });

  it("redelivers a retained monitor handoff after the retry interval", () => {
    const fixture = monitorDeliveryFixture();

    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    fixture.setNow(60_000);
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);

    expect(fixture.sent).toHaveLength(2);
  });

  it("does not redeliver a retained monitor handoff before the retry interval", () => {
    const fixture = monitorDeliveryFixture();

    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    fixture.setNow(59_999);
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);

    expect(fixture.sent).toHaveLength(1);
  });

  it("clears a retained monitor handoff after the attempt settles", () => {
    const fixture = monitorDeliveryFixture();

    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    fixture.setDisposition({ action: "settled" });
    fixture.setNow(60_000);
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);

    expect(fixture.entry.pendingDriverHandoff).toBeUndefined();
  });

  it.each(["issue", "explorer", "reviewer", "branch-update", "repair"])("never redelivers a terminal %s handoff without a report", (kind) => {
    const fixture = monitorDeliveryFixture(kind);
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    fixture.setDisposition({ action: "stop", reason: "missing_completion_report" });

    for (let tick = 1; tick <= 500; tick += 1) {
      fixture.setNow(tick * 60_000);
      deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    }

    expect(fixture.sent).toHaveLength(1);
  });

  it("applies a terminal stop once", () => {
    const fixture = monitorDeliveryFixture();
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    fixture.setDisposition({ action: "stop", reason: "missing_completion_report" });

    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);

    expect(fixture.applied).toEqual(["stop"]);
  });

  it("preserves ambiguous runtime evidence without applying a stop", () => {
    const fixture = monitorDeliveryFixture();
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    fixture.setDisposition({ action: "preserve", reason: "runtime_ambiguous" });

    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);

    expect({ applied: fixture.applied, pending: fixture.entry.pendingDriverHandoff !== undefined }).toEqual({
      applied: [],
      pending: true,
    });
  });

  it("retains one handoff while waiting for model availability", () => {
    const fixture = monitorDeliveryFixture();
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    fixture.setDisposition({ action: "wait_for_model", reason: "model_availability" });

    for (let tick = 1; tick <= 500; tick += 1) {
      fixture.setNow(tick * 60_000);
      deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    }

    expect(fixture.entry.pendingDriverHandoff).toBeDefined();
  });
  it("posts the model availability transition once", () => {
    const fixture = monitorDeliveryFixture();
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    fixture.setDisposition({ action: "wait_for_model", reason: "model_availability" });

    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);
    deliverPendingDriverHandoff(fixture.entry, fixture.state, "auto", fixture.deps);

    expect(fixture.applied).toEqual(["wait_for_model"]);
  });

  it.each(["reviewer", "branch-update", "repair"])("discards a pre-disable %s monitor handoff for deterministic re-evaluation", (kind) => {
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "needs_llm",
        monitorHandoff: { kind, input: { enabledAt: 1 } },
        prompt: "stale prompt",
      },
    };
    const state = { automations: { auto: entry } };
    const sent: string[] = [];

    deliverPendingDriverHandoff(entry, state, "auto", {
      enabledAt: () => 2,
      isEnabled: () => true,
      now: () => 456,
      saveState: () => undefined,
      sendUserMessage: (prompt) => sent.push(prompt),
    });

    expect({ result: entry.lastResult, pending: entry.pendingDriverHandoff, sent }).toEqual({
      result: "driver_handoff_revalidation_required",
      pending: undefined,
      sent: [],
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
        action: "needs_llm",
        monitorHandoff: { kind: "reviewer", input },
        prompt: "stale prompt",
      },
    };
    const state = { automations: { auto: entry } };

    deliverPendingDriverHandoff(entry, state, "auto", {
      enabledAt: () => 2,
      isEnabled: () => true,
      now: () => 456,
      saveState: () => undefined,
      sendUserMessage: () => undefined,
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
        action: "needs_llm",
        monitorHandoff: { kind: "issue", input: { enabledAt: 1 } },
        prompt: "stale prompt",
      },
    };
    const state = { automations: { auto: entry } };

    deliverPendingDriverHandoff(entry, state, "auto", {
      enabledAt: () => 2,
      isEnabled: () => true,
      now: () => 456,
      saveState: () => undefined,
      sendUserMessage: () => undefined,
    });

    expect(entry.lastResult).toBe("driver_handoff_revalidation_required");
  });

  it("rebinds a pre-disable issue handoff after deterministic eligibility revalidation", () => {
    const entry: Record<string, unknown> = {
      pendingDriverHandoff: {
        action: "needs_llm",
        monitorHandoff: { kind: "issue", input: { enabledAt: 1, promiseFile: "/runs/one/promise.json", reviewLabel: "custom:review" } },
        prompt: "stale prompt",
      },
    };
    const state = { automations: { auto: entry } };
    const sent: string[] = [];

    deliverPendingDriverHandoff(entry, state, "auto", {
      enabledAt: () => 2,
      isEnabled: () => true,
      now: () => 456,
      revalidatePendingDriverHandoff: () => true,
      saveState: () => undefined,
      sendUserMessage: (prompt) => sent.push(prompt),
    });

    expect(sent[0]).toContain("--enabled-at 2");
  });

  it("does not dispatch a driver prompt when disable wins the enqueue lock", async () => {
    const result = await exerciseDriver(JSON.stringify({ action: "needs_llm", prompt: "driver prompt" }), {
      isEnabled: () => true,
      sendUserMessageIfEnabled: () => false,
    });

    expect(result.sent).toEqual([]);
  });

  it("does not dispatch a prompt when disable wins the enqueue lock", async () => {
    const project = normalizeProject({
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
    const project = normalizeProject({
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
    const project = normalizeProject({
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
