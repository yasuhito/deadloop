# ADR 0011: Guarded PR merge-conflict recovery

## Status

Accepted

## Decision

A review that finds the selected PR head conflicting with its base does not recover the conflict from its own state. It consumes the review request and adds `agent:update-branch`, so the next action is visible on GitHub. A later cycle claims that request, compares the PR head with the freshly fetched configured base head, and starts one dedicated branch-update worker in the existing PR branch worktree. The worker merges the base into the PR branch; rebasing and history rewriting are prohibited.

An HTML comment records a deterministic key derived from the exact PR-head/base-head pair. That pair gets at most one update attempt; a change to either commit creates a new key and may be tried once. The claim of the `agent:update-branch` request holds `agent:in-progress` while the update runs. A branch-update request that is no longer needed is consumed with a readable explanation and returns the head to `agent:review` without launching an agent.

The worker may push only through the deterministic finalizer. The finalizer requires the updated commit to contain both selected commits, runs the configured project check, requires a clean worktree, immediately re-reads the open same-repository PR head, and updates only the driver-selected existing branch with a normal non-force fast-forward push after verifying that the destination still equals the selected PR head. A changed, rewound, or deleted PR head returns `stale_head` without updating, commenting, or changing labels.

A successful push is turned into a new `agent:review` request by a deterministic completion handler that re-observes the pushed head under the same claim. A stale head leaves the claim state unchanged for re-evaluation. Only a failed, malformed, or unsafe update adds `agent:blocked`; branch-update workers and monitors may not create PRs, merge PRs, change labels themselves, close issues, or delete branches.

## Consequences

Recovery is intentionally limited to same-repository PRs whose branch deadloop can open and push. The base can advance during an attempt; the completed update still binds to the selected base commit, and the newly observed head/base pair can be evaluated on the next cycle. Persistent comments make the one-attempt rule survive process restarts.
