import {
  automationStateKey,
  cronSlotAt,
  decideDueSlot,
  parseEveryMinutes,
  type AutomationStateEntry,
  type NormalizedAutomation,
  type NormalizedProject,
} from "./core";

export function reconcileAndSelectDueAutomation(
  project: Pick<NormalizedProject, "id" | "automations">,
  state: Record<string, AutomationStateEntry>,
  nowMs: number,
): { automation: NormalizedAutomation; dueSlot: number } | null {
  let selected: { automation: NormalizedAutomation; dueSlot: number; dueSince: number } | null = null;

  for (const automation of project.automations) {
    const key = automationStateKey(project, automation);
    const entry = state[key] || {};
    const decision = decideDueSlot(automation, entry, nowMs);
    state[key] = decision.kind === "missed" ? decision.entry : entry;
    if (decision.kind !== "due") continue;
    const dueSlot = decision.dueSlot;

    const intervalMinutes = parseEveryMinutes(automation.schedule);
    if (intervalMinutes === null) continue;
    const lastScheduledAt = Number.isFinite(entry.lastScheduledAt)
      ? entry.lastScheduledAt!
      : automation.initialLastScheduledAt;
    const dueSince = cronSlotAt(lastScheduledAt, intervalMinutes) + intervalMinutes * 60_000;
    if (!selected || dueSince < selected.dueSince) {
      selected = { automation, dueSlot, dueSince };
    }
  }

  return selected && { automation: selected.automation, dueSlot: selected.dueSlot };
}
