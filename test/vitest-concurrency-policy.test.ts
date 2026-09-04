import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SUBPROCESS_HEAVY_MAX_WORKERS } from "../vitest-policy";

// Regression fixtures for the CI instability in Issue #440: Vitest reported
// `[vitest-worker]: Timeout calling "onTaskUpdate"` after every test had already passed
// when subprocess-heavy files saturated shared runners. These fixtures run real child
// Vitest instances under a GitHub-Actions-equivalent two-vCPU constraint and observe
// worker file concurrency plus task-update delivery in the parent process. The bounds
// come from vitest-policy.ts, the same source vitest.config.mts uses, so the fixtures
// verify the shipped configuration instead of a copy of it.

const repoRoot = process.cwd();
const vitestCli = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const tasksetPath = ["/usr/bin/taskset", "/bin/taskset"].find((candidate) => existsSync(candidate));

const HEAVY_FILE_COUNT = 8;
const CHILD_RUN_TIMEOUT_MS = 150_000;
const POSITIVE_CASE_TIMEOUT_MS = 60_000;
// Each case drives at least one child Vitest run, so every case declares its own
// bounded timeout instead of relying on the shared 30-second test timeout.

const fixtureRoots: string[] = [];

afterAll(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface ChildRunResult {
  exitCode: number | null;
  report: {
    success: boolean;
    numPassedTests: number;
    numFailedTests: number;
    testResults: Array<{ name: string; status: string }>;
  };
}

interface FixtureFile {
  name: string;
  content: string;
}

async function runChildVitest(files: FixtureFile[]): Promise<ChildRunResult> {
  const root = mkdtempSync(path.join(tmpdir(), "vitest-concurrency-fixture-"));
  fixtureRoots.push(root);
  const eventsPath = path.join(root, "events.jsonl");
  const reportPath = path.join(root, "report.json");

  writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ private: true, type: "module" })}\n`);
  symlinkSync(path.join(repoRoot, "node_modules"), path.join(root, "node_modules"));
  writeFileSync(
    path.join(root, "vitest.config.mts"),
    `import { defineConfig } from "vitest/config";
import { HOOK_TIMEOUT_MS, SUBPROCESS_HEAVY_MAX_WORKERS, TEST_TIMEOUT_MS } from ${JSON.stringify(path.join(repoRoot, "vitest-policy.ts"))};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "heavy",
          include: ["*.heavy.test.ts"],
          maxWorkers: SUBPROCESS_HEAVY_MAX_WORKERS,
          testTimeout: TEST_TIMEOUT_MS,
          hookTimeout: HOOK_TIMEOUT_MS,
          sequence: { groupOrder: 0 },
        },
      },
    ],
  },
});
`,
  );
  for (const file of files) {
    writeFileSync(path.join(root, file.name), file.content);
  }

  const childArguments = [vitestCli, "run", "--reporter=json", `--outputFile=${reportPath}`];
  const child = spawn(tasksetPath ?? process.execPath, [
    ...(tasksetPath ? ["-c", "0,1"] : []),
    process.execPath,
    ...childArguments,
  ], {
    cwd: root,
    env: { ...process.env, FIXTURE_EVENTS_PATH: eventsPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return await new Promise<ChildRunResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child Vitest run did not finish within ${CHILD_RUN_TIMEOUT_MS}ms: ${stderr.slice(-2000)}`));
    }, CHILD_RUN_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, report: JSON.parse(readFileSync(reportPath, "utf8")) });
    });
  });
}

function heavyFile(name: string): FixtureFile {
  return {
    name: `${name}.heavy.test.ts`,
    content: `import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { SUBPROCESS_HEAVY_MAX_WORKERS } from ${JSON.stringify(path.join(repoRoot, "vitest-policy.ts"))};

const eventsPath = process.env.FIXTURE_EVENTS_PATH;

function record(phase) {
  appendFileSync(eventsPath, JSON.stringify({ file: ${JSON.stringify(name)}, phase, t: Date.now(), pid: process.pid }) + "\\n");
}

record("start");
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  const events = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").split("\\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const active = events.reduce((count, event) => count + (event.phase === "start" ? 1 : -1), 0);
  if (active >= SUBPROCESS_HEAVY_MAX_WORKERS) break;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}
for (let index = 0; index < 3; index += 1) {
  execFileSync(process.execPath, ["-e", "const end = Date.now() + 120; while (Date.now() < end);"]);
}
record("end");

test(${JSON.stringify(`${name} completes its subprocess work`)}, () => {
  expect(true).toBe(true);
});
`,
  };
}

