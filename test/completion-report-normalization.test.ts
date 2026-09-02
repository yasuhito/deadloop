import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { ambiguousShortShaError, normalizeCompletionReportCommitShas, readNormalizedCompletionReport } = require("../src/completion-report-normalization.cjs");
const { reportObservation } = require("../src/monitor-handoff-observation.cts");
const { validatePromise } = require("../extensions/deadloop/automations/extract-worker-promise.cts");

const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop() as string, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-sha-normalization-"));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
  return String(run.stdout).trim();
}

function initRepo(): { root: string; head: string } {
  const root = tempRoot();
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  git(root, "commit", "--allow-empty", "-qm", "base");
  return { root, head: git(root, "rev-parse", "HEAD") };
}

/** The first 4-hex prefix shared by two commits; git itself reports such a prefix as ambiguous. */
function ambiguousShortSha(root: string): string {
  const seen = new Map<string, string>();
  for (let index = 0; index < 3000; index += 1) {
    const sha = spawnSync("git", ["-C", root, "commit-tree", "HEAD^{tree}"], {
      input: `dangling ${index}`,
      encoding: "utf8",
    }).stdout.toString().trim();
    const prefix = sha.slice(0, 4);
    const earlier = seen.get(prefix);
    if (earlier && earlier !== sha) return prefix;
    seen.set(prefix, sha);
  }
  throw new Error("no ambiguous 4-hex prefix appeared within 3000 commits");
}

function attemptRecord(worktreePath: string, runDir: string, head: string) {
  return {
    attemptId: "attempt-1",
    launchUuid: "launch-1",
    project: "demo",
    repository: "octo/demo",
    role: "worker",
    target: { kind: "issue", number: 42 },
    inputRevision: { head },
    branch: "agent/issue-42-worker",
    baseBranch: "origin/main",
    worktreePath,
    agentName: "worker",
    workspaceLabel: "worker 42",
    promptFile: path.join(runDir, "prompt.md"),
    promiseFile: path.join(runDir, "promise.json"),
    phase: "agent_started",
    lastSuccessfulPhase: "agent_started",
  };
}

function workerReport(head: string, outputRevision: string) {
  return {
    schemaVersion: 1,
    attemptId: "attempt-1",
    role: "worker",
    target: { repository: "octo/demo", kind: "issue", number: 42 },
    inputRevision: { head },
    status: "complete",
    summary: "Implemented the change.",
    result: { outputRevision },
    evidence: { validations: ["npm test: passed"] },
  };
}

function writeAttempt(runDir: string, worktreePath: string, head: string) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify(attemptRecord(worktreePath, runDir, head)));
  const promiseFile = path.join(runDir, "promise.json");
  return promiseFile;
}

describe("completion report short-SHA normalization", () => {
  it("expands a uniquely resolvable short outputRevision to the full 40-hex SHA", () => {
    const { root, head } = initRepo();
    const normalized = normalizeCompletionReportCommitShas(
      { worktreePath: root },
      workerReport(head, head.slice(0, 8)),
    );

    expect(normalized.result.outputRevision).toBe(head);
  });

  it("expands a uniquely resolvable short reviewedHead for a reviewer report", () => {
    const { root, head } = initRepo();
    const normalized = normalizeCompletionReportCommitShas(
      { worktreePath: root },
      { role: "reviewer", status: "complete", result: { reviewedHead: head.slice(0, 8) } },
    );

    expect(normalized.result.reviewedHead).toBe(head);
  });

  it("leaves a report unchanged when the worktree is unknown", () => {
    const head = "c".repeat(40);
    const normalized = normalizeCompletionReportCommitShas({}, workerReport(head, head.slice(0, 8)));

    expect(normalized.result.outputRevision).toBe(head.slice(0, 8));
  });

  it("rejects an ambiguous short SHA with the field name and the expected format", () => {
    const { root } = initRepo();
    const short = ambiguousShortSha(root);

    expect(() => normalizeCompletionReportCommitShas({ worktreePath: root }, workerReport("a".repeat(40), short)))
      .toThrow(/outputRevision must be a full 40-hex commit SHA/);
  });

  it("returns the ambiguity error with the reported field attached", () => {
    const error = ambiguousShortShaError("reviewedHead", "2edf");

    expect({ field: error.field, hasExpectedFormat: error.message.includes("reviewedHead must be a full 40-hex commit SHA") }).toEqual({
      field: "reviewedHead",
      hasExpectedFormat: true,
    });
  });
});

