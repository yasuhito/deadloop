import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AttemptRecord, CompletionReportV1 } from "../src/attempt-lifecycle";
import {
  assertWorkerCompletionAuthorized,
  type RequiredVerificationRecord,
} from "../src/worker-required-verification";
const runtime = require("../src/worker-required-verification-runtime.cjs");

const inputHead = "a".repeat(40);
const outputHead = "b".repeat(40);
const contract = {
  repository: "octo/demo",
  command: "npm run check",
  source: { kind: "repo_policy" as const, location: "deadloop.json" },
  baseRevision: inputHead,
};
const attempt: AttemptRecord = {
  attemptId: "attempt-1",
  launchUuid: "launch-1",
  project: "demo",
  repository: "octo/demo",
  role: "worker",
  target: { kind: "issue", number: 12 },
  inputRevision: { head: inputHead },
  requiredVerification: contract,
  branch: "agent/issue-12-task",
  baseBranch: "origin/main",
  worktreePath: "/worktree",
  agentName: "dl-w-12-abcdef123456",
  workspaceLabel: "worker",
  promptFile: "/runs/attempt-1/prompt.md",
  promiseFile: "/runs/attempt-1/promise.json",
  phase: "agent_started",
  lastSuccessfulPhase: "agent_started",
};
const report: CompletionReportV1 = {
  schemaVersion: 1,
  attemptId: attempt.attemptId,
  role: "worker",
  target: { repository: attempt.repository, ...attempt.target },
  inputRevision: attempt.inputRevision,
  status: "complete",
  summary: "Implemented and checked the requested change.",
  result: { outputRevision: outputHead },
  evidence: { validations: ["npm run check passed"] },
};
const verification: RequiredVerificationRecord = {
  version: 1,
  binding: {
    repository: contract.repository,
    targetCommit: outputHead,
    command: contract.command,
    source: contract.source,
    baseRevision: contract.baseRevision,
  },
  outcome: "passed",
  exitCode: 0,
  startedAt: "2026-08-06T00:00:00.000Z",
  durationMs: 10,
  logPath: "/state/check.log",
};

