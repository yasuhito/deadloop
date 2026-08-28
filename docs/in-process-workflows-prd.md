# Host-run workflows called in-process

## Problem

The Automation host still has the shape it had when a model in the Pi session did the coordination: every tick runs a `bash` precheck, then a `node` driver that prints a JSON action, and would then inject a prompt. ADR 0029 and #368 removed the model from monitoring, and the drivers now decide everything, but the process shape stayed. The prompt files and the `sendUserMessage` path are unreachable (`src/automation-runner.ts:458-561` returns before `:636-676` whenever `driverFile` is set), and every host-run step — driver, reconciler, completion handler, finalizer, sibling script — is a separate `node` process that receives its input as 10–16 argv flags, `DEADLOOP_*` environment variables, and files under the state directory, and returns a JSON string.

That seam has one adapter (host calling host), so nothing varies across it, and it is the common cause of most of the duplication the architecture review found:

- Facts cannot cross a process boundary as values, so each process re-observes them: `assertCurrentWorkerContract` runs about six live `git fetch` + `gh repo view` rounds per push, `gh pr view` runs eleven or more times per merge, `rev-parse HEAD` appears at 20 sites and `hasUncommittedWork` at 18.
- Outcomes cross the boundary as strings: 84 distinct `driverAction` literals at 149 sites and 91 `reason` literals, none declared as a union type.
- Drivers must run under bare `node`, which forces CommonJS, which forced four `.ts` / `.cjs` twin implementations (`attempt-lifecycle.ts` has 821 lines and no production caller) kept in sync by a parity test, plus seven `*-types.ts` sidecars.
- The call graph is invisible to the type checker: three modules spawn sibling modules with flag lists; 37 of 134 tests spawn a driver with `--fixture` and assert on stdout; the fixture branch lives inside production code.
- One tick spawns `1 + O(retained run dirs)` reconciler processes, each re-reading the same journals and re-running the Herdr preflight.
- Wall-clock kills (90 s, 15 min, 15 s) exist because subprocesses made them cheap, not because a requirement asked for them.

ADR 0005 already chose use-case workflows as the primary seam and listed "separate `coordinateIssue` and `reviewPullRequest` from the current driver" as the first consequence. That work was never started; the identifiers do not appear in the code.

## Goals

- The Automation host starts no `node` child process of its own. Host-run work is a function call into one deep module with the interface `reconcile`, `coordinateIssue`, `reviewPullRequest`, `advanceAttempt`.
- The only remaining subprocess seam is the one with two adapters: scripts an agent runs inside its own session (`run-project-check`, `pr-review-repair-finalize`, `pr-branch-update-finalize`).
- Every stage is behaviour-preserving on its own and is verified with one real attempt before the next stage starts.
- Remove the unreachable prompt path, the precheck scripts, and their configuration and documentation.
- End with one module format: `"type": "module"` and ESM `.ts` everywhere, no `.cjs` / `.cts` twins, no type sidecars.

## Non-goals

- Folding any LLM work into the host process. Workers, explorers, reviewers, repair and branch-update agents remain separate Herdr sessions with their own context; "in-process" refers to deadloop's own plumbing (a Node.js process boundary), not to the model's context window.
- Changing what the workflows decide. Selection, gates, label transitions, compare-and-swap pushes, required verification, and the meaning of `/deadloop-disable` stay as they are.
- Replacing `throw` with a Result type, merging the three driver skeletons into one pipeline, or collapsing the 84 outcome strings into one union (architecture review candidate 2).
- Moving finalization from the agent to the host (candidate 2) or replacing the held enablement lock with a generation compare (a separate ADR).
- Removing the automation entries from `projects.json` (candidate 6).
- Reworking the attempt journal's ownership (candidate 3), the observation-once refactor (candidate 4), or unifying verification records and the GitHub adapter (candidate 5). Stage 4 takes only the parts of candidate 5 that the fixture-to-adapter step needs.

## Proposed shape

