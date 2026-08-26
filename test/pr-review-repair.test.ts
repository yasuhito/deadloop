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
