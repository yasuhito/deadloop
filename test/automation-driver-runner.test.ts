import { describe, expect, it } from "vitest";

import { recordAutomationResult, runScheduledAutomation } from "../src/automation-runner";
import { normalizeProject, type AutomationFileResolution } from "../src/core";

function foundFile(requested: string | undefined): AutomationFileResolution {
  const name = requested || "";
  return { requested: name, resolved: name, found: name.length > 0 };
}

async function exerciseDriver(stdout: string, options: { code?: number; stderr?: string } = {}) {
  const project = normalizeProject({
    id: "demo",
    automations: [
      { id: "demo:auto", name: "auto", precheckFile: "precheck.sh", promptFile: "full.md", driverFile: "driver.py" },
    ],
  });
  const state = { automations: {} };
  const sent: string[] = [];

  await runScheduledAutomation(project, project.automations[0], 123, state, {
    isIdle: () => true,
    notify: () => undefined,
    now: () => 456,
    readPrompt: () => "full prompt",
    resolveAutomationFileInDir: (_kind, _automation, requested) => foundFile(requested),
    runDriver: async () => ({ code: options.code ?? 0, stdout, stderr: options.stderr ?? "" }),
    runPrecheck: async () => ({ code: 0, stdout: "", stderr: "" }),
    saveState: () => undefined,
    sendUserMessage: (prompt) => sent.push(prompt),
    setStatus: () => undefined,
  });

  return { sent, entry: state.automations["demo:demo:auto"] };
}

describe("deterministic automation driver runner", () => {
  it("clears the current driver error after recovery", () => {
    const entry = { lastResult: "driver_error", failureStreak: 8, lastError: "agent_name_taken" };

    recordAutomationResult(entry, "driver_needs_llm_queued");

    expect(entry).toEqual({ lastResult: "driver_needs_llm_queued", failureStreak: 0 });
  });

  it("skips sending a prompt when the driver returns skip", async () => {
    const result = await exerciseDriver(JSON.stringify({ action: "skip", summary: "対象なし" }));

    expect(result.sent).toEqual([]);
  });

  it("records the skip driver result", async () => {
    const result = await exerciseDriver(JSON.stringify({ action: "skip", summary: "対象なし" }));

    expect(result.entry.lastResult).toBe("driver_skip");
  });

  it("skips sending a prompt when the driver returns done", async () => {
    const result = await exerciseDriver(JSON.stringify({ action: "done", summary: "cleanup complete" }));

    expect(result.sent).toEqual([]);
  });

  it("records the done driver summary", async () => {
    const result = await exerciseDriver(JSON.stringify({ action: "done", summary: "cleanup complete" }));

    expect(result.entry.lastSummary).toBe("cleanup complete");
  });

  it("sends only the driver prompt when the driver returns needs_llm", async () => {
    const result = await exerciseDriver(
      JSON.stringify({ action: "needs_llm", summary: "判断待ち", prompt: "short prompt" }),
    );

    expect(result.sent).toEqual(["short prompt"]);
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

  it("skips sending a prompt when the driver returns invalid JSON", async () => {
    const result = await exerciseDriver("not json");

    expect(result.sent).toEqual([]);
  });

  it("records a non-zero driver exit", async () => {
    const result = await exerciseDriver("", { code: 2, stderr: "boom" });

    expect(result.entry.lastError).toBe("boom");
  });

  it("skips sending a prompt when the driver exits non-zero", async () => {
    const result = await exerciseDriver("", { code: 2, stderr: "boom" });

    expect(result.sent).toEqual([]);
  });

  it("records a driver error action", async () => {
    const result = await exerciseDriver(JSON.stringify({ action: "error", error: "operator attention required" }));

    expect(result.entry.lastError).toBe("operator attention required");
  });

  it("skips sending a prompt when the driver returns error", async () => {
    const result = await exerciseDriver(JSON.stringify({ action: "error", error: "operator attention required" }));

    expect(result.sent).toEqual([]);
  });

  it("keeps prompt-only automations working when no driver is configured", async () => {
    const project = normalizeProject({
      id: "demo",
      automations: [{ id: "demo:auto", name: "auto", precheckFile: "precheck.sh", promptFile: "full.md" }],
    });
    const state = { automations: {} };
    const sent: string[] = [];

    await runScheduledAutomation(project, project.automations[0], 123, state, {
      isIdle: () => true,
      notify: () => undefined,
      now: () => 456,
      readPrompt: () => "full prompt",
      resolveAutomationFileInDir: (_kind, _automation, requested) => foundFile(requested),
      runDriver: async () => ({ code: 99, stdout: "should not run", stderr: "" }),
      runPrecheck: async () => ({ code: 0, stdout: "", stderr: "" }),
      saveState: () => undefined,
      sendUserMessage: (prompt) => sent.push(prompt),
      setStatus: () => undefined,
    });

    expect(sent).toEqual(["full prompt"]);
  });
});