function heavyFiles(): FixtureFile[] {
  return Array.from({ length: HEAVY_FILE_COUNT }, (_, index) => heavyFile(`heavy-${index}`));
}

function maxConcurrentHeavyFiles(eventsPath: string): number {
  const events = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { phase: string; t: number })
    .sort((first, second) => first.t - second.t);
  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.phase === "start" ? 1 : -1;
    peak = Math.max(peak, active);
  }
  return peak;
}

function lastFixtureRoot(): string {
  return fixtureRoots.at(-1)!;
}

describe("vitest concurrency policy fixtures", () => {
  let boundedRun: ChildRunResult;
  let boundedRunEventsPath: string;

  beforeAll(async () => {
    boundedRun = await runChildVitest(heavyFiles());
    boundedRunEventsPath = path.join(lastFixtureRoot(), "events.jsonl");
  }, CHILD_RUN_TIMEOUT_MS);

  test(
    "subprocess-heavy files finish without runner errors under a two-vCPU constraint",
    () => {
      expect(boundedRun.exitCode).toBe(0);
    },
    POSITIVE_CASE_TIMEOUT_MS,
  );

  test(
    "every subprocess-heavy task update reaches the parent process",
    () => {
      expect(boundedRun.report.numPassedTests).toBe(HEAVY_FILE_COUNT);
    },
    POSITIVE_CASE_TIMEOUT_MS,
  );

  test(
    "subprocess-heavy file concurrency stays within the configured worker bound",
    () => {
      expect(maxConcurrentHeavyFiles(boundedRunEventsPath)).toBe(SUBPROCESS_HEAVY_MAX_WORKERS);
    },
    POSITIVE_CASE_TIMEOUT_MS,
  );

  test(
    "an assertion failure in a subprocess-heavy file fails the child run",
    async () => {
      const result = await runChildVitest([
        {
          name: "failing.heavy.test.ts",
          content: `import { expect, test } from "vitest";
test("assertion failure", () => {
  expect(1).toBe(2);
});
`,
        },
      ]);
      expect(result.report.testResults[0].status).toBe("failed");
    },
    CHILD_RUN_TIMEOUT_MS,
  );

  test(
    "an unhandled exception in a subprocess-heavy file fails the child run",
    async () => {
      const result = await runChildVitest([
        {
          name: "unhandled.heavy.test.ts",
          content: `import { test } from "vitest";
test("schedules an unhandled exception", () => {
  setTimeout(() => {
    throw new Error("unhandled fixture exception");
  }, 50);
});
test("keeps the worker alive while the exception lands", async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
});
`,
        },
      ]);
      expect(result.exitCode).not.toBe(0);
    },
    CHILD_RUN_TIMEOUT_MS,
  );

  test(
    "a test or hook stopped beyond the bounded timeout fails the child run",
    async () => {
      const [hangingTest, hangingHook] = await Promise.all([
        runChildVitest([
          {
            name: "hang.heavy.test.ts",
            content: `import { test } from "vitest";
test("hangs forever", async () => {
  await new Promise(() => {});
});
`,
          },
        ]),
        runChildVitest([
          {
            name: "hook.heavy.test.ts",
            content: `import { beforeAll, test } from "vitest";
beforeAll(async () => {
  await new Promise(() => {});
});
test("never starts", () => {});
`,
          },
        ]),
      ]);
      expect([hangingTest.exitCode !== 0, hangingHook.exitCode !== 0]).toEqual([true, true]);
    },
    CHILD_RUN_TIMEOUT_MS,
  );

  test(
    "the shipped configuration retries no test file and ignores no unhandled errors",
    async () => {
      const vitestConfig = await import("../vitest.config.mts");
      const offenders = vitestConfig.default.test.projects.map((project) => {
        const testOptions = (project as { test?: Record<string, unknown> }).test ?? {};
        return {
          retry: testOptions.retry,
          dangerouslyIgnoreUnhandledErrors: testOptions.dangerouslyIgnoreUnhandledErrors,
        };
      });
      expect(offenders).toEqual([
        { retry: undefined, dangerouslyIgnoreUnhandledErrors: undefined },
        { retry: undefined, dangerouslyIgnoreUnhandledErrors: undefined },
      ]);
    },
  );
});
