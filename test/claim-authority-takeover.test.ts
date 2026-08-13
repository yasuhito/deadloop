import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { takeWorkAuthorityFromRetainedAttempts } = require("../extensions/deadloop/automations/pr-reviewer-driver.ts");
const { readAttemptRecord } = require("../src/attempt-lifecycle-runtime.cjs");

const currentHead = "a".repeat(40);
const olderHead = "b".repeat(40);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function stateDirWith(attempts: Array<Record<string, unknown>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-takeover-"));
  roots.push(root);
  attempts.forEach((attempt, index) => {
    const runDir = path.join(root, "runs", `run-${index}`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
      schemaVersion: 1,
      attemptId: `attempt-${index}`,
      launchUuid: `uuid-${index}`,
      project: "demo",
      repository: "owner/repo",
      role: "reviewer",
      target: { kind: "pull-request", number: 31 },
      inputRevision: { head: currentHead },
      branch: "agent/issue-31",
      worktreePath: "/wt",
      agentName: `dl-r-31-${index}`,
      workspaceLabel: `demo-pr-31-reviewer-${index}`,
      promptFile: path.join(runDir, "reviewer-prompt.md"),
      promiseFile: path.join(runDir, "promise.json"),
      phase: "report_received",
      lastSuccessfulPhase: "report_received",
      ...attempt,
    }));
  });
  return root;
}

function takeover(stateDir: string, stopped = true) {
  return takeWorkAuthorityFromRetainedAttempts({
    stateDir, projectId: "demo", projectRepo: "/repo", githubRepo: "owner/repo", prNumber: 31,
    currentHead, currentRequestEventId: "req-2",
  }, { stoppedFor: () => stopped });
}

describe("work authority takeover at claim time", () => {
  it("releases a stopped attempt bound to a superseded head", () => {
    const stateDir = stateDirWith([{ inputRevision: { head: olderHead } }]);

    expect(takeover(stateDir)).toEqual(["attempt-0"]);
  });

  it("records the released phase on the attempt it took authority from", () => {
    const stateDir = stateDirWith([{ inputRevision: { head: olderHead } }]);
    takeover(stateDir);

    expect(readAttemptRecord(path.join(stateDir, "runs", "run-0")).phase).toBe("authority_released");
  });

  it("keeps a stopped attempt bound to the current head with no claim", () => {
    const stateDir = stateDirWith([{}]);

    expect(takeover(stateDir)).toEqual([]);
  });

  it("keeps a live attempt bound to a superseded head", () => {
    const stateDir = stateDirWith([{ inputRevision: { head: olderHead } }]);

    expect(takeover(stateDir, false)).toEqual([]);
  });

  it("ignores an attempt that already released ownership", () => {
    const stateDir = stateDirWith([{
      inputRevision: { head: olderHead }, phase: "workspace_closed", lastSuccessfulPhase: "workspace_closed",
    }]);

    expect(takeover(stateDir)).toEqual([]);
  });

  it("releases a stopped attempt whose claim names a superseded request", () => {
    const stateDir = stateDirWith([{
      reviewClaim: { binding: { requestEventId: "req-1" } },
    }]);

    expect(takeover(stateDir)).toEqual(["attempt-0"]);
  });

  it("keeps a stopped attempt whose claim names the current request", () => {
    const stateDir = stateDirWith([{
      reviewClaim: { binding: { requestEventId: "req-2" } },
    }]);

    expect(takeover(stateDir)).toEqual([]);
  });

  it("releases every retained attempt that lost its authority", () => {
    const stateDir = stateDirWith([
      { inputRevision: { head: olderHead } },
      { reviewClaim: { binding: { requestEventId: "req-1" } } },
      {},
    ]);

    expect(takeover(stateDir)).toEqual(["attempt-0", "attempt-1"]);
  });

  it("keeps the journal of an attempt it took authority from", () => {
    const stateDir = stateDirWith([{ inputRevision: { head: olderHead } }]);
    takeover(stateDir);

    expect(fs.existsSync(path.join(stateDir, "runs", "run-0", "attempt.json"))).toBe(true);
  });

  it("ignores an attempt targeting another pull request", () => {
    const stateDir = stateDirWith([{ inputRevision: { head: olderHead }, target: { kind: "pull-request", number: 99 } }]);

    expect(takeover(stateDir)).toEqual([]);
  });
});
