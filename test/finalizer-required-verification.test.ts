import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const {
  ensureRequiredVerificationRecord,
  verificationRecordForResult,
} = require("../extensions/deadloop/automations/finalizer-required-verification.ts");

const contract = {
  repository: "owner/repo",
  command: "npm test",
  source: { kind: "repo_policy", location: "deadloop.json" },
  baseRevision: "a".repeat(40),
};
const candidate = "b".repeat(40);

function attempt(role: "review-repair" | "branch-update") {
  return { role, repository: "owner/repo", requiredVerification: contract };
}

function passedRecord(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    binding: { ...contract, targetCommit: candidate },
    outcome: "passed",
    exitCode: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1,
    logPath: "/state/check.log",
    provenance: { kind: "host_gate_execution", recordPath: "/state/evidence.json" },
    ...overrides,
  };
}

it("records a bounded finalizer verification timeout with the canonical typed outcome", () => {
  const record = verificationRecordForResult(
    { attempt: attempt("review-repair"), currentContract: contract, targetCommit: candidate },
    candidate,
    { status: null, stdout: "", stderr: "project check wrapper timed out", timedOut: true },
    Date.now(),
    "/state/check.log",
  );

  expect({ outcome: record.outcome, exitCode: record.exitCode, terminationReason: record.terminationReason }).toEqual({ outcome: "timed_out", exitCode: null, terminationReason: "timeout" });
});

it("records finalizer verification interruption with the canonical typed outcome", () => {
  const record = verificationRecordForResult(
    { attempt: attempt("branch-update"), currentContract: contract, targetCommit: candidate },
    candidate,
    { status: null, stdout: "", stderr: "", signal: "SIGINT" },
    Date.now(),
    "/state/check.log",
  );

  expect({ outcome: record.outcome, exitCode: record.exitCode, terminationReason: record.terminationReason }).toEqual({ outcome: "interrupted", exitCode: null, terminationReason: "interrupted" });
});

it("keeps a structured exit 124 an ordinary failed command with its real exit code", () => {
  const record = verificationRecordForResult(
    { attempt: attempt("review-repair"), currentContract: contract, targetCommit: candidate },
    candidate,
    { status: 124, stdout: "", stderr: "" },
    Date.now(),
    "/state/check.log",
    { version: 1, code: 124, timedOut: false, interrupted: false, signal: null },
  );

  expect({ outcome: record.outcome, exitCode: record.exitCode, terminationReason: record.terminationReason }).toEqual({ outcome: "failed", exitCode: 124, terminationReason: undefined });
});

it("keeps a structured exit 130 an ordinary failed command with its real exit code", () => {
  const record = verificationRecordForResult(
    { attempt: attempt("review-repair"), currentContract: contract, targetCommit: candidate },
    candidate,
    { status: 130, stdout: "", stderr: "" },
    Date.now(),
    "/state/check.log",
    { version: 1, code: 130, timedOut: false, interrupted: false, signal: null },
  );

  expect({ outcome: record.outcome, exitCode: record.exitCode }).toEqual({ outcome: "failed", exitCode: 130 });
});

it("fails closed when the structured result records a restoration failure", () => {
  const record = verificationRecordForResult(
    { attempt: attempt("review-repair"), currentContract: contract, targetCommit: candidate },
    candidate,
    { status: 0, stdout: "", stderr: "" },
    Date.now(),
    "/state/check.log",
    { version: 1, code: 0, timedOut: false, interrupted: false, signal: null, restorationFailure: true },
  );

  expect({ outcome: record.outcome, restorationFailure: record.restorationFailure }).toEqual({ outcome: "failed", restorationFailure: true });
});

