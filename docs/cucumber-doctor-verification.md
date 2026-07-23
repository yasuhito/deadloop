# Doctor Cucumber verification

Issue #126 moves the operator-visible doctor guarantees from `test/doctor.test.ts` to `acceptance/features/doctor-diagnostics.feature.md`. The Vitest file was removed only after the Cucumber scenarios covered its classified guarantees.

## Classification mapping

| Classification IDs | Cucumber scenario guarantee |
| --- | --- |
| T134–T135 | A blocked Issue exposes its recovery command and latest blocked reason. |
| T136–T137 | An old in-progress Issue is inspectable while a recently updated, actively owned Issue is not reported. |
| T138–T140 | An orphan worktree is cleaned only when clean, is inspected when dirty, and is not reported when it belongs to an open PR. |
| T141–T143 | Queue-label problems expose the implement, inspection, and requeue commands. |
| T144–T149 | Unavailable, repeated-failure, and stopped automations are reported; normal no-work and recent automations are not. |
| T150–T154 | Claude workspace trust is reported only when unaccepted or unknown, including a Claude reviewer. |
| T155–T158 | Review and implementation claims without a working owner are reported; active or unclaimed work is not. |
| T159–T160 | A healthy project reports no findings and identifies its configuration sources. |

## Intentional failure

On 2026-07-24, the repeated-failure scenario assertion was temporarily changed from matching `[automation_spinning]` to matching `[automation_not_spinning]`, then restored immediately. `npm run test:acceptance` exited 1, named the scenario and feature location, and showed the source-mapped assertion failure in `acceptance/steps/doctor-diagnostics.steps.ts` together with the actual `automation_spinning` finding.

After restoration, `npm run test:acceptance` passed all 28 scenarios. On 2026-07-24, `npm run check` passed.
