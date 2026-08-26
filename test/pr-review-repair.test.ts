import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const { decideRepairPushGuard, parseArgs: parseFinalizerArgs } = require("../extensions/deadloop/automations/pr-review-repair-finalize.cts");
const { recoveryComment, sameFindingTitles } = require("../extensions/deadloop/automations/pr-review-repair-complete.cts");
const { repairWorkerPrompt, requireManagedPr } = require("../extensions/deadloop/automations/pr-review-repair-dispatch.cts");
const { decideTechnicalReviewFailure, renderRepairMarker, repairAttempts, reviewResultFingerprint, selectRepairAttempt } = require("../extensions/deadloop/automations/pr-review-repair-state.cts");

const head = "a".repeat(40);
const automationLogin = "deadloop-bot";
const findings = [{ title: "Lint contract failure", body: "Restore the lint gate", path: "src/a.ts", line: 4, severity: "blocker" }];

function historicalRepairMarkers(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    body: renderRepairMarker(String(index + 1).padStart(40, "0"), String(index + 1).padStart(20, "0")),
    author: { login: automationLogin },
  }));
}

function repairContract(requiredFindings: Array<Record<string, unknown>>) {
  const rendered = repairWorkerPrompt("243", "agent/issue-243", head, requiredFindings, "attempt-key", "/state/promise.json", "/worktree", {
    projectId: "demo",
    repoPath: "/repo",
    githubRepo: "owner/repo",
    stateDir: "/state",
    checkCommand: "npm test",
    workerAgent: "pi",
    workerModel: "",
    remote: "origin",
    reviewLabel: "agent:review",
    blockedLabel: "agent:blocked",
    inProgressLabel: "agent:in-progress",
    automationDir: "/automation",
    enabledAt: 1,
  });
  return JSON.parse(rendered.match(/Required findings contract:\n```json\n([\s\S]*?)\n```/)?.[1] || "[]");
}

describe("technical review failures and storage exhaustion", () => {
  it("stops a blocked report naming observed ENOSPC without spending the retry", () => {
    const report = { status: "blocked", result: { reason: "ENOSPC", explanation: "the host ran out of storage" } };
    expect(decideTechnicalReviewFailure([], head, report).action).toBe("storage_exhaustion");
  });

  it("still retries an ordinary first technical failure once", () => {
    expect(decideTechnicalReviewFailure([], head, { status: "blocked", result: { reason: "merge_conflict" } }).action).toBe("retry");
  });
});

