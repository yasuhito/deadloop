# ADR 0018: GitHub Agent requests recover runtime failures

## Status

Accepted

## Context

An agent can stop before writing its completion report, including when a host write fails with `ENOSPC` or `EDQUOT`. Retaining only local attempt state leaves GitHub at `agent:in-progress`, hides the failure from users, and currently requires a separate `/deadloop-abandon-attempt` recovery interface. Predicting each repository's required free space or redirecting per-attempt temporary storage through the current Herdr worktree launch path would add unreliable policy or require a larger execution-runtime change.

## Decision

Deadloop does not predict minimum free space and does not add per-attempt `TMPDIR` management in this change. A completion report or deterministic host operation that reports `ENOSPC` or `EDQUOT` produces a storage-exhaustion failure. If an agent is confirmed stopped and a final re-read finds no completion report, deadloop records a generic technical failure; terminal text may appear as local diagnostic evidence but does not determine the cause.

For every locally launched role, deadloop revalidates the exact target revision and current Agent request, posts one idempotent human-readable failure comment, and then replaces the active managed state with `agent:blocked`. Public comments omit local paths and internal runtime details. A changed target or request prevents both mutations. Deadloop does not automatically retry either failure class.

GitHub Agent requests are the recovery interface. Adding a new role-appropriate request such as `agent:implement`, `agent:review`, or `agent:update-branch` while work is blocked asks deadloop to reconcile the retained attempt and start a new attempt. Deadloop preserves both `agent:blocked` and the queued request until it proves the old agent stopped, the retained workspace is owned by that attempt, the target revision and request remain current, and the new claim succeeds. Closing or merging the target permits the existing terminal cleanup path. Without either event, the retained attempt and workspace remain available for investigation.

After label-driven reconciliation covers every failure path, deadloop removes `/deadloop-abandon-attempt` rather than retaining a second workflow-control interface. Doctor remains read-only and shows the GitHub command that adds the appropriate Agent request.

## Consequences

- Runtime failures become visible on the Issue or pull request instead of remaining only in local state.
- GitHub labels remain the sole workflow-control interface; local commands do not restart or abandon attempts.
- A blocked target can retain local runtime artifacts indefinitely until a new Agent request or target closure permits safe cleanup.
- Disk exhaustion can still occur because this decision reports and stops observed failures rather than reserving or isolating storage.
- A future execution runtime with explicit environment propagation may add owned temporary-storage isolation under a separate decision.
