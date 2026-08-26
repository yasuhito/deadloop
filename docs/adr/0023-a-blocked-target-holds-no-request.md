# ADR 0023: A blocked target holds no waiting request

## Status

Accepted.

## Context

Deadloop stops a pull request it cannot finish safely by adding `agent:blocked`. The repair paths added a request label in the same move: `blockedClaimMove` removed `agent:in-progress` and added both `agent:review` and `agent:blocked`, so a person who resolved the cause could restart the loop by removing one label.

That request is not addressed to anyone. `postBlockRequestIsEligible` only accepts a request stamped strictly later than the newest block, and a request added by the same label move carries the same GitHub second, so the path that wrote it refuses to act on it. It waits for a person to lift the block.

Reconciliation reads the same two labels and has no such rule. `latestConfiguredRequest` takes the newest event for whichever request labels the pull request currently carries, without regard to the block, and `classifyClaim` calls the attempt superseded because that event is not the one its claim consumed. Superseded plus a stopped runtime is `release_for_request`, and `releaseLabels` dropped `agent:blocked` by name.

`yasuhito/pi-dictation` PR #42 measured the cost twice on 2026-08-14, at code identity `f4a6b3b2`:

| | first | second |
|---|---|---|
| driver adds the block | 12:09:26 | 12:19:58 |
| reconciliation removes it | 12:09:51 | 12:20:22 |

The driver stopped for `review_repair_dirty_worktree` — the repair worktree was dirty, so a person had to look before automatic repair continued. Reconciliation, which runs at the head of every tick, returned the pull request to its request state about 25 seconds later, and the next tick launched another review. The handoff never happened, and a review agent was spent every ten minutes.

Two rules answered one question — may a waiting request restart work while a block stands — and they disagreed. [ADR 0020](0020-stop-proving-work-authority.md) named that shape as the defect class it removes.

The Issue side never had the disagreement. `applyBlocked` removes `agent:implement` and adds `agent:blocked`, leaving no request behind.

## Decision

A blocked target holds no waiting Agent request.

"Deadloop stopped this" and "deadloop is still asked to work on this" are not both true. Deadloop's own blocks therefore clear every request label — including one a person added while the attempt ran, because a label is what the pull request is asked to do now, not a record of who asked. The block comment says what was cleared and what to add to restart.

The invariant makes the ordering rule structural rather than duplicated: a request label observed beside `agent:blocked` was necessarily added after it. `postBlockRequestIsEligible` survives for the one case deadloop cannot write — a person stopping a pull request by hand, whose earlier requests must not restart it — and stays in the launch decision, its single caller.

Reconciliation no longer removes `agent:blocked`. A release ends the in-progress state; the block is lifted when a new attempt claims the target and replaces every managed label. So `agent:blocked` disappearing means an attempt started, and a release that fails halfway leaves a pull request that reads as stopped, which it is.

Restarting is adding a request label. Guidance said "remove `agent:blocked`", which under this decision does nothing — a blocked pull request has no request to resume — and made the same operation mean both "restart this" and "stop managing this". It now says to add the request label for the role, which is what the reconciler's recovery comment already said.

Paths that only stop, without deciding a label set — the `gh pr edit --add-label` calls in `guarded-operation.cts`, `merge-reviewed-pr.cts`, and the `addBlocked` callbacks — keep writing the one label. They run where continuing is already unsafe, and reading, diffing, and replacing labels there would add failures to the moment that must not fail. A request can only sit beside those blocks if a person added it mid-attempt, which is exactly what the ordering rule refuses.

## Consequences

A block deadloop writes survives until someone asks for the next attempt. The loop stops instead of restarting itself, which is what a handoff is.

Restarting costs one label instead of one label, and no longer depends on doing two operations in the right order. Removing `agent:blocked` by hand now means one thing: take this pull request out of deadloop's hands.

A pull request waiting to restart carries `agent:review` and `agent:blocked` together for one tick, until the attempt claims it. That pair now reads as "asked for, not started yet", and nothing else writes it.

`pr-review-repair-complete.cts` needs the implement and update-branch label names it never received, and validates all three against the saved claim's managed set, because clearing a label the claim does not name would reach outside the contract the attempt was launched under.

The Issue side keeps its own restart ritual: `agent:blocked` must be removed by hand, because Issue selection skips a blocked Issue outright and an Issue attempt does not replace every managed label when it starts. The label shape is already the same on both sides; only the restart differs, and closing that gap is separate work.
