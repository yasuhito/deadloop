# Local test performance

This note records the follow-up to Issue #172. It is a measurement record, not a CI time limit; local and CI speed variation must not fail an otherwise correct build.

## Optimization

`test/enablement.integration.test.ts` now builds each normal and separate-Git-dir repository template once, copies that immutable template into a fully replaced fixture root for every test, and imports the extension module once. Each test still receives new repository files, local state, environment settings, and a newly registered extension instance, so mutable fixture and extension closure state are not shared. The fixture Git wrapper also avoids repeated fetch and missing-policy lookups because the template already contains the fetched base ref and these tests intentionally have no trusted `deadloop.json` policy.

No tests or acceptance scenarios were removed.

## Measurements

Measured on 2026-07-26 in the same worktree, through `run-project-check.ts`:

| Command | Result | Wall time |
|---|---:|---:|
| pre-change `npm run test:unit` | 56 files, 760 tests | 15.481 s |
| post-change `npm run test:unit` | 56 files, 760 tests | 10.100 s |
| post-change `npm run test:acceptance` | 212 scenarios, 1,097 steps | 9.518 s |
| post-change `npm test` | all 760 tests and 212 scenarios | 19.236 s |

Vitest's own reported duration fell from 15.12 s to 9.70 s. The previously dominant enablement file fell from 14.649 s to 9.109 s in the measured full runs.

## Remaining gap and next action

The 5-second Cucumber and 10-second combined guidelines are not met. Since the Issue #172 baseline was recorded, the acceptance suite grew from 95 scenarios and 495 steps to 212 scenarios and 1,097 steps; its 8.766-second Cucumber-reported duration is now an independent critical path, while enablement integration still spends about 9 seconds exercising real Git and process boundaries.

The next performance pass should profile Cucumber by feature and step definition, then cache or replace only repeated setup below the World boundary without sharing mutable World state. For Vitest, it should split the remaining enablement time between product Git subprocesses and fixture operations before deciding whether a test-only Git adapter or a deeper extension configuration seam is justified. Tests and scenarios must remain intact, and any parallelization must first remove the shared process-environment and module-state boundary.
