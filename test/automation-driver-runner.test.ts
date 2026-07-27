import { describe, expect, it } from "vitest";

import {
  deliverPendingDriverHandoff,
  isPendingIssueHandoffEligible,
  runScheduledAutomation,
} from "../src/automation-runner";
import { normalizeProject, type AutomationFileResolution } from "../src/core";

function foundFile(requested: string | undefined): AutomationFileResolution {
  const name = requested || "";
  return { requested: name, resolved: name, found: name.length > 0 };
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
        monitorHandoff: { kind: "issue", input: { enabledAt: 1 } },
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
