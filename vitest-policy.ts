// Single source for the Vitest execution policy that regression fixtures share with
// vitest.config.mts. Fixtures import this file so a bound is decided here once and
// verified against the real runner in test/vitest-concurrency-policy.test.ts.
export const TEST_TIMEOUT_MS = 30_000;
export const HOOK_TIMEOUT_MS = 30_000;

// Subprocess-heavy integration test files drive real Git repositories, npm-based
// fixtures and worker processes. Bounding their file parallelism keeps the
// Vitest worker-to-host RPC (the channel that carries every task update to the
// parent process) responsive on shared CI runners instead of saturating the
// machine with concurrent fixture subprocess trees.
export const SUBPROCESS_HEAVY_INCLUDE = "test/*.integration.test.ts";
export const SUBPROCESS_HEAVY_MAX_WORKERS = 2;
