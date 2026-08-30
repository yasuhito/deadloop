# ADR 0029: attempt monitoring is model-free

## Status

Accepted

## Decision

Attempt monitoring is deterministic and never invokes the Automation host's model. It observes the execution runtime, completion report, attempt journal, and configured runtime limit; invokes deterministic completion handlers; and returns the same directive for the same observation. The prompt-based monitor handoff, `nudge_worker`, and repeated requests for a missing completion report are removed.

A runtime-reported working agent remains active even when output is temporarily quiet. The existing 24-hour configured maximum becomes an enforced active-work limit; its value may be reconsidered only after runtime measurements exist. Once a turn ends, a valid completion report proceeds normally. A missing report either enters the narrowly recognized model-availability wait or stops immediately; it is never repaired by asking the finished agent to write a report.

A terminal reading before any working turn was ever observed is the not-yet-started-turn race, not a dead agent. An attempt whose journal records a launch time keeps monitoring through a 60-second grace from that launch time instead of stopping; active-work accounting counts only observed working turns, so `activeMilliseconds === 0` proves no turn was ever observed.

A stop applies its GitHub writes — the label move and the stop comment — back to back under one final confirmation of the stop reason. Aborting between the writes is never allowed: a moved label without its comment, or the reverse, would strand a half-applied stop that only a person could repair.

A model-availability wait retains one attempt, workspace, worktree, and agent session. It emits one visible notice, follows a provider retry time when available or the normal next scheduler tick otherwise, creates no new runtime resources, and does not count waiting time toward the active-work limit. Intermediate session errors are left to the agent CLI and are not terminal evidence.

## Consequences

The failure that produced repeated high-cost monitor turns cannot recur through monitoring. Retry and completion behavior becomes testable through one decision interface. A one-shot scheduler tick does not schedule the next retry; the operator starts another one-shot tick after resolving model availability.