`src/workflows/` holds the deep module. `extensions/deadloop/index.ts` and `src/scheduler-tick.ts` call it directly:

```ts
interface DeadloopWorkflows {
  reconcile(project: NormalizedProject, invocation: HostInvocation): Promise<ReconcileOutcome>;
  coordinateIssue(project: NormalizedProject, invocation: HostInvocation): Promise<DriverResult>;
  reviewPullRequest(project: NormalizedProject, invocation: HostInvocation): Promise<DriverResult>;
  advanceAttempt(attemptId: AttemptId, invocation: HostInvocation): Promise<AttemptAdvanceOutcome>;
}
```

`HostInvocation` carries what the environment variables and argv carried before: the execution supply (ADR 0017 snapshot paths for agent-facing scripts), the adapter set (`github`, `herdr`, `git`, clock), the enablement check, and the host log sink. It differs from ADR 0005 in two documented ways: reconciliation (ADR 0032) is a per-tick step that precedes selection and is exposed separately; `advanceImplementation` and `advanceReview` are one role-agnostic `advanceAttempt` because ADR 0029 made monitoring model-free and role-independent with role-specific completion handlers.

Rules that hold at the end of every stage:

- **Code identity.** Host-run workflow code is the host's loaded module graph. ADR 0016's identity guard already refuses to start a tick when the checkout has moved, so host code and the snapshot are the same commit whenever a tick runs. Agent-facing paths are built from `supply.automationDir` passed as an argument; a test forbids deriving an agent-facing path from `__dirname`.
- **Error boundary.** `runConfiguredDriver` in `src/automation-runner.ts` is the one place that catches; a thrown error becomes `driver_error` on the automation entry and a warning, exactly as a non-zero exit did. Every in-process call is awaited inside that boundary.
- **Timeouts.** Wall-clock process kills are dropped. The property kept is that every external command (`git`, `gh`, `herdr`, the verification command) has its own timeout in its adapter.
- **Enablement lock.** Each mutation-bearing section (launch, push, label transition) acquires the enablement lock once, asynchronously, at its entry and passes a held token inward; inner helpers never re-acquire. The file lock remains because agent-run finalizers take it from another process. `Atomics.wait` busy-waiting is replaced by awaited polling. `/deadloop-disable` still waits for an in-flight mutation.
- **Tests.** The `--fixture` JSON becomes an in-memory adapter injected through `HostInvocation`; production code loses its `if (fixture)` branch. The first stage keeps the fixture as a function argument so that behaviour is unchanged; later stages convert one seam at a time.
- **Configuration.** `driverFile` becomes `kind: "issue-coordinator" | "pr-reviewer"`. `promptFile`, `precheckFile`, and `precheckTimeoutSeconds` are removed. Leftover keys are configuration errors, not migrated (AGENTS.md: no backward-compatibility paths).

## Rollout plan

Each stage is one issue and one PR. A stage is accepted only after one real attempt (for example a review of an open PR in this repository) has run through the changed path on a restarted host.

