# ADR 0011: Guarded PR merge-conflict recovery

## Status

Accepted

## Decision

Before starting normal PR review, deadloop compares the selected PR head with the freshly fetched configured base head. If merging those exact commits conflicts, it starts one dedicated branch-update worker in the existing PR branch worktree. The worker merges the base into the PR branch; rebasing and history rewriting are prohibited.

An HTML comment records a deterministic key derived from the exact PR-head/base-head pair. That pair gets at most one update attempt; a change to either commit creates a new key and may be tried once. `agent:review` is retained and `agent:reviewing` is retained or added while the update runs. No branch-update label is introduced.

The worker may push only through the deterministic finalizer. The finalizer requires the updated commit to contain both selected commits, runs the configured project check, requires a clean worktree, immediately re-reads the open same-repository PR head, and uses a normal non-force push to update only the driver-selected existing branch. A changed PR head returns `stale_head` without updating, commenting, or changing labels. Normal Git fast-forward enforcement is the final race guard and never replaces a concurrently updated head.

A successful push leaves review labels unchanged so a later cycle resumes normal review. A stale head also leaves them unchanged for re-evaluation. Only a failed, malformed, or unsafe update adds `agent:blocked`; branch-update workers and monitors may not create PRs, merge PRs, change labels themselves, close issues, or delete branches.

## Consequences

Recovery is intentionally limited to same-repository PRs whose branch deadloop can open and push. The base can advance during an attempt; the completed update still binds to the selected base commit, and the newly observed head/base pair can be evaluated on the next cycle. Persistent comments make the one-attempt rule survive process restarts.
