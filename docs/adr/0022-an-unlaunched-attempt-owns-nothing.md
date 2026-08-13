# ADR 0022: An attempt that never opened a workspace owns nothing

## Status

Accepted

## Context

An attempt claims its target on GitHub before it launches. Between those two points it holds a claim and no workspace. A launch that fails there — because the checkout it wants is still held by an earlier attempt, say — leaves a journal at `launch_failed` whose `lastSuccessfulPhase` is `github_claimed` and whose workspace, tab, and pane are all absent.

Reconciliation counted that journal as an owner. Two journals for one pull request make its ownership ambiguous by count alone, before any evidence is read, so the pull request was blocked. Blocking removes the request labels, including `agent:in-progress` — and reconciliation only ever looked at pull requests carrying `agent:in-progress` or a recovery receipt. The pull request became invisible to the thing that had just blocked it.

Nothing else could reach it either. `/deadloop-abandon-attempt` refuses on two independent guards: the target is unsafe while `agent:blocked` is present and the request label is not, and the journal cannot prove a workspace opened before agent start. The doctor's recovery guidance refuses for the same second reason. `releasesAttemptOwnership` does not treat `launch_failed` as releasing, so the journal keeps its claim on the pull request for good.

PR #228 reached exactly this state. A completed review sat beside it holding a `human_required` report and an open workspace, and its handoff — the one [ADR 0021](0021-a-human-required-review-is-a-completed-review.md) had just made reachable — never ran, because reconciliation had stopped looking.

## Decision

An attempt that never opened a workspace holds no work authority, and reconciliation releases it.

The launch is what opens the workspace, so a launch that failed before one exists left nothing for the runtime to hold: nothing to observe, nothing to close, and no route back to the pull request. That is the proof ADR 0019 asks for — that the attempt cannot act on the current work — available from the journal alone, without a waiting Agent request. The release writes `authority_released` with the reason `never_launched`, so the journal says why its ownership ended while the launch error stays as evidence.

A launch failure that already held a workspace is the opposite case and keeps its ownership. That workspace still has to be accounted for, and `/deadloop-abandon-attempt` is the operation that accounts for it.

Reconciliation also selects any pull request it holds an attempt journal for, not only those carrying `agent:in-progress`. Local state claiming a pull request is a reason to look at it. Selecting on the label alone meant a pull request disappeared at the moment reconciliation blocked it, which is precisely when it still owes an answer.

## Consequences

One failed launch can no longer make a pull request permanently ambiguous, and the completed work beside it finishes.

A blocked pull request is reconciled again on every tick for as long as an attempt journal names it. That is more observation than before, and no new mutation: the reconciliation either confirms authority, blocks — which it has already done, idempotently — or releases. Once the surviving attempt closes, its journal releases ownership and the pull request stops being selected.

The recovery paths that refuse this state are left as they are. `/deadloop-abandon-attempt` still covers only a launch failure that opened a workspace, which is now the only kind that needs an operator.
