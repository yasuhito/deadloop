import { configDefaults, defineConfig } from "vitest/config";
import {
  HOOK_TIMEOUT_MS,
  SUBPROCESS_HEAVY_INCLUDE,
  SUBPROCESS_HEAVY_MAX_WORKERS,
  TEST_TIMEOUT_MS,
} from "./vitest-policy.ts";

// Integration tests drive real subprocesses, real Git repositories and real remotes, so a case
// that takes about two seconds on a developer machine can take several times that on a shared CI
// runner. `docs/test-performance.md` records the rule this encodes: local and CI speed variation
// must not fail an otherwise correct build. The bound stays small enough to catch a hung test.
//
// Subprocess-heavy integration files run as their own project with a bounded worker count
// (vitest-policy.ts). On a loaded runner, unbounded fixture subprocess trees can starve the
// worker-to-host RPC that reports task updates, which used to surface as
// `[vitest-worker]: Timeout calling "onTaskUpdate"` after every test had already passed.
// Bounding the heavy group keeps that channel responsive without weakening timeouts.
// Vitest 4 projects do not inherit root test options, so the shared policy is applied to
// every project explicitly.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "integration",
          include: [SUBPROCESS_HEAVY_INCLUDE],
          maxWorkers: SUBPROCESS_HEAVY_MAX_WORKERS,
          testTimeout: TEST_TIMEOUT_MS,
          hookTimeout: HOOK_TIMEOUT_MS,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "unit",
          exclude: [...configDefaults.exclude, SUBPROCESS_HEAVY_INCLUDE],
          testTimeout: TEST_TIMEOUT_MS,
          hookTimeout: HOOK_TIMEOUT_MS,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
