# Stop codes: the reason vocabulary a person can act on

ADR 0020 removed work authority and left the `reason` code inventory behind. This note records the
2026-08 inventory pass and the reduced stop-code taxonomy issue #295 introduces.

## The reduced taxonomy

`src/stop-codes.cts` is the single source of truth. A stop code is published wherever deadloop stops
work and a person must decide what to do next. Every code names exactly one operation.

| Code | The one operation |
| --- | --- |
| `add_request` | Inspect the retained attempt evidence, then add a new Agent request. |
| `free_storage` | Free up storage on the machine running deadloop, then add a new Agent request. |
| `fix_environment` | Repair the local environment problem the stop comment names, then add a new Agent request. |
| `fix_verification_policy` | Resolve the required-verification policy or trusted base, run `/deadloop-enable`, then requeue with the command `/deadloop-doctor` prints. |
| `wait` | Take no action; deadloop resumes automatically. |

The code decides the action; the stop comment carries the cause as prose. A stop that could end in
two different operations is split before it is published (for example, a launch failure shaped like
storage exhaustion publishes `free_storage`, any other launch failure publishes `fix_environment`).

## Where each code is published

- `deadloop:work-authority-block` recovery markers and PR block comments
  (`src/pr-work-authority-reconciliation.cts`): `runtime_unobservable`, `completion_handoff_refused`,
  and `launch_unprepared` blocks fold into `add_request` / `free_storage` / `fix_environment` via
  `reconciliationStopCode`.
- `deadloop:terminal-monitor-stop` markers and stop comments
  (`extensions/deadloop/automations/contain-terminal-monitor.cts`): a storage stop publishes
  `free_storage`, a model-availability pause publishes `wait`, every other terminal stop
  (`active_work_timeout`, `invalid_completion_report`, missing report) publishes `add_request`.
- Blocked completion reports written by agents (`typed_reason_code` in prompts): the prompt names the
  four agent-usable codes; the `worker_blocked` fallback became `add_request`.

## What is deliberately not a stop code

These vocabularies decide deadloop's own next move or record evidence. Each value maps to one
internal operation, and none asks a person to choose between actions, so they stay:

- Monitoring dispositions and directives (`active_work_limit`, `model_availability`,
  `runtime_ambiguous`, `runtime_unreachable`, `terminal_without_report`, ...).
- Journal release evidence: `authorityRelease.reason` (`owner_absent`, `terminal_missing_report`,
  `runtime_timeout`, `never_launched`) and `abandonment.reason`. These are a persisted contract read
  by restart rules (a branch update that never launched does not spend its one attempt; one that ran
  and lost its report does). The human-facing surface for those stops is published at stop time with
  the reduced codes.
- Required-verification diagnosis reasons (`source_conflict`, `no_source`, `zero_targets`,
  `missing_base_revision`, `stale_policy`). Each already renders its own single recovery operation in
  the stop comment, so each satisfies the one-operation rule in place.
- Doctor finding types and `HerdrDoctorStatus`. A finding is a diagnostic report, and every finding
  carries its own commands.
- Selection-skip reasons, driver actions, runtime observation kinds, and review-transition reasons.

## Folds applied to the former inventory

| Former published code | Now |
| --- | --- |
| `runtime_unobservable`, `completion_handoff_refused`, `active_work_timeout`, `invalid_completion_report`, `missing_completion_report` / `terminal_without_report` (published form) | `add_request` |
| `storage_exhaustion`, storage-shaped `launch_unprepared` | `free_storage` |
| other `launch_unprepared` shapes | `fix_environment` |
| model-availability pause | `wait` |
| `worker_blocked` fallback | `add_request` |

Required-verification and trusted-base stops already name one operation each and keep their
diagnosis codes inside the comment body and doctor finding; the family's action is
`fix_verification_policy`.

## Marker compatibility

Stop markers bind idempotency to attempt id, head, base, and cutoff event id — never to the reason
value — so a changed code cannot duplicate or lose an existing stop record. The
`deadloop:terminal-monitor-stop` parser matches `reason=[a-z_]+`, which the new codes satisfy.
