import { describe, expect, it } from "vitest";

import { reconcileAndSelectDueAutomation } from "../src/automation-scheduler";
import { automationStateKey, normalizeProject } from "../src/core";

describe("Automation host scheduling", () => {
  it("selects the automation that has been due longest", () => {
    const project = normalizeProject({ id: "demo" });
    const state = {
      "demo:demo:issue-coordinator": { lastScheduledAt: 20 * 60_000 },
      "demo:demo:pr-reviewer": { lastScheduledAt: 0 },
    };

    expect(reconcileAndSelectDueAutomation(project, state, 30 * 60_000)?.automation.id).toBe("demo:pr-reviewer");
  });

  it("uses the time an automation became due rather than its previous execution time", () => {
    const project = normalizeProject({
      id: "demo",
      automations: [
        { id: "became-due-now", name: "became due now", schedule: "*/30 * * * *", initialLastScheduledAt: 0 },
        { id: "waiting", name: "waiting", schedule: "*/10 * * * *", initialLastScheduledAt: 10 * 60_000 },
      ],
    });

    expect(reconcileAndSelectDueAutomation(project, {}, 30 * 60_000)?.automation.id).toBe("waiting");
  });

  it("ranks a non-aligned initial state by its first cron slot", () => {
    const project = normalizeProject({
      id: "demo",
      automations: [
        { id: "due-at-fifteen", name: "due at fifteen", schedule: "*/15 * * * *", initialLastScheduledAt: 0 },
        { id: "due-at-ten", name: "due at ten", schedule: "*/10 * * * *", initialLastScheduledAt: 9 * 60_000 },
      ],
    });

    expect(reconcileAndSelectDueAutomation(project, {}, 20 * 60_000)?.automation.id).toBe("due-at-ten");
  });

  it("selects the longest-waiting automation regardless of configuration order", () => {
    const project = normalizeProject({ id: "demo" });
    project.automations.reverse();
    const state = {
      "demo:demo:issue-coordinator": { lastScheduledAt: 20 * 60_000 },
      "demo:demo:pr-reviewer": { lastScheduledAt: 0 },
    };

    expect(reconcileAndSelectDueAutomation(project, state, 30 * 60_000)?.automation.id).toBe("demo:pr-reviewer");
  });

  it("selects the other due automation on the next tick", () => {
    const project = normalizeProject({ id: "demo" });
    const state = {
      "demo:demo:issue-coordinator": { lastScheduledAt: 20 * 60_000 },
      "demo:demo:pr-reviewer": { lastScheduledAt: 20 * 60_000 },
    };
    const first = reconcileAndSelectDueAutomation(project, state, 30 * 60_000);
    if (!first) throw new Error("expected a due automation");
    state[automationStateKey(project, first.automation)].lastScheduledAt = first.dueSlot;

    expect(reconcileAndSelectDueAutomation(project, state, 30 * 60_000)?.automation.id).not.toBe(first.automation.id);
  });
});
