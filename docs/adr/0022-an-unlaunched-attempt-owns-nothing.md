# ADR 0022: While work authority still exists, an unlaunched attempt does not hold it

## Status

Accepted, interim. Amends [ADR 0019](0019-work-authority-release-for-a-new-agent-request.md) for as long as the subsystem [ADR 0020](0020-stop-proving-work-authority.md) removes is still running.

## Context

ADR 0020 decided that deadloop stops deriving work authority: the concept and the reconciliation that produced it are removed, replaced by compare-and-swap at the mutation, a local dispatch lock, runtime-only liveness, and GitHub as the request queue. That removal is not finished — the dispatch lock landed, and the claim layer's removal is still open work — so `reconcile-pr-work-authority.cts` still decides which attempt owns a pull request on every tick, and its defects still stop live pull requests.

One such defect has no escape. An attempt claims its target on GitHub before it launches. Between those two points it holds a claim and no workspace. A launch that fails there leaves a journal at `launch_failed` whose `lastSuccessfulPhase` never passed `github_claimed` and whose workspace, tab, and pane are all absent.

Reconciliation counted that journal as an owner. Two journals for one pull request make its ownership ambiguous by count alone, before any evidence is read, so the pull request was blocked. Blocking removes the request labels, including `agent:in-progress` — and reconciliation only looked at pull requests carrying `agent:in-progress` or a recovery receipt. The pull request became invisible to the thing that had just blocked it.

Nothing else could reach it. `/deadloop-abandon-attempt` refuses on two independent guards: the target is unsafe while `agent:blocked` is present without its request label, and the journal cannot prove a workspace opened before agent start. `releasesAttemptOwnership` does not treat `launch_failed` as releasing, so the journal keeps its claim for good.

PR #228 reached this state, with a completed review beside it holding a `human_required` report that [ADR 0021](0021-a-human-required-review-is-a-completed-review.md) had just made deliverable.

## Decision

An attempt whose launch failed before it opened a workspace does not hold work authority, and reconciliation releases it.

The launch is what opens the workspace, so a launch that failed while the journal was still at `prepared` or `github_claimed` left nothing for the runtime to hold: nothing to observe, nothing to close, and no route back to the pull request. That is the proof ADR 0019 asks for — that the attempt cannot act on the current work — available from the journal alone. ADR 0019 also required a waiting Agent request before releasing, and placed release in the claim rather than the reconciler. Both are set aside here: there is no request to wait for on a pull request whose block removed them all, and the claim never runs for an attempt that never launched. The release records the reason `never_launched`, so the journal says why its ownership ended while the launch error stays as evidence.

A launch failure that already held a workspace keeps its ownership. That workspace still has to be accounted for, and `/deadloop-abandon-attempt` is the operation that accounts for it.

Reconciliation also selects any pull request it holds an attempt journal for, not only those carrying `agent:in-progress`. Local state naming a pull request is a reason to look at it. Selecting on the label alone meant a pull request disappeared at the moment reconciliation blocked it, which is when it still owes an answer.

## Consequences

One failed launch can no longer make a pull request permanently ambiguous.

The handoff beside it is not thereby delivered. A completed attempt whose claim required `agent:in-progress` cannot reauthorize once a block has removed it, so its completion handler still refuses — measured, and covered by a test, rather than left to be rediscovered live. That gate belongs to the claim layer ADR 0020 removes.

A blocked pull request is reconciled again on every tick for as long as an attempt journal names it. That is more observation and no new mutation: reconciliation either confirms, blocks — idempotently, as it has already done — or releases. Once the surviving attempt closes, its journal releases ownership and the pull request stops being selected.

Nothing here argues for keeping work authority. When ADR 0020's removal lands, this decision goes with the subsystem it patches.
