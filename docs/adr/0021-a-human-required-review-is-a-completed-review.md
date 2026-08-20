# ADR 0021: A human-required review is a completed review

## Status

Accepted

## Context

A review reports one of three outcomes. `approved` and `changes_requested` describe work deadloop can continue: merge it, hand it over, or repair it. `human_required` describes work deadloop has finished — the checking it owns is done, and the remaining judgment belongs to a person.

The implementation treated that third outcome as an unfinished attempt. Four independent places encoded the same rule:

- `reviewerCompletionPersisted` returned false for the transition, so a human-required review could never be persisted.
- `evaluateCompletionPersistence` preserved it under its own retention reason, before any GitHub observation was read.
- `complete-attempt-workspace.cts` retained the workspace "for inspection" alongside reports that stopped without completing.
- The reviewer dispatcher ended the outcome on `agent:review` plus `agent:blocked`, which is the state of work deadloop could not finish safely.

The restart reconciler skipped the outcome entirely, and the shared completion contract in `reconcile-pr-work-authority.cts` had no reviewer row at all: its proof was a finalizer push receipt, which a review never produces. So the only path that could finish a human-required review ran from the reviewer's monitor prompt.

PR #228 measured what that costs. The review ran to completion, wrote a report with two required findings, and stopped. Its monitor never ran the handoff. Nothing else could: the reconciler skipped the outcome, the shared contract had no proof for it, the workspace stayed open, ordinary reconciliation released the attempt's authority, `agent:review` came back, and the next launch collided with the workspace the first attempt still held. The review result reached no one.

The domain model already said something different. [Human handoff](../../CONTEXT.md) defines the state as a pull request whose draft became ready and which keeps no agent workflow label, explicitly not `ready-for-human`, which classifies Issues. Nothing wrote that state for a review.

## Decision

A review that reports `human_required` completes like any other review.

Its completion is a state transition on the pull request: the result is recorded once as a comment, a draft becomes ready, and every agent workflow label is removed. No agent request is left waiting on a pull request deadloop has finished checking. `agent:blocked` keeps its own meaning — deadloop could not finish safely — and continues to mark bounded failures, unsafe targets, and exhausted repair attempts.

Its workspace closes on the same proof every other outcome closes on: the live pull request carrying the state the caller expected. For a human handoff that expected state is the empty managed-label set, so the proof is exactly "no request waits on this pull request anymore". A stop with no completion report still retains its workspace, unchanged.

The shared completion contract gains a reviewer row. What an attempt proved it completed is asked of every role in one shape — the revision the completion is bound to, and the head the attempt still expects to own. A writing role answers from the finalizer's push receipt; a review answers from its own report, strongly bound to the attempt journal and naming the head it read. Reconciliation drives that handoff when the monitor is gone, so a finished review no longer depends on one session surviving.

The reviewer row finishes only the outcome whose completion is a state transition. A repairing review completes by launching another agent and an approved review by merging or handing over under gates reconciliation does not hold; both are refused by name and left to their monitor, and the refusal carries its reason.

## Consequences

A completed human-required review no longer holds a workspace, so the next Agent request for the same checkout starts without colliding.

A human-required review no longer carries `agent:blocked`, so it is not covered by the post-block request recovery path. It does not need to be: nothing is blocking, and a person adding a request label starts the next attempt directly.

The retention reason and doctor status named for the outcome are gone. A human-required review whose handoff has not run yet reports as persistence unconfirmed, which is what it is, instead of as an attempt deliberately kept open.

Approved reviews with automatic merge off now expect the same empty label set. The restart path previously expected `ready-for-human` on the pull request, a label no code writes there, so its workspace could never close either.
