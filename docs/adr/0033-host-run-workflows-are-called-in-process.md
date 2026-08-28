# ADR 0033: Host-run workflows are called in-process; subprocesses remain only at the agent seam

## Status

Accepted. Amends [ADR 0004](0004-agent-launcher.md), [ADR 0005](0005-deadloop-module-seams.md), and [ADR 0017](0017-code-snapshot-as-execution-supply.md). Design record: `docs/in-process-workflows-prd.md`.

## Context

The Automation host kept the process shape of its model-driven origin after ADR 0029 removed the model from every host-run decision. A tick runs a `bash` precheck, a `node` driver returning a JSON action, and — on a path that `src/automation-runner.ts` can no longer reach once `driverFile` is set — a prompt injection. Reconcilers, completion handlers, and finalizer helpers are further `node` processes started by the host or by each other, exchanging input as argv flags, `DEADLOOP_*` environment variables, and files under the state directory, and output as JSON on stdout.

Both ends of that seam are deadloop itself. A seam with one adapter varies nothing and costs what this one costs: facts re-observed in every process (about six live contract resolutions per push, eleven or more `gh pr view` calls per merge), outcomes carried as 84 untyped `driverAction` strings and 91 `reason` strings, a CommonJS requirement that produced four `.ts` / `.cjs` twin implementations and seven type sidecars, a call graph the type checker cannot see, tests that spawn drivers with `--fixture` and read stdout, and `1 + O(retained run dirs)` reconciler processes per tick.

The seam that does have two adapters is the one between the host and a launched agent: `run-project-check`, `pr-review-repair-finalize`, and `pr-branch-update-finalize` are executed by the agent inside its own session, from the code snapshot ADR 0017 supplies.

ADR 0005 chose use-case workflows as the primary interface and named `coordinateIssue` and `reviewPullRequest` as the first extraction. None of its identifiers exist in the code.

## Decision

The Automation host calls host-run work as functions of one deep module in `src/workflows/`:

```ts
reconcile(project, invocation)
coordinateIssue(project, invocation)
reviewPullRequest(project, invocation)
advanceAttempt(attemptId, invocation)
```

This is ADR 0005's interface with two changes: reconciliation ([ADR 0032](0032-github-is-the-workflow-state-source-of-truth.md)) is a per-tick step that precedes selection and is exposed on its own; `advanceImplementation` and `advanceReview` are one role-agnostic `advanceAttempt`, because ADR 0029 made monitoring model-free and role-independent with role-specific completion handlers.

The host starts no `node` child process for its own work. Precheck scripts, prompt files, the prompt-injection path, and every host→host spawn are removed. `driverFile` becomes `kind`; `promptFile`, `precheckFile`, and `precheckTimeoutSeconds` are removed, and leftover keys are configuration errors.

Launched agents are unaffected: Workers, explorers, reviewers, repair and branch-update agents remain separate Herdr sessions with their own model context. "In-process" describes a Node.js process boundary inside deadloop, not the model's context window.

Subprocesses remain only where an agent runs a deadloop script inside its own session. Those three scripts are thin CLI shells in `extensions/deadloop/automations/` over modules in `src/`; the host's Worker completion path calls the same modules.

Four properties of the subprocess seam are re-homed rather than lost:

- **Code identity.** Host-run code is the host's loaded module graph, which comes from the checkout at load time. ADR 0016's identity guard refuses to start a tick when the checkout has moved, so host code and the code snapshot are the same commit whenever a tick runs. The snapshot supplies agent-run scripts only; every agent-facing path is derived from the supply passed as an argument, never from `__dirname`, and a test enforces this.
- **Isolation.** One boundary in `src/automation-runner.ts` catches whatever a workflow throws and records `driver_error`, exactly as a non-zero exit did. Wall-clock kills of whole processes are dropped; the retained property is that every external command has a timeout in its adapter.
- **Exclusion.** The enablement lock is acquired once, asynchronously, at the entry of each mutation-bearing section and passed inward as a held token. The file lock stays because agent-run finalizers take it from another process. The meaning of `/deadloop-disable` — it waits for an in-flight mutation — does not change.
- **Test seam.** The `--fixture` JSON becomes an in-memory adapter injected through the invocation; production code carries no fixture branch.

When no host-run module is executed by bare `node`, the package moves to `"type": "module"` and ESM `.ts` throughout; the extension-declared CommonJS rule of ADR 0004 ends with the last spawn.

## Consequences

- Duplication that existed only to cross the process boundary — twin implementations, type sidecars, argv marshalling, stdout JSON parsing, per-process journal re-reads and Herdr preflights — is deleted, not maintained.
- Later refactors can pass observations by value (ADR 0028 permits consolidating redundant observations without an intervening external operation) and can declare outcome types as unions; this decision does not do either.
- A completion handler runs the host's current code instead of the snapshot path stored in a retained handoff, which resolves #373.
- Cross-process exclusion still matters for agent-run finalizers; the enablement file lock is kept for them.
- `projects.json` written for the driver-file model stops loading with a clear configuration error; there is no migration path.
