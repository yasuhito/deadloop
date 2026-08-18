# ADR 0011: Guarded PR merge-conflict recovery

## Status

Accepted

## Decision

A review that finds the selected PR head conflicting with its base does not recover the conflict from its own state. It consumes the review request and adds `agent:update-branch`, so the next action is visible on GitHub. A later cycle claims that request, compares the PR head with the freshly fetched configured base head, and starts one dedicated branch-update worker in the existing PR branch worktree. The worker merges the base into the PR branch; rebasing and history rewriting are prohibited.

An HTML comment records a deterministic key derived from the exact PR-head/base-head pair. That pair gets at most one update attempt; a change to either commit creates a new key and may be tried once. The claim of the `agent:update-branch` request holds `agent:in-progress` while the update runs. A branch-update request that is no longer needed is consumed with a readable explanation and returns the head to `agent:review` without launching an agent.

The worker may push only through the deterministic finalizer. The finalizer requires the updated commit to contain both selected commits and an authenticated passed verification record bound to the exact output commit and fixed project-check contract. It may reuse only a fully matching authenticated record; otherwise it runs the fixed check and persists a new authenticated record. It requires a clean worktree, immediately re-reads the open same-repository PR head, and updates only the driver-selected existing branch after verifying that the destination still equals the selected PR head. A changed, rewound, or deleted PR head returns `stale_head` without updating, commenting, or changing labels.

That final verification and the push itself are separate operations, so the push has to carry the verified head instead of trusting it. The finalizer therefore binds the push to the selected old object ID with `git push --force-with-lease=refs/heads/<branch>:<verified head>`. This expected-object-ID lease is the only force variant deadloop permits, and it is permitted only because the finalizer has already proved that the candidate contains the verified head, so the lease can only fast-forward and never rewrites history. Any remote change after the verification — including an advance to a commit the candidate already contains — breaks the lease, and the finalizer then reports `stale_head` without pushing. Force without a lease stays prohibited everywhere, and the worker's own guarded push remains a plain non-force push.

A successful push is turned into a new `agent:review` request by a deterministic completion handler that re-observes the pushed head under the same claim. A stale head leaves the claim state unchanged for re-evaluation. Only a failed, malformed, or unsafe update adds `agent:blocked`; branch-update workers and monitors may not create PRs, merge PRs, change labels themselves, close issues, or delete branches.

## Consequences

Recovery is intentionally limited to same-repository PRs whose branch deadloop can open and push. The base can advance during an attempt; the completed update still binds to the selected base commit, and the newly observed head/base pair can be evaluated on the next cycle. Persistent comments make the one-attempt rule survive process restarts.
