# Local test performance

This note records the follow-up to Issue #172 and the Issue #440 investigation. It is a measurement record, not a CI time limit; local and CI speed variation must not fail an otherwise correct build.

## Issue #172 optimization

`test/enablement.integration.test.ts` now builds each normal and separate-Git-dir repository template once, copies that immutable template into a fully replaced fixture root for every test, and imports the extension module once. Each test still receives new repository files, local state, environment settings, and a newly registered extension instance, so mutable fixture and extension closure state are not shared. The fixture Git wrapper also avoids repeated fetch and missing-policy lookups because the template already contains the fetched base ref and these tests intentionally have no trusted `deadloop.json` policy.

No tests or acceptance scenarios were removed.

## Issue #440: worker-to-host RPC timeouts after every test passed

GitHub Actions repeatedly failed with `[vitest-worker]: Timeout calling "onTaskUpdate"` after all 141 test files and 2508 tests had passed (8 of the last 100 CI runs; for example run `33593651049`). The Vitest worker reports every task update to the parent process over a birpc channel whose client-side timeout is hard-coded to 60 seconds in Vitest 3.2.x and is not configurable. Under runner load, the reply for a pending update is not processed inside that window and the resulting unhandled rejection fails an otherwise green run. Vitest fixed this upstream in v4 by removing the spurious worker-side timeout and rejecting pending calls only when the RPC channel actually closes (vitest-dev/vitest#8164, #11082, and the fix in #8297).

### Measurements

- Suite profile at the time of the failures: 141 files, 2508 tests, `transform 2.83s`, `collect 15.68s`, `tests 245.78s` over a 99.66s wall — about 2.5 concurrent workers on the shared runner.
- Local workstation under co-tenant load, Vitest 3.2.6: 5 of 11 full runs failed with exactly one `onTaskUpdate` timeout and zero test failures.
- Local with `--maxWorkers=4`: 1 of 4 runs failed; with `--maxWorkers=8`: 1 of 3 failed. Capping worker count reduces load but does not remove the failure mode, matching the upstream analysis in vitest-dev/vitest#11082 ("the bottleneck is the host loop, not the worker count").
- A probe reporter recorded parent-side `onTaskUpdate` handling during a failing run: every update was handled within ~5.5 seconds and the run stayed continuous, so the parent was replying promptly while a worker-side 60-second timer still expired. The causal boundary is the hard-coded worker RPC timeout racing a delayed reply under load, not a hung parent handler.
- Reproduction under a deterministic CPU constraint (suite pinned to 4 CPUs with competing load pinned to the same CPUs) reproduced the same single `onTaskUpdate` timeout with all tests passing.

### Fix

1. Vitest was upgraded from 3.2.6 to 4.1.11, which contains the upstream fix: the worker no longer fails a green run when a task-update reply is delayed; pending RPC calls are rejected only when the channel actually closes.
2. Subprocess-heavy integration files (`test/*.integration.test.ts`) run as their own Vitest project with `maxWorkers` bounded to 2 (one value in `vitest-policy.ts`, shared with `vitest.config.mts`), keeping concurrent fixture subprocess trees low on shared runners.
3. `test/vitest-concurrency-policy.test.ts` runs real child Vitest instances under `taskset -c 0,1` and verifies: the subprocess-heavy run finishes without runner errors, every task update reaches the parent, file concurrency never exceeds the configured bound, and assertion failures, unhandled exceptions, and tests or hooks that hang past the bounded timeout still fail the run.

Vitest 4 projects do not inherit root test options, so `vitest.config.mts` applies the shared test and hook timeouts to every project explicitly.

### Verification

- Full suite on Vitest 4.1.11: 142 files, 2567 tests, all passing; wall time comparable to the Vitest 3 baseline.
- The acceptance criterion of ten consecutive green `npm run test:unit` runs on the GitHub Actions runner is checked by CI after this change lands; the deterministic two-vCPU fixture above covers the same failure mode locally.

## Remaining gap and next action

The 5-second Cucumber and 10-second combined guidelines from the Issue #172 pass are still not met. The next performance pass should profile Cucumber by feature and step definition, then cache or replace only repeated setup below the World boundary without sharing mutable World state. For Vitest, the bounded integration project can be re-profiled before widening `SUBPROCESS_HEAVY_MAX_WORKERS`. Tests and scenarios must remain intact, and any parallelization must first remove the shared process-environment and module-state boundary.
