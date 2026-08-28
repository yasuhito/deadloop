# ADR 0034: Host workflows plan as calculations and execute steps through one executor

## Status

Accepted. Extends [ADR 0033](0033-host-run-workflows-are-called-in-process.md) and takes over the follow-ups it deferred (observations passed by value, outcome unions). Vocabulary: `CONTEXT.md` (観測 / 計画 / 処置 / 前提 / 実行係 / 受領書 / 計画確認). The PRD and implementation issues are written after ADR 0033 stage 4 lands, when file locations are final.

## Context

After ADR 0033 the Automation host calls four workflow functions in-process, but each still interleaves observing the world with changing it. `consumeRequestEvent` re-reads the GitHub timeline six times between label removals and additions; the merge path runs `gh pr view` four times and `assertCurrentPrEligible` three times around `gh pr merge`; `automation-runner` saves `state.json` more than ten times per run while mutating the entry in place; the `/deadloop-status` snapshot calls `git` and deletes a stale base-blocking record; `attempt.json` is written from separate processes by the host and by agent-run finalizers with a fixed `.tmp` name and no lock; `gh` is invoked directly in 28 of the 29 files that mention it, there is no `git` or state-directory adapter, and 37 of 134 tests spawn a driver with `--fixture` and assert on stdout.

Read through *Grokking Simplicity* (Normand), the truly concurrent timelines are the host tick, Herdr agents, manual commands, other pi sessions sharing the state directory, and humans on GitHub. ADR 0033 shortens the host timeline — fewer steps, fewer shared resources — and cannot reduce the others. What remains is to pull calculations out of actions and to stop sharing what need not be shared.

## Decision

**Observation, plan, execution.** Each host workflow is three functions. `observe(adapters)` reads GitHub, git, the execution runtime, and the state directory once, immediately before planning, and returns an observation value; it is taken again per workflow, never shared across a tick and updated in memory. `plan(observation)` is a calculation: it reads and writes nothing, and the same observation yields the same plan. `execute(plan, adapters)` is the executor.

**A plan is complete and conditional.** A plan lists every step the workflow intends for this tick. Each step is one domain-level operation named in `CONTEXT.md` — request consumption, launch, block, merge, human handoff, cleanup, journal advance — with a precondition such as the request generation, the head revision, or a label's presence. The executor re-checks the precondition immediately before each step. On a mismatch it stops, records the step and the reason, and the workflow observes and plans once more within the same tick; a second mismatch is recorded and left to the next tick. Steps never reference the result of an earlier step; the sequence inside a step (runtime call, journal record, label transition order) belongs to the executor.

**One executor, one catalogue.** A single executor serves all workflows. Its catalogue of step kinds is the complete list of what deadloop does to the world outside itself, and each kind is marked whether an agent-run script may execute it. Agent-run finalizers use the same observe / plan / execute shape with only *push* and *receipt* permitted; that mark is ADR 0015's worker trust boundary as a table, and a test enforces it.

**Local state is not a step.** Plans hold only steps that change the world outside deadloop. The attempt journal is written inside a step, preserving ADR 0032's order (record, then remove the request label). `state.json` is written once at the end of a tick from the outcome the workflow returns. The attempt journal has one writer, the host: agent-run scripts leave a write-once receipt, and the host observes receipts and advances the journal as a step.

**Adapters are the only actions.** `child_process` and `fs` appear only in `src/adapters/` — GitHub, git, execution runtime, state store — and in the three agent-run CLI shells. A test enforces this with an allowlist of current violators that may only shrink. Retries, timeouts, and re-observation are adapter concerns; `plan` never sees them.

**Observation never writes.** `status` and `doctor` render observations. The base-blocking cleanup that today runs from the status snapshot becomes a cleanup step of `reconcile`.

**Plans are visible locally only.** Every plan and every step result is written to host-log; nothing about a plan is posted to GitHub. `/deadloop-plan` (計画確認) runs `observe` and `plan` with a no-op executor, takes no lock and no execution authorization, and is a different operation from the one-shot tick.

**Tests compare plans.** The primary tests call `plan` with an observation value and compare the returned plan. Executor tests use in-memory adapters and check one recorded write. Fixture-driven driver tests are deleted as each scenario is rewritten. One real attempt on a restarted host remains the acceptance gate of every stage.

**Order.** ADR 0033 stages 2–5 complete first; stages 2 and 4 additionally split each moved workflow into `observe` / `plan` / `execute` at the existing seams without changing behaviour, so this ADR does not move files again. Workflows are then converted in this order: `reconcile`, `advanceAttempt`, `reviewPullRequest`, `coordinateIssue`.

## Considered and rejected

- Planning one step at a time and re-observing between steps: keeps reads next to writes, but loses the preview and the value-comparison tests that motivate the change.
- One observation per tick shared by all workflows and patched in memory after each step: fastest, but duplicates the knowledge of each step's effects in the executor and in the patch.
- A dry-run flag on `/deadloop-run-once`: the one-shot tick is defined by taking the lock and running once, and the glossary already excludes dry-run from it.
- One executor per workflow: the eight duplicated identity checks and eighteen "open and head matches" checks come from exactly that.
- Reactive cells and watchers, pervasive higher-order wrappers, a repository-wide `Result` type: the tick is a linear pipeline with no centre of cause and effect; not adopted.

## Consequences

- Step kinds and step results are union types by construction; the 84 `driverAction` strings and 91 `reason` strings named in ADR 0033 disappear with them, which resolves the architecture review's candidate 2 as a by-product.
- ADR 0028's permission to consolidate redundant observations becomes structural: one observation per workflow, and precondition checks are the only reads between steps.
- The fixed `.tmp` name and the lock-free dual writers of `attempt.json` go away with the single-writer rule. The enablement file lock stays for the push that agent-run finalizers perform.
- #328 (an attempt that could not launch shows no reason) is served by the plan and step records in host-log, which `doctor` and `status` read.
- Until a workflow is converted, its behaviour is unchanged; the allowlist test shrinks one file at a time alongside ADR 0033's stages.
