import { describe, expect, it } from "vitest";

import { reconcileAndSelectDueAutomation } from "../src/automation-scheduler";
import { automationStateKey, normalizeProject } from "../src/core";

describe("Automation host scheduling", () => {
  it("selects the automation that has been due longest", () => {
    const project = normalizeProject({ id: "demo", workerModel: "test-model", reviewerModel: "review-model" });
    const state = {
      "demo:demo:issue-coordinator": { lastScheduledAt: 20 * 60_000 },
      "demo:demo:pr-reviewer": { lastScheduledAt: 0 },
    };

    expect(reconcileAndSelectDueAutomation(project, state, 30 * 60_000).selected?.automation.id).toBe("demo:pr-reviewer");
  });

  it("uses the time an automation became due rather than its previous execution time", () => {
    const project = normalizeProject({
      id: "demo",
      workerModel: "test-model",
      reviewerModel: "review-model",
      automations: [
        { id: "became-due-now", name: "became due now", schedule: "*/30 * * * *", initialLastScheduledAt: 0, driverFile: "driver.cts" },
        { id: "waiting", name: "waiting", schedule: "*/10 * * * *", initialLastScheduledAt: 10 * 60_000, driverFile: "driver.cts" },
      ],
    });

    expect(reconcileAndSelectDueAutomation(project, {}, 30 * 60_000).selected?.automation.id).toBe("waiting");
  });

  it("ranks a non-aligned initial state by its first cron slot", () => {
    const project = normalizeProject({
      id: "demo",
      workerModel: "test-model",
      reviewerModel: "review-model",
      automations: [
        { id: "due-at-fifteen", name: "due at fifteen", schedule: "*/15 * * * *", initialLastScheduledAt: 0, driverFile: "driver.cts" },
        { id: "due-at-ten", name: "due at ten", schedule: "*/10 * * * *", initialLastScheduledAt: 9 * 60_000, driverFile: "driver.cts" },
      ],
    });

    expect(reconcileAndSelectDueAutomation(project, {}, 20 * 60_000).selected?.automation.id).toBe("due-at-ten");
  });

  it("selects the longest-waiting automation regardless of configuration order", () => {
    const project = normalizeProject({ id: "demo", workerModel: "test-model", reviewerModel: "review-model" });
    project.automations.reverse();
    const state = {
      "demo:demo:issue-coordinator": { lastScheduledAt: 20 * 60_000 },
      "demo:demo:pr-reviewer": { lastScheduledAt: 0 },
    };

    expect(reconcileAndSelectDueAutomation(project, state, 30 * 60_000).selected?.automation.id).toBe("demo:pr-reviewer");
  });

  it("selects the other due automation on the next tick", () => {
    const project = normalizeProject({ id: "demo", workerModel: "test-model", reviewerModel: "review-model" });
    const state = {
      "demo:demo:issue-coordinator": { lastScheduledAt: 20 * 60_000 },
      "demo:demo:pr-reviewer": { lastScheduledAt: 20 * 60_000 },
    };
    const first = reconcileAndSelectDueAutomation(project, state, 30 * 60_000);
    if (!first.selected) throw new Error("expected a due automation");
    state[automationStateKey(project, first.selected.automation)].lastScheduledAt = first.selected.dueSlot;

    expect(reconcileAndSelectDueAutomation(project, state, 30 * 60_000).selected?.automation.id).not.toBe(first.selected.automation.id);
  });

  it("reports the due automations that lost selection as starved", () => {
    const project = normalizeProject({ id: "demo", workerModel: "test-model", reviewerModel: "review-model" });
    const state = {
      "demo:demo:issue-coordinator": { lastScheduledAt: 20 * 60_000 },
      "demo:demo:pr-reviewer": { lastScheduledAt: 20 * 60_000 },
    };

    const { starved } = reconcileAndSelectDueAutomation(project, state, 30 * 60_000);

    expect(starved.map((entry) => entry.automationId)).toEqual(["demo:pr-reviewer"]);
  });

  it("records a missed slot on the state entry", () => {
    const project = normalizeProject({
      id: "demo",
      workerModel: "test-model",
      reviewerModel: "review-model",
      automations: [{ id: "late", name: "late", schedule: "*/10 * * * *", graceMinutes: 1, initialLastScheduledAt: 0, driverFile: "driver.cts" }],
    });
    const state: Record<string, Record<string, unknown>> = { "demo:late": { lastScheduledAt: 0 } };

    reconcileAndSelectDueAutomation(project, state, 21 * 60_000 + 30_000);

    expect(state["demo:late"]).toEqual({ lastScheduledAt: 20 * 60_000, lastResult: "missed_outside_grace", updatedAt: 21 * 60_000 + 30_000 });
  });
});
