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
  /** Due automations kept from launching because a retained monitor handoff is still active (#426). */
  deferred: { automationId: string; dueSince: number }[];
};

export function reconcileAndSelectDueAutomation(
  project: Pick<NormalizedProject, "id" | "automations">,
  state: Record<string, AutomationStateEntry>,
  nowMs: number,
): DueAutomationSelection {
  let selected: { automation: NormalizedAutomation; dueSlot: number; dueSince: number } | null = null;
  const due: { automation: NormalizedAutomation; dueSlot: number; dueSince: number }[] = [];
  const deferred: { automationId: string; dueSince: number }[] = [];

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
    // A retained monitor handoff means an attempt is still working, waiting for model
    // availability, or pending completion. Launching again would overwrite that handoff and
    // orphan the running attempt's monitoring (#426), so this automation waits for a later tick.
    const handoff = entry.pendingDriverHandoff;
    if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) {
      deferred.push({ automationId: automation.id, dueSince });
      continue;
    }
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
  return { selected: selected && { automation: selected.automation, dueSlot: selected.dueSlot }, starved, deferred };
}