const subprocessRoots: string[] = [];
afterEach(() => {
  for (const dir of subprocessRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function subprocessCheckFixture(): { cwd: string; structuredPath: string; args: (command: string, timeoutMs: number) => string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-finalizer-check-"));
  subprocessRoots.push(root);
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  spawnSync("git", ["-C", cwd, "init", "--quiet"]);
  const structuredPath = path.join(root, "check-result.json");
  return {
    cwd,
    structuredPath,
    args: (command: string, timeoutMs: number) => [
      "extensions/deadloop/automations/run-project-check.ts",
      "--cwd", cwd,
      "--timeout-ms", String(timeoutMs),
      "--command", command,
      "--quarantine-root", path.join(root, "quarantine"),
      "--structured-result", structuredPath,
    ],
  };
}

describe("finalizer verification subprocess outcomes", () => {
  it("records an ordinary exit 124 from a real subprocess as a failed command", () => {
    const fixture = subprocessCheckFixture();
    const result = spawnSync("node", fixture.args("exit 124", 60_000), { encoding: "utf8" });
    const structured = JSON.parse(fs.readFileSync(fixture.structuredPath, "utf8"));
    const record = verificationRecordForResult(
      { attempt: attempt("review-repair"), currentContract: contract, targetCommit: candidate },
      candidate,
      { status: result.status, stdout: result.stdout, stderr: result.stderr },
      Date.now(),
      "/state/check.log",
      structured,
    );

    expect({ outcome: record.outcome, exitCode: record.exitCode }).toEqual({ outcome: "failed", exitCode: 124 });
  });

  it("records a real subprocess timeout as timed_out", () => {
    const fixture = subprocessCheckFixture();
    const result = spawnSync("node", fixture.args("sleep 5", 200), { encoding: "utf8" });
    const structured = JSON.parse(fs.readFileSync(fixture.structuredPath, "utf8"));
    const record = verificationRecordForResult(
      { attempt: attempt("review-repair"), currentContract: contract, targetCommit: candidate },
      candidate,
      { status: result.status, stdout: result.stdout, stderr: result.stderr },
      Date.now(),
      "/state/check.log",
      structured,
    );

    expect({ outcome: record.outcome, exitCode: record.exitCode, terminationReason: record.terminationReason }).toEqual({ outcome: "timed_out", exitCode: null, terminationReason: "timeout" });
  });

  it("records a real subprocess interruption as interrupted", async () => {
    const fixture = subprocessCheckFixture();
    const child = spawn("node", fixture.args("sleep 5", 60_000), { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 700));
    child.kill("SIGINT");
    await new Promise((resolve) => child.once("close", resolve));
    const structured = JSON.parse(fs.readFileSync(fixture.structuredPath, "utf8"));
    const record = verificationRecordForResult(
      { attempt: attempt("review-repair"), currentContract: contract, targetCommit: candidate },
      candidate,
      { status: null, stdout: "", stderr: "", signal: "SIGINT" },
      Date.now(),
      "/state/check.log",
      structured,
    );

    expect({ interrupted: structured.interrupted, outcome: record.outcome, terminationReason: record.terminationReason }).toEqual({ interrupted: true, outcome: "interrupted", terminationReason: "interrupted" });
  });
});

for (const role of ["review-repair", "branch-update"] as const) {
  describe(`${role} required-verification conformance`, () => {
    it("runs required verification when the success record is missing", async () => {
      let executions = 0;
      await ensureRequiredVerificationRecord(
        { attempt: attempt(role), currentContract: contract, targetCommit: candidate, record: undefined },
        {
          execute: () => { executions += 1; return passedRecord(); },
          persist: (record: unknown) => record,
          authenticate: () => {},
        },
      );

      expect(executions).toBe(1);
    });

    it("does not accept command-and-result legacy evidence", async () => {
      let executions = 0;
      await ensureRequiredVerificationRecord(
        { attempt: attempt(role), currentContract: contract, targetCommit: candidate, record: { command: "npm test", result: "passed" } },
        {
          execute: () => { executions += 1; return passedRecord(); },
          persist: (record: unknown) => record,
          authenticate: () => {},
        },
      );

      expect(executions).toBe(1);
    });

    it("reuses an exact authenticated success record", async () => {
      let executions = 0;
      await ensureRequiredVerificationRecord(
        { attempt: attempt(role), currentContract: contract, targetCommit: candidate, record: passedRecord() },
        {
          execute: () => { executions += 1; return passedRecord(); },
          persist: (record: unknown) => record,
          authenticate: () => {},
        },
      );

      expect(executions).toBe(0);
    });

    it("reruns verification when exact-looking evidence is not authenticated", async () => {
      let executions = 0;
      let authentications = 0;
      await ensureRequiredVerificationRecord(
        { attempt: attempt(role), currentContract: contract, targetCommit: candidate, record: passedRecord() },
        {
          execute: () => { executions += 1; return passedRecord(); },
          persist: (record: unknown) => record,
          authenticate: () => { authentications += 1; if (authentications === 1) throw new Error("unauthenticated"); },
        },
      );

      expect(executions).toBe(1);
    });

    it("persists failed evidence when a successful command fails post-check binding", async () => {
      let persisted: Record<string, unknown> | undefined;
      let message = "";
      try {
        await ensureRequiredVerificationRecord(
          { attempt: attempt(role), currentContract: contract, targetCommit: candidate, record: undefined },
          {
            execute: () => passedRecord(),
            validate: () => { throw new Error("HEAD changed during checks"); },
            persist: (record: Record<string, unknown>) => { persisted = record; return record; },
            authenticate: () => {},
          },
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect({ outcome: persisted?.outcome, message }).toEqual({ outcome: "failed", message: "HEAD changed during checks" });
    });

    it("reruns verification when the target commit changes", async () => {
      let executions = 0;
      await ensureRequiredVerificationRecord(
        { attempt: attempt(role), currentContract: contract, targetCommit: "c".repeat(40), record: passedRecord() },
        {
          execute: () => { executions += 1; return passedRecord({ binding: { ...contract, targetCommit: "c".repeat(40) } }); },
          persist: (record: unknown) => record,
          authenticate: () => {},
        },
      );

      expect(executions).toBe(1);
    });

    it("reruns verification when the record source changes", async () => {
      let executions = 0;
      await ensureRequiredVerificationRecord(
        { attempt: attempt(role), currentContract: contract, targetCommit: candidate, record: passedRecord({ binding: { ...contract, source: { kind: "local", location: "/tmp/projects.json#project=demo" }, targetCommit: candidate } }) },
        {
          execute: () => { executions += 1; return passedRecord(); },
          persist: (record: unknown) => record,
          authenticate: () => {},
        },
      );

      expect(executions).toBe(1);
    });

    it("reruns verification when the record base revision changes", async () => {
      let executions = 0;
      await ensureRequiredVerificationRecord(
        { attempt: attempt(role), currentContract: contract, targetCommit: candidate, record: passedRecord({ binding: { ...contract, baseRevision: "d".repeat(40), targetCommit: candidate } }) },
        {
          execute: () => { executions += 1; return passedRecord(); },
          persist: (record: unknown) => record,
          authenticate: () => {},
        },
      );

      expect(executions).toBe(1);
    });
  });
}

describe("interruptible finalizer verification", () => {
  const { withInterruptibleProjectCheck } = require("../extensions/deadloop/automations/finalizer-required-verification.ts");

  async function interruptedCheck(signal?: "SIGINT" | "SIGTERM") {
    const handlers = new Map<string, () => void>();
    const forwarded: string[] = [];
    let exit: (result: Record<string, unknown>) => void = () => {};
    let recorded: { status: number | null; signalled: string | null; listeners: number } | undefined;
    const pending = withInterruptibleProjectCheck(
      ["node", "run-project-check.ts"],
      60_000,
      {
        start: () => ({
          kill: (received: string) => forwarded.push(received),
          exited: new Promise((resolve) => { exit = resolve; }),
        }),
        on: (name: string, handler: () => void) => handlers.set(name, handler),
        off: (name: string) => handlers.delete(name),
      },
      (result: { status: number | null }, signalled: string | null) => {
        recorded = { status: result.status, signalled, listeners: handlers.size };
        return "recorded";
      },
    );
    if (signal) handlers.get(signal)?.();
    const forwardedBeforeExit = [...forwarded];
    const recordedBeforeExit = recorded;
    exit({ status: 0, stdout: "", stderr: "", signal: null });
    await pending;
    return { forwardedBeforeExit, recordedBeforeExit, recorded, listeners: handlers.size };
  }

  it("forwards the signal to the checker while it is still running", async () => {
    expect((await interruptedCheck("SIGTERM")).forwardedBeforeExit).toEqual(["SIGTERM"]);
  });

  it("waits for the checker to exit before recording the run", async () => {
    expect((await interruptedCheck("SIGTERM")).recordedBeforeExit).toBeUndefined();
  });

  it("records the signal that interrupted the finalizer", async () => {
    expect((await interruptedCheck("SIGINT")).recorded?.signalled).toBe("SIGINT");
  });

  it("discards the checker verdict of a signaled run", async () => {
    expect((await interruptedCheck("SIGTERM")).recorded?.status).toBeNull();
  });

  it("keeps its signal handlers installed until the evidence is recorded", async () => {
    expect((await interruptedCheck("SIGTERM")).recorded?.listeners).toBe(2);
  });

  it("forwards nothing when no signal arrived", async () => {
    expect((await interruptedCheck()).forwardedBeforeExit).toHaveLength(0);
  });

  it("releases its signal handlers", async () => {
    expect((await interruptedCheck("SIGTERM")).listeners).toBe(0);
  });
});

it("records an interruption even when the checker reported a passing exit", () => {
  const { finalizerResultForSignal } = require("../extensions/deadloop/automations/finalizer-required-verification.ts");
  const record = verificationRecordForResult(
    { attempt: attempt("review-repair"), currentContract: contract, targetCommit: candidate },
    candidate,
    finalizerResultForSignal({ status: 0, stdout: "", stderr: "" }, "SIGTERM"),
    Date.now(),
    "/state/check.log",
  );

  expect(record.outcome).toBe("interrupted");
});

it("keeps the checker verdict when no signal reached the finalizer", () => {
  const { finalizerResultForSignal } = require("../extensions/deadloop/automations/finalizer-required-verification.ts");
  expect(finalizerResultForSignal({ status: 0, stdout: "", stderr: "" }, null).status).toBe(0);
});
