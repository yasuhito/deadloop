# deadloop extension internals

This directory contains the Pi extension implementation for **deadloop**.

Read the root `README.md` and `docs/public-package-setup.md` for normal setup.

## Local configuration

Configuration lookup order:

1. `DEADLOOP_CONFIG`
2. `~/.pi/agent/deadloop/projects.json`
3. this directory's `projects.json` for local development only

Do not commit `projects.json`; it contains local paths and rollout choices.

When the current git repository has `deadloop.json` on the trusted base branch, deadloop can infer the project without a `projects.json` entry. Each project overlays inferred or explicit local config, trusted base-branch repo policy, and package defaults. Standard labels, verification command inference, worker instruction files, and the issue coordinator / PR reviewer automations come from package defaults unless explicitly overridden. The repo policy file is `deadloop.json`. Repo policy is read only from the trusted `baseBranch` after `git fetch`, never from the PR branch being reviewed.

## State

Runtime state and locks live under `~/.pi/agent/deadloop/`. Per-launch prompts and promise reports live under `~/.pi/agent/deadloop/runs/<uuid>/`, outside target worktrees.

Worker, reviewer, and monitor prompts run the configured project check through `run-project-check.ts`. The wrapper temporarily isolates untracked `.deadloop` and `.pi-subagents` from recursive project tooling, then restores them after success, failure, timeout, or interruption. Tracked project files are never hidden; if either runtime directory contains a tracked file, validation fails closed instead.

## Commands

```text
/deadloop-status
/deadloop-doctor
```

## Deterministic drivers

Each automation may define a `driverFile`. Drivers run after precheck and before any prompt is sent, with `DEADLOOP_*` environment variables. They return JSON with `action` values `skip`, `done`, `needs_llm`, or `error`.

- `issue-coordinator-driver.ts` handles cleanup, candidate selection gates, worker launch, and bounded monitor handoff.
- `pr-reviewer-driver.ts` handles no-op, pending CI, external review gates, draft gates, reviewer launch, and bounded monitor handoff.
- `ci-fallback-decision.ts`, `worker-watch-decision.ts`, and related helpers keep deterministic checks out of prompts.

## Runner boundary

v0 uses Herdr for worktrees, tabs, and agent sessions. Herdr-specific code should remain behind runner/automation boundaries so future runners can be added without changing GitHub Issue / PR state semantics.
