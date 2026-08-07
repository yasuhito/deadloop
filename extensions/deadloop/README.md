# deadloop extension internals

This directory contains the Pi extension implementation for **deadloop**.

Read the root `README.md` and `docs/public-package-setup.md` for normal setup.

## Local configuration

Configuration lookup order:

1. `DEADLOOP_CONFIG`
2. `~/.pi/agent/deadloop/projects.json`
3. this directory's `projects.json` for local development only

Do not commit `projects.json`; it contains local paths and rollout choices.

`deadloop.json` is an optional shared policy and `projects.json` is an optional local override; neither enables scheduling. `/deadloop-enable` resolves explicit required verification, journals a temporary Git worktree before creating it at the trusted base revision, and stores its record and log outside the repository. It does not use Herdr or start an agent for this preflight, and it removes only a proven-owned, revision-matched, clean temporary worktree. The command records execution permission in `~/.pi/agent/deadloop/enabled-projects.json` only after the baseline check passes and repository identity, primary checkout status, GitHub authentication, write permission, and missing-label creation succeed. Each project overlays inferred or explicit local config, trusted base-branch repo policy, and package defaults. A later enablement reuses only a passed record whose repository, target commit, command, source identity, and base revision all match. `/deadloop-doctor` shows the journal, record, log, revision, path, and read-only confirmation command for every verification worktree retained after cleanup could not be proven safe. `/deadloop-disable` removes only that permission and lets running agents finish their promise reports. The repo policy file is `deadloop.json`. Repo policy is read only from the trusted `baseBranch` after `git fetch`, never from the PR branch being reviewed.

## State

Runtime state and locks live under `~/.pi/agent/deadloop/`. Per-launch prompts, promise reports, and atomic attempt journals live under `~/.pi/agent/deadloop/runs/<uuid>/`, outside target worktrees. New writers emit only strongly bound V1 reports; legacy reports remain inspection-only evidence.

Worker, reviewer, and monitor prompts run the configured project check through `run-project-check.ts`. The wrapper temporarily isolates untracked `.deadloop` and `.pi-subagents` from recursive project tooling, then attempts to restore them after success, failure, timeout, or interruption. If restoration fails, it retains the quarantine and temporary worktree, records both paths, and exposes them through `/deadloop-doctor`. Tracked project files are never hidden; if either runtime directory contains a tracked file, validation fails closed instead.

A Worker or reviewer attempt stores its resolved required-verification contract in `attempt.json` before the GitHub claim and keeps a host-persisted launch snapshot outside that attempt's run directory. Worker completion runs the fixed contract against the reported output commit; reviewer approval runs it against the fixed PR head. Both write authoritative records outside the worktree. Worker write gates and reviewer approval, successful human handoff, and merge gates reject missing, failed, mismatched, empty, or stale-policy evidence, while `changes_requested` and `human_required` remain reportable without success. Agent-reported additional validations remain non-authoritative evidence. These gates assume an instruction-following but fallible Worker; same-user hostile-process containment requires execution-runtime isolation that the Pi + Herdr support path does not currently provide. See [ADR 0015](../../docs/adr/0015-worker-trust-boundary.md).

## Commands

```text
/deadloop-enable
/deadloop-disable
/deadloop-status
/deadloop-doctor
/deadloop-abandon-attempt <attempt-id>
```

## Deterministic drivers

Each automation may define a `driverFile`. Drivers run after precheck and before any prompt is sent, with `DEADLOOP_*` environment variables. They return JSON with `action` values `skip`, `done`, `needs_llm`, or `error`.

- `issue-coordinator-driver.ts` handles cleanup, candidate selection gates, worker launch, and bounded monitor handoff.
- `pr-reviewer-driver.ts` handles no-op, pending CI, external review gates, draft gates, one-attempt merge-conflict recovery, reviewer launch, and bounded monitor handoff.
- `pr-review-repair-dispatch.ts` consumes completed reviewer outcomes. Actionable findings launch one dedicated repair worker; technical reviewer failures retry once for the exact head, while repeated findings and human-required outcomes add `agent:blocked` with recovery guidance.
- `pr-review-repair-finalize.ts` is the repair worker's only push path. It measures repair breadth before running configured checks; an oversized repair skips the checks, is not pushed, and is handed to a human. Within the size limit, it runs configured checks and conditionally updates the verified selected branch only while its head equals the validated commit. It writes a finalizer receipt outside the worktree.
- `pr-review-comments.ts` renders idempotent human-readable review and repair-result comments. `pr-review-repair-complete.ts` posts repair success only when the structured worker promise, finalizer receipt, and live new head agree. Successful repair releases `agent:reviewing` while preserving `agent:review`, so the next selection records `repair_rereview`; conflict recovery carries that provenance to its updated head, and an abandoned active claim still records `stale_reclaim`. Stale results preserve both review labels for re-evaluation.
- `merge-reviewed-pr.ts` accepts only a validated reviewer approval bound to the expected head, then immediately re-fetches the PR and requires successful reported CI checks plus confirmed clean mergeability before its head-guarded mutation. Missing, pending, failed, or ambiguous gates stop automatic merge.
- Merge-conflict recovery keeps `agent:review` and `agent:reviewing`, records the exact PR-head/base-head attempt in a PR comment, and uses `pr-branch-update-finalize.ts` as the only permitted push path. Stale heads stop without a push; only failed or unsafe updates add `agent:blocked`.
- `ci-fallback-decision.ts`, `worker-watch-decision.ts`, and related helpers keep deterministic checks out of prompts.

## Runner boundary

v0 requires stable Herdr 0.7.5 or newer. The host checks the client, server, and protocol at startup and before every tick, before candidate selection or a mutation-capable driver.

Each Worker, reviewer, review-repair, or branch-update attempt uses one fresh workspace with the worktree's first tab and root pane. The launcher starts the configured agent directly in that root pane; it never creates a tab, splits a pane, replaces a same-name agent, or reuses a terminal. If that new root pane returns the exact structured `agent_pane_busy` pre-start error while its shell is still initializing, the runner retries the identical request every 100 ms within a 5-second monotonic grace period; each request has a 35-second wrapper timeout, and all other or persistent failures retain the workspace. Successful strongly bound attempts close only their workspace after role-specific GitHub persistence, while the linked worktree remains until the existing merged/closed-PR cleanup gate. Blocked, human-required, legacy, malformed, launch-failed, and ambiguous attempts remain visible and suppress another launch on the same checkout.

`/deadloop-doctor` reports compatibility, retention, and cleanup-pending findings without closing anything. For a Worker or reviewer `launch_failed` attempt, it prints `/deadloop-abandon-attempt <attempt-id>` only when the unchanged target, clean input revision, one owned disposable workspace, retained linked worktree, and absence of an agent in the recorded pane are all proven. That explicit operation holds the enablement lock, re-proves the same facts, closes only the attempt workspace, records the terminal `abandoned` evidence in the original journal, preserves the linked worktree, and then requeues the Issue or PR. Immediately before closing, the operation writes a bound `workspace_close_started` receipt beside the original journal. A retry after an interrupted close may continue only when that receipt matches and the recorded workspace and every workspace for the same checkout are confirmed absent. If any proof is missing, doctor requires manual review and prints no partial label-only recovery command. A requeued Worker opens the exact retained abandoned checkout in a fresh workspace instead of trying to create a duplicate linked worktree. Herdr-specific code remains behind runner/automation boundaries so future runners can be added without changing GitHub Issue / PR state semantics.
