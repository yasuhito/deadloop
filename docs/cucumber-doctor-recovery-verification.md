# doctor recovery Cucumber migration verification

Issue #125 moves the operator-visible `doctor` recovery contract from `test/doctor.test.ts` to Japanese Cucumber Markdown. The 27 former Vitest cases are fully replaced by [`acceptance/features/doctor-recovery.feature.md`](../acceptance/features/doctor-recovery.feature.md) and its step definitions.

## Classification mapping and equivalence

Each replacement uses the same configured project and deterministic snapshot inputs as the former case, invokes the public doctor report boundary, and observes exactly one displayed result.

| Classification IDs | Replacement scenario result |
|---|---|
| T134 | blocked Issue requeue command |
| T135 | latest blocked reason |
| T136 | stale in-progress worktree inspection command |
| T137 | fresh working Issue produces no finding |
| T138 | clean orphan worktree cleanup command |
| T139 | dirty orphan worktree inspection command |
| T140 | open-PR worktree produces no finding |
| T141 | ready-only Issue enqueue command |
| T142 | needs-triage Issue inspection command |
| T143 | needs-triage Issue requeue command |
| T144 | unavailable precheck inspection command |
| T145 | missing precheck inspection command |
| T146 | repeated automation failure finding |
| T147 | ordinary no-work wait produces no finding |
| T148 | stalled automation finding |
| T149 | recent healthy automation produces no finding |
| T150 | untrusted Claude workspace command |
| T151 | trusted Claude workspace produces no finding |
| T152 | untrusted Claude reviewer workspace command |
| T153 | Pi-only workspace produces no finding |
| T154 | unreadable Claude trust configuration command |
| T155 | stale review-claim release command |
| T156 | working reviewer claim produces no finding |
| T157 | stale implementation-claim commit inspection command |
| T158 | unclaimed Issue and pull request produce no finding |
| T159 | no-problem report |
| T160 | layered configuration source |

The former Vitest tests were deleted only after the Cucumber scenarios passed, because every prior input/observable-result pair has one corresponding scenario above.

## Intentional failure check

Before committing, the expected text in the `停止した自動化が表示される` Then step was temporarily changed from `coordinator_stalled` to `automation_spinning`, and `npm run test:acceptance` was run. The command exited with status 1 and identified `自動化の試行停止を表示する` at `acceptance/features/doctor-recovery.feature.md:89` and the failed assertion at `acceptance/steps/doctor-recovery.steps.ts:219`. The expected text was restored to `coordinator_stalled`, and a subsequent `npm run test:acceptance` run passed all 28 scenarios and 113 steps.
