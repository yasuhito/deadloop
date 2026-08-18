import { defineConfig } from "vitest/config";

// Integration tests here drive real subprocesses, real Git repositories and real remotes, so a case
// that takes about two seconds on a developer machine can take several times that on a shared CI
// runner. `docs/test-performance.md` records the rule this encodes: local and CI speed variation
// must not fail an otherwise correct build. The bound stays small enough to catch a hung test.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