describe("the monitor observation of a short-SHA report", () => {
  it("treats a uniquely resolvable short outputRevision as valid and normalized", () => {
    const { root, head } = initRepo();
    const runDir = path.join(tempRoot(), "runs", "attempt-1");
    const promiseFile = writeAttempt(runDir, root, head);
    fs.writeFileSync(promiseFile, JSON.stringify(workerReport(head, head.slice(0, 8))));
    const record = JSON.parse(fs.readFileSync(path.join(runDir, "attempt.json"), "utf8"));

    const observed = reportObservation(record);

    expect({ kind: observed.kind, outputRevision: observed.value.result.outputRevision }).toEqual({
      kind: "valid",
      outputRevision: head,
    });
  });

  it("stops with a detail naming the field and expected format for an ambiguous short SHA", () => {
    const { root, head } = initRepo();
    const runDir = path.join(tempRoot(), "runs", "attempt-1");
    const promiseFile = writeAttempt(runDir, root, head);
    fs.writeFileSync(promiseFile, JSON.stringify(workerReport(head, ambiguousShortSha(root))));
    const record = JSON.parse(fs.readFileSync(path.join(runDir, "attempt.json"), "utf8"));

    const observed = reportObservation(record);

    expect({
      kind: observed.kind,
      hasExpectedFormat: String(observed.detail).includes("outputRevision must be a full 40-hex commit SHA"),
    }).toEqual({ kind: "invalid", hasExpectedFormat: true });
  });
});

describe("the executable promise validation of a short-SHA report", () => {
  it("normalizes a uniquely resolvable short outputRevision and binds strongly", () => {
    const { root, head } = initRepo();
    const runDir = path.join(tempRoot(), "runs", "attempt-1");
    const promiseFile = writeAttempt(runDir, root, head);
    fs.writeFileSync(promiseFile, JSON.stringify(workerReport(head, head.slice(0, 8))));

    const validated = validatePromise(promiseFile, path.join(runDir, "attempt.json"));

    expect({
      evidenceStrength: validated.evidenceStrength,
      outputRevision: validated.promise.result.outputRevision,
    }).toEqual({ evidenceStrength: "strong", outputRevision: head });
  });

  it("rejects an ambiguous short outputRevision with a typed error", () => {
    const { root, head } = initRepo();
    const runDir = path.join(tempRoot(), "runs", "attempt-1");
    const promiseFile = writeAttempt(runDir, root, head);
    fs.writeFileSync(promiseFile, JSON.stringify(workerReport(head, ambiguousShortSha(root))));

    const validated = validatePromise(promiseFile, path.join(runDir, "attempt.json"));

    expect({ status: validated.status, error: validated.error }).toEqual({
      status: "invalid",
      error: "ambiguous_output_revision",
    });
  });

  it("keeps an unresolvable short outputRevision invalid without expansion", () => {
    const { root, head } = initRepo();
    const runDir = path.join(tempRoot(), "runs", "attempt-1");
    const promiseFile = writeAttempt(runDir, root, head);
    fs.writeFileSync(promiseFile, JSON.stringify(workerReport(head, "1234")));

    const validated = validatePromise(promiseFile, path.join(runDir, "attempt.json"));

    expect(validated.status).toBe("invalid");
  });
});

describe("readNormalizedCompletionReport", () => {
  function reportFile(root: string, outputRevision: string): string {
    const promiseFile = path.join(root, "promise.json");
    fs.writeFileSync(promiseFile, JSON.stringify({ status: "complete", role: "worker", result: { outputRevision } }));
    return promiseFile;
  }

  it("expands a uniquely resolvable short outputRevision read from the promise file", () => {
    const { root, head } = initRepo();
    const record = { role: "worker", worktreePath: root, promiseFile: reportFile(root, head.slice(0, 8)) };
    expect(readNormalizedCompletionReport(record).result.outputRevision).toBe(head);
  });

  it("leaves a full outputRevision unchanged", () => {
    const { root, head } = initRepo();
    const record = { role: "worker", worktreePath: root, promiseFile: reportFile(root, head) };
    expect(readNormalizedCompletionReport(record).result.outputRevision).toBe(head);
  });
});