describe("automatic review repair", () => {
  it("permits a same-repository open PR at the exact head", () => {
    expect(decideRepairPushGuard({ state: "OPEN", headRefName: "feature", headRefOid: head }, "feature", head).action).toBe("push");
  });

  it("reports a changed head as stale", () => {
    expect(decideRepairPushGuard({ state: "OPEN", headRefName: "feature", headRefOid: "b".repeat(40) }, "feature", head).action).toBe("stale_head");
  });

  it("rejects a cross-repository repair target", () => {
    expect(decideRepairPushGuard({ state: "OPEN", isCrossRepository: true, headRefName: "feature", headRefOid: head }, "feature", head).action).toBe("blocked");
  });

  it("requires the active in-progress workflow state", () => {
    expect(() => requireManagedPr({ labels: [] }, { inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked" })).toThrow("in-progress");
  });

  it("rejects repair mutation while blocked", () => {
    expect(() => requireManagedPr({ labels: [{ name: "agent:in-progress" }, { name: "agent:blocked" }] }, { inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked" })).toThrow("in-progress");
  });

  it("requires configured workflow labels in finalizer arguments", () => {
    expect(() => parseFinalizerArgs([])).toThrow("--repo is required");
  });

  it("keeps repair recovery comments readable", () => {
    expect(recoveryComment({ expectedHead: head, reviewLabel: "agent:review", blockedLabel: "agent:blocked", attemptKey: "attempt" }, "check_failed", "Tests failed")).toContain("Automatic review repair stopped");
  });

  it("matches one repair result per required finding", () => {
    expect(sameFindingTitles([{ title: "A" }], ["A"])).toBe(true);
  });

  it("launches a later progress-qualified repair regardless of historical attempt count", () => {
    expect(selectRepairAttempt(historicalRepairMarkers(20), head, findings, automationLogin).action).toBe("launch_repair");
  });

  it("does not relaunch the same exact review result after many historical attempts", () => {
    const attempted = { body: renderRepairMarker(head, reviewResultFingerprint(findings)), author: { login: automationLogin } };

    expect(selectRepairAttempt([...historicalRepairMarkers(20), attempted], head, findings, automationLogin).action).toBe("already_attempted");
  });

  it("ignores repair markers from untrusted authors", () => {
    const untrusted = [{ body: renderRepairMarker(head, reviewResultFingerprint(findings)), author: { login: "untrusted-user" } }];

    expect(selectRepairAttempt(untrusted, head, findings, automationLogin).action).toBe("launch_repair");
  });

  it("keeps historical repair markers with finding counts readable", () => {
    const marker = renderRepairMarker(head, reviewResultFingerprint(findings)).replace(" -->", " findings=4 -->");

    expect(repairAttempts([{ body: marker }])[0].findingCount).toBe(4);
  });

  it("passes all current required findings together in one repair contract", () => {
    const second = { title: "Missing guard", body: "Reject stale input", path: "src/b.ts", line: 8, severity: "blocker" };

    expect(repairContract([...findings, second]).map((finding: Record<string, unknown>) => finding.title)).toEqual(["Lint contract failure", "Missing guard"]);
  });
});

describe("recovery of a stopped repair contract", () => {
  const { writeFileSync } = require("node:fs");
  const { recoverStoppedRepairContract } = require("../extensions/deadloop/automations/pr-review-repair-dispatch.cts");
  const { repairAttemptKey } = require("../extensions/deadloop/automations/pr-review-repair-state.cts");

  function retainedStoppedRepair(root: string, overrides: { titles?: string[]; promptFindings?: unknown[] } = {}): string {
    const key = repairAttemptKey(head, reviewResultFingerprint(findings));
    const runDir = path.join(root, "runs", "run-1");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "review-contract.json"), JSON.stringify({
      attemptKey: key,
      expectedHead: head,
      findingTitles: overrides.titles || findings.map((finding) => finding.title),
    }));
    const promptFile = path.join(runDir, "repair-prompt.md");
    writeFileSync(promptFile, repairWorkerPrompt("243", "agent/issue-243", head, overrides.promptFindings || findings, key,
      path.join(runDir, "promise.json"), "/worktree", {
        projectId: "demo",
        repoPath: "/repo",
        githubRepo: "owner/repo",
        stateDir: root,
        checkCommand: "npm test",
        workerAgent: "pi",
        workerModel: "",
        remote: "origin",
        reviewLabel: "agent:review",
        blockedLabel: "agent:blocked",
        inProgressLabel: "agent:in-progress",
        automationDir: "/automation",
        enabledAt: 1,
      }));
    writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
      attemptId: key,
      launchUuid: "launch-1",
      project: "demo",
      repository: "owner/repo",
      role: "review-repair",
      target: { kind: "pull-request", number: 243 },
      inputRevision: { head },
      branch: "agent/issue-243",
      worktreePath: path.join(root, "worktrees", "agent-issue-243"),
      agentName: "demo-pr-243-review-repair",
      workspaceLabel: "demo-pr-243-review-repair",
      promptFile,
      promiseFile: path.join(runDir, "promise.json"),
      phase: "authority_released",
      lastSuccessfulPhase: "agent_started",
      authorityRelease: { reason: "terminal_missing_report", releasedAt: "2026-07-04T00:00:00Z" },
    }));
    return key;
  }

  function stoppedRepairComments(_key: string) {
    return [{ author: { login: automationLogin }, body: `## Review result\n${renderRepairMarker(head, reviewResultFingerprint(findings))}` }];
  }

  it("recovers the exact stopped contract from its marker, retained journal, and prompt", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deadloop-repair-recovery-"));
    try {
      const key = retainedStoppedRepair(root);
      expect(recoverStoppedRepairContract({
        stateDir: root, prNumber: 243, expectedHead: head, comments: stoppedRepairComments(key), automationLogin,
      })).toMatchObject({ key, expectedHead: head });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns nothing when the pull request carries no unresolved repair marker for the head", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deadloop-repair-recovery-"));
    try {
      expect(recoverStoppedRepairContract({ stateDir: root, prNumber: 243, expectedHead: head, comments: [], automationLogin })).toBe(null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses recovered findings whose titles diverge from the retained contract", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deadloop-repair-recovery-"));
    try {
      const key = retainedStoppedRepair(root, { titles: ["A different finding"] });
      expect(() => recoverStoppedRepairContract({
        stateDir: root, prNumber: 243, expectedHead: head, comments: stoppedRepairComments(key), automationLogin,
      })).toThrow(/titles do not match/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses recovered findings that do not reproduce the recorded attempt key", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deadloop-repair-recovery-"));
    try {
      const key = retainedStoppedRepair(root, { promptFindings: [{ ...findings[0], body: "Tampered evidence" }] });
      expect(() => recoverStoppedRepairContract({
        stateDir: root, prNumber: 243, expectedHead: head, comments: stoppedRepairComments(key), automationLogin,
      })).toThrow(/do not reproduce/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