describe("Worker required-verification completion gate", () => {
  it("accepts an exact passed record for the Worker output commit", () => {
    expect(assertWorkerCompletionAuthorized(attempt, report, verification, contract).outputRevision).toBe(outputHead);
  });

  it("rejects a missing persisted contract even when verification exited zero", () => {
    expect(() => assertWorkerCompletionAuthorized({ ...attempt, requiredVerification: undefined } as unknown as AttemptRecord, report, verification, contract)).toThrow("persisted contract");
  });

  it("rejects an empty persisted command even when verification exited zero", () => {
    expect(() => assertWorkerCompletionAuthorized({ ...attempt, requiredVerification: { ...contract, command: "" } }, report, verification, contract)).toThrow("zero_targets");
  });

  it("rejects an otherwise matching record with incomplete required evidence", () => {
    const { startedAt: _startedAt, durationMs: _durationMs, logPath: _logPath, ...incomplete } = verification;
    expect(() => assertWorkerCompletionAuthorized(attempt, report, incomplete as RequiredVerificationRecord, contract)).toThrow("record is invalid");
  });

  it("rejects a failed record for the exact output commit", () => {
    expect(() => assertWorkerCompletionAuthorized(attempt, report, { ...verification, outcome: "failed", exitCode: 1 }, contract)).toThrow("did not pass");
  });

  it("rejects a passed record for another output commit", () => {
    expect(() => assertWorkerCompletionAuthorized(attempt, report, { ...verification, binding: { ...verification.binding, targetCommit: "c".repeat(40) } }, contract)).toThrow("output commit");
  });

  it("does not promote agent validation prose without a required-verification record", () => {
    expect(() => assertWorkerCompletionAuthorized(attempt, report, undefined, contract)).toThrow("record");
  });

  it("stops when current trusted policy differs from the fixed attempt contract", () => {
    expect(() => assertWorkerCompletionAuthorized(attempt, report, verification, { ...contract, command: "npm run stricter-check" })).toThrow("stale_policy");
  });

  it("accepts the same fixed contract in TypeScript and the direct Node runtime", () => {
    expect(runtime.assertWorkerCompletionAuthorized(attempt, report, verification, contract)).toEqual(
      assertWorkerCompletionAuthorized(attempt, report, verification, contract),
    );
  });

  it("trusts a non-empty explicit command without interpreting output counts", () => {
    const explicit = { ...contract, command: "printf '0 tests\\n'" };
    const exact = { ...verification, binding: { ...verification.binding, command: explicit.command } };
    expect(assertWorkerCompletionAuthorized({ ...attempt, requiredVerification: explicit }, report, exact, explicit).outputRevision).toBe(outputHead);
  });

  it("stops when a local override is added after a repo-policy-backed attempt starts", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-worker-local-override-"));
    try {
      const remote = path.join(root, "remote.git"); const seed = path.join(root, "seed"); const checkout = path.join(root, "checkout"); const configFile = path.join(root, "projects.json");
      execFileSync("git", ["init", "--bare", "--quiet", remote]);
      execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
      execFileSync("git", ["-C", seed, "config", "user.name", "Test"]); execFileSync("git", ["-C", seed, "config", "user.email", "test@example.com"]);
      writeFileSync(path.join(seed, "deadloop.json"), JSON.stringify({ checkCommand: contract.command }));
      execFileSync("git", ["-C", seed, "add", "deadloop.json"]); execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "policy"]);
      execFileSync("git", ["-C", seed, "remote", "add", "origin", remote]); execFileSync("git", ["-C", seed, "push", "--quiet", "-u", "origin", "main"]);
      execFileSync("git", ["clone", "--quiet", remote, checkout]);
      const baseRevision = execFileSync("git", ["-C", checkout, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
      writeFileSync(configFile, JSON.stringify({ projects: [{ id: attempt.project, githubRepo: attempt.repository, checkCommand: "npm run local-check" }] }));
      const fixedAttempt = { ...attempt, requiredVerification: { ...contract, baseRevision } };
      expect(() => runtime.assertCurrentWorkerContract(fixedAttempt, checkout, configFile)).toThrow("stale_policy");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("uses the currently selected configuration instead of the fixed contract's old local path", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-worker-config-switch-"));
    try {
      const remote = path.join(root, "remote.git"); const seed = path.join(root, "seed"); const checkout = path.join(root, "checkout");
      const oldConfig = path.join(root, "old-projects.json"); const activeConfig = path.join(root, "active-projects.json");
      execFileSync("git", ["init", "--bare", "--quiet", remote]);
      execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
      execFileSync("git", ["-C", seed, "config", "user.name", "Test"]); execFileSync("git", ["-C", seed, "config", "user.email", "test@example.com"]);
      writeFileSync(path.join(seed, "file.txt"), "policy base\n");
      execFileSync("git", ["-C", seed, "add", "file.txt"]); execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "base"]);
      execFileSync("git", ["-C", seed, "remote", "add", "origin", remote]); execFileSync("git", ["-C", seed, "push", "--quiet", "-u", "origin", "main"]);
      execFileSync("git", ["clone", "--quiet", remote, checkout]);
      const baseRevision = execFileSync("git", ["-C", checkout, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
      writeFileSync(oldConfig, JSON.stringify({ projects: [{ id: attempt.project, githubRepo: attempt.repository, checkCommand: "npm run old-check" }] }));
      writeFileSync(activeConfig, JSON.stringify({ projects: [{ id: attempt.project, githubRepo: attempt.repository, checkCommand: "npm run active-check" }] }));
      const fixedAttempt = { ...attempt, requiredVerification: { repository: attempt.repository, command: "npm run old-check", source: { kind: "local", location: `${oldConfig}#project=${attempt.project}` }, baseRevision } };
      expect(() => runtime.assertCurrentWorkerContract(fixedAttempt, checkout, activeConfig)).toThrow("stale_policy");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("fetches the configured trusted base before checking for policy changes", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-worker-policy-"));
    try {
      const remote = path.join(root, "remote.git"); const seed = path.join(root, "seed"); const checkout = path.join(root, "checkout");
      execFileSync("git", ["init", "--bare", "--quiet", remote]);
      execFileSync("git", ["init", "--quiet", "-b", "release", seed]);
      execFileSync("git", ["-C", seed, "config", "user.name", "Test"]); execFileSync("git", ["-C", seed, "config", "user.email", "test@example.com"]);
      writeFileSync(path.join(seed, "deadloop.json"), JSON.stringify({ checkCommand: contract.command }));
      execFileSync("git", ["-C", seed, "add", "deadloop.json"]); execFileSync("git", ["-C", seed, "commit", "--quiet", "-m", "policy"]);
      execFileSync("git", ["-C", seed, "remote", "add", "origin", remote]); execFileSync("git", ["-C", seed, "push", "--quiet", "-u", "origin", "release"]);
      execFileSync("git", ["clone", "--quiet", "-b", "release", remote, checkout]);
      const baseRevision = execFileSync("git", ["-C", checkout, "rev-parse", "origin/release"], { encoding: "utf8" }).trim();
      writeFileSync(path.join(seed, "deadloop.json"), JSON.stringify({ checkCommand: "npm run stricter-check" }));
      execFileSync("git", ["-C", seed, "commit", "--quiet", "-am", "stricter policy"]); execFileSync("git", ["-C", seed, "push", "--quiet"]);
      const staleAttempt = { ...attempt, baseBranch: "origin/release", requiredVerification: { ...contract, baseRevision } };
      expect(() => runtime.assertCurrentWorkerContract(staleAttempt, checkout)).toThrow("stale_policy");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
