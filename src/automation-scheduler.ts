import {
  automationStateKey,
  cronSlotAt,
  decideDueSlot,
  parseEveryMinutes,
  type AutomationStateEntry,
  type NormalizedAutomation,
  type NormalizedProject,
} from "./core";

export type DueAutomationSelection = {
  selected: { automation: NormalizedAutomation; dueSlot: number } | null;
  /** Automations that were due at this tick but lost selection to another due automation (#402). */
  starved: { automationId: string; dueSince: number }[];
};

export function reconcileAndSelectDueAutomation(
  project: Pick<NormalizedProject, "id" | "automations">,
  state: Record<string, AutomationStateEntry>,
  nowMs: number,
): DueAutomationSelection {
  let selected: { automation: NormalizedAutomation; dueSlot: number; dueSince: number } | null = null;
  const due: { automation: NormalizedAutomation; dueSlot: number; dueSince: number }[] = [];

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
    due.push({ automation, dueSlot, dueSince });
  }

  const starved = selected
    ? due
        .filter((candidate) => candidate.automation !== selected!.automation)
        .map((candidate) => ({ automationId: candidate.automation.id, dueSince: candidate.dueSince }))
    : [];
  return { selected: selected && { automation: selected.automation, dueSlot: selected.dueSlot }, starved };
}