0. **Record the design.** This PRD; ADR 0033; amendments to ADR 0004 (module format), ADR 0005 (interface), ADR 0017 (host code origin); `CONTEXT.md` entries for code snapshot and agent-run script.
1. **Delete the unreachable path.** Prompt files, the send path and its deps (`sendUserMessage`, `sendUserMessageIfEnabled`, `isIdle`, `hasPendingMessages`), their result codes, both `precheck.sh` scripts and the `precheckFile` / `promptFile` / `precheckTimeoutSeconds` configuration, and the README host-contract text. The precheck's early skip becomes the first branch of each workflow.
2. **Drivers in-process.** `git mv` the two drivers into `src/workflows/`, export `coordinateIssue` / `reviewPullRequest` returning the existing `DriverResult`, replace `process.env` transport with an injected config object and `SCRIPT_DIR = __dirname` with `supply.automationDir`, add the `__dirname` test, replace `driverFile` with `kind`, make the enablement lock async and section-scoped, keep the fixture as an argument.
3. **Reconcilers in-process.** `reconcile(project)` replaces the four spawned reconcilers and the closing `complete-attempt-workspace` / `complete-issue-exploration` / abandon calls in `index.ts:1559-1802`; the 90 s / 15 min / 15 s kills go away.
4. **Completion chain in-process.** `advanceAttempt` replaces `runDeterministicCompletion`'s spawn and the chain it starts (`run-worker-required-verification`, `guarded-push`, `guarded-worker-pr`, `persist-attempt-result`, `complete-attempt-workspace`, `ci-fallback-gate`), the driver-spawned siblings (`pr-review-repair-dispatch` launch, `reconcile-report-received-attempt`), and `launch-agent`. Finalization becomes one shared module; the two finalizers and `run-project-check` remain as thin CLI shells over it. Fixture branches become injected adapters. Completion now runs host code, which resolves #373.
5. **One module format.** `"type": "module"`, `.cjs` / `.cts` → `.ts`, delete the four twins (keep the typed `.ts`, confirm with the parity test first) and the seven `*-types.ts` sidecars, flip `test/module-format-portability.test.ts` to "no `module.exports` anywhere", `require.main === module` → `import.meta.main`. Accepted only with `npm pack --dry-run` clean and a session start on both the pi and omp hosts.

## Acceptance criteria

- `grep -rn "pi.exec(\"node\"\|spawnSync(\"node\"\|execFileSync(\"node\"" extensions/deadloop/index.ts src` finds nothing that starts a host-run deadloop module; the only `node` invocations of deadloop scripts are the three agent-run paths rendered into agent prompts.
- `extensions/deadloop/automations/` contains only `run-project-check`, `pr-review-repair-finalize`, `pr-branch-update-finalize`, and their prompt renderers' inputs; every other automation file has moved to `src/workflows/` or been deleted.
- `DeadloopWorkflows` is exported from `src/workflows/` with the four methods above and is the only entry the host uses.
- No `*.prompt.md`, no `*.precheck.sh`, no `promptFile` / `precheckFile` / `precheckTimeoutSeconds` / `driverFile` in `core.ts`, `projects.example.json`, `deadloop.json`, or the READMEs.
- No production module reads `DEADLOOP_*` environment variables; a test asserts it.
- No production module derives an agent-facing path from `__dirname`; a test asserts it.
- No `if (fixture)` branch in production code; every test that used `--fixture` calls the workflow with an injected adapter.
- `package.json` has `"type": "module"`; no `.cjs` or `.cts` under `src/` or `extensions/deadloop/`; the parity test and the type sidecars are gone.
- `npm test`, `npm run lint`, `npm run typecheck`, `npm pack --dry-run` pass; one real attempt completed through the in-process path on a restarted host for each of stages 2, 3, and 4.

## Implementation issues

The GitHub issues created from this PRD are intentionally not labeled `agent:implement`; stages 2 and 4 change the host's own execution path and are meant to be driven by a person with a restarted host at hand. Stages are ordered; each declares the previous one under `## Blocked by`.

- [#374](https://github.com/yasuhito/deadloop/issues/374) stage 0 — record the design (this PRD, ADR 0033, ADR 0004 / 0005 / 0017 amendments, `CONTEXT.md`)
- [#375](https://github.com/yasuhito/deadloop/issues/375) stage 1 — delete the unreachable prompt path and the prechecks
- [#376](https://github.com/yasuhito/deadloop/issues/376) stage 2 — drivers in-process as `coordinateIssue` / `reviewPullRequest`
- [#377](https://github.com/yasuhito/deadloop/issues/377) stage 3 — reconcilers in-process as `reconcile`
- [#378](https://github.com/yasuhito/deadloop/issues/378) stage 4 — completion chain in-process as `advanceAttempt`; finalizers become CLI shells over one shared module (resolves #373)
- [#379](https://github.com/yasuhito/deadloop/issues/379) stage 5 — one module format: `"type": "module"`, ESM `.ts`, twins and sidecars deleted
