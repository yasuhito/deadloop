// The one definition of a pull request human handoff.

// A completed review that no longer needs an agent hands its pull request to a person. That handoff
// is one state made of two halves: the pull request is ready (no longer a draft) and no agent
// workflow label remains. Both halves are named here; neither alone completes a handoff.

// Every executor of the handoff and every proof that it happened derives from this module, so an
// approved handoff and a human_required handoff cannot drift apart the way they drift apart when
// each site restates its own label list.

// The mutation order is part of the definition: the draft leaves first, then the labels go. A failed
// label removal then leaves a ready pull request whose requests are still visible, which a retry can
// finish, instead of stranding a silently unlabelled draft nobody waits on.

import type { HumanHandoffLabels, HumanHandoffObservation } from "./human-handoff-types";

/**
 * Every agent workflow label, which a human handoff keeps none of. A blocked pull request is one
 * deadloop could not finish safely; both it and a handed-off pull request wait on a person, but only
 * the handoff has stopped asking any agent request.
 */
function agentWorkflowLabels(labels: HumanHandoffLabels): string[] {
  return [labels.reviewLabel, labels.implementLabel, labels.updateBranchLabel, labels.inProgressLabel, labels.blockedLabel];
}

/** A handoff happened only when both halves hold: ready, and no agent workflow label left. */
function humanHandoffComplete(observation: HumanHandoffObservation, labels: HumanHandoffLabels): boolean {
  return observation.isDraft === false && !agentWorkflowLabels(labels).some((label) => observation.labels.includes(label));
}

/** The guarded label move that executes the second half of the handoff. */
function humanHandoffLabelMove(labels: HumanHandoffLabels): { remove: string[]; add: string[] } {
  return { remove: agentWorkflowLabels(labels), add: [] };
}

module.exports = { agentWorkflowLabels, humanHandoffComplete, humanHandoffLabelMove };
