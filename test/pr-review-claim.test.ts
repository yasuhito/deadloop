import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  activeReviewRequest,
  assertClaimMatchesCurrentConfiguration,
  claimContractMatchesConfiguration,
  classifyActiveReviewClaim,
  classifyPushedHeadAuthorityTransition,
  visiblyBlockReviewClaimTimeFailure,
  parseGithubRestDate,
  parsePaginatedGithubJson,
  parseReviewClaim,
  renderReviewClaimComment,
  savedReviewClaimContract,
  selectReviewClaimWinner,
  validateActiveReviewClaim,
  validatePushedHeadAuthorityTransition,
} = require("../extensions/deadloop/automations/pr-review-claim.ts");

const head = "a".repeat(40);
const request = { id: "event-22", event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } };
const managedLabels = [
  "agent:review",
  "agent:implement",
  "agent:update-branch",
  "agent:in-progress",
  "agent:blocked",
];
const activeState = { managedLabels, requestLabel: "agent:review", requiredLabels: ["agent:in-progress"] };
const binding = {
  repositoryId: "R_123",
  repository: "owner/repo",
  targetNumber: 24,
  requestEventId: "event-22",
  role: "reviewer",
  revision: head,
  owner: "host-a",
  authority: { durationSeconds: 3600 },
  activeState,
};
const liveTarget = { repositoryId: "R_123", repository: "owner/repo", targetNumber: 24 };

function claim(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    createdAt: "2026-07-20T10:01:00Z",
    updatedAt: "2026-07-20T10:01:00Z",
    author: { login: "deadloop-a" },
    body: renderReviewClaimComment(binding),
    ...overrides,
  };
}

describe("PR review GitHub claim", () => {
  it("identifies the latest review label event", () => {
    expect(activeReviewRequest([request, { ...request, id: "event-23", created_at: "2026-07-20T10:02:00Z" }], "agent:review")?.id).toBe("event-23");
  });

  it("chooses the earliest valid GitHub claim", () => {
    expect(selectReviewClaimWinner([claim({ id: 102, createdAt: "2026-07-20T10:02:00Z", updatedAt: "2026-07-20T10:02:00Z" }), claim()], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)?.id).toBe(101);
  });

  it("rejects a malformed claim", () => {
    expect(selectReviewClaimWinner([claim({ body: "<!-- deadloop:review-claim nope -->" })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("declares the configured authority duration in the marker", () => {
    expect(parseReviewClaim(renderReviewClaimComment(binding))?.authority).toEqual({ durationSeconds: 3600 });
  });

  it("declares the canonical active-review state contract in the marker", () => {
    expect(parseReviewClaim(renderReviewClaimComment(binding))?.activeState).toEqual(activeState);
  });

  it("rejects a marker whose authority duration differs from the configured contract", () => {
    const tampered = { ...binding, authority: { durationSeconds: 7200 } };
    expect(selectReviewClaimWinner([claim({ body: renderReviewClaimComment(tampered) })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("rejects a claim from an unauthorized identity", () => {
    expect(selectReviewClaimWinner([claim({ author: { login: "stranger" } })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("rejects a claim without GitHub edit evidence", () => {
    const missing = claim();
    delete missing.updatedAt;
    expect(selectReviewClaimWinner([missing], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("rejects a claim with malformed GitHub edit evidence", () => {
    expect(selectReviewClaimWinner([claim({ updatedAt: "not-a-time" })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("rejects an old comment edited to another request generation", () => {
    const edited = { ...binding, requestEventId: "event-23" };
    expect(selectReviewClaimWinner([claim({ createdAt: "2026-07-20T09:00:00Z", body: renderReviewClaimComment(edited) })], edited, ["deadloop-a"], new Date("2026-07-20T09:30:00Z"), 3600)).toBeNull();
  });

  it("rejects an old comment edited to another head", () => {
    const edited = { ...binding, revision: "b".repeat(40) };
    expect(selectReviewClaimWinner([claim({ createdAt: "2026-07-20T09:00:00Z", body: renderReviewClaimComment(edited) })], edited, ["deadloop-a"], new Date("2026-07-20T09:30:00Z"), 3600)).toBeNull();
  });

  it("rejects an old comment edited to another owner", () => {
    const edited = { ...binding, owner: "host-b" };
    expect(selectReviewClaimWinner([claim({ createdAt: "2026-07-20T09:00:00Z", body: renderReviewClaimComment(edited) })], edited, ["deadloop-a"], new Date("2026-07-20T09:30:00Z"), 3600)).toBeNull();
  });

  it("selects an unedited claim observed on a later page", () => {
    const editedOldClaim = claim({ id: 100, createdAt: "2026-07-20T09:00:00Z" });
    const comments = parsePaginatedGithubJson(JSON.stringify([[editedOldClaim], [claim()]]));
    expect(selectReviewClaimWinner(comments, binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)?.id).toBe(101);
  });

  it("rejects a claim for another revision", () => {
    const wrong = { ...binding, revision: "b".repeat(40) };
    expect(selectReviewClaimWinner([claim({ body: renderReviewClaimComment(wrong) })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("rejects a claim for an older request event", () => {
    const old = { ...binding, requestEventId: "event-21" };
    expect(selectReviewClaimWinner([claim({ body: renderReviewClaimComment(old) })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });

  it("combines every GitHub REST page before claim authorization", () => {
    expect(parsePaginatedGithubJson(JSON.stringify([[{ id: 1 }], [{ id: 2 }]]))).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("uses the authenticated REST Date header as server time", () => {
    expect(parseGithubRestDate("HTTP/2 200\r\ndate: Mon, 20 Jul 2026 10:03:00 GMT\r\n", new Date("2026-07-20T10:02:00Z"))?.toISOString()).toBe("2026-07-20T10:03:00.000Z");
  });

  it("rejects a missing REST Date header", () => {
    expect(parseGithubRestDate("HTTP/2 200\r\n", new Date("2026-07-20T10:02:00Z"))).toBeNull();
  });

  it("classifies missing REST Date separately after every active binding matches", () => {
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:in-progress" }] };

    expect(classifyActiveReviewClaim(pr, [request], [claim()], "", contract, liveTarget).kind).toBe("server_time_unverifiable");
  });

  it("classifies an edited claim as claim invalid even when REST Date is missing", () => {
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:in-progress" }] };

    expect(classifyActiveReviewClaim(pr, [request], [claim({ updatedAt: "2026-07-20T10:02:00Z" })], "", contract, liveTarget).kind).toBe("claim_invalid");
  });

  it("classifies an expired active claim separately", () => {
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:in-progress" }] };

    expect(classifyActiveReviewClaim(pr, [request], [claim()], "date: Mon, 20 Jul 2026 11:01:00 GMT", contract, liveTarget).kind).toBe("expired");
  });

  it("classifies missing REST Date separately after every repair-transition binding matches", () => {
    const repairedHead = "b".repeat(40);
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: repairedHead, labels: [{ name: "agent:in-progress" }] };

    expect(classifyPushedHeadAuthorityTransition(pr, [request], [claim()], "", contract, liveTarget, {
      originalHeadOid: head, headOid: repairedHead,
    }).kind).toBe("server_time_unverifiable");
  });

  function visibleTimeBlockScenario(classifications = ["server_time_unverifiable", "server_time_unverifiable"], retries = 1) {
    const comments: Array<Record<string, unknown>> = [];
    const labels = ["agent:in-progress", "customer:keep"];
    let observations = 0;
    for (let retry = 0; retry < retries; retry += 1) {
      visiblyBlockReviewClaimTimeFailure({
        contract: { binding, commentId: "101", automationLogin: "deadloop-a" },
        blockedLabel: "agent:blocked",
        observe: () => ({ kind: classifications[observations++] || "binding_mismatch", comments, labels }),
        comment: (body: string) => { comments.push({ id: 102, created_at: "2026-07-20T10:04:00Z", updated_at: "2026-07-20T10:04:00Z", user: { login: "deadloop-a" }, body }); },
        addBlocked: () => { labels.push("agent:blocked"); },
      });
    }
    return { comments, labels };
  }

  it("posts one visible explanation for a Date-only authority failure", () => {
    expect(visibleTimeBlockScenario().comments).toHaveLength(1);
  });

  it("adds only blocked while preserving the review generation and user labels", () => {
    expect(visibleTimeBlockScenario().labels).toEqual(["agent:in-progress", "customer:keep", "agent:blocked"]);
  });

  it("does not add blocked when non-time binding changes after the explanation", () => {
    expect(visibleTimeBlockScenario(["server_time_unverifiable", "binding_mismatch"]).labels).toEqual(["agent:in-progress", "customer:keep"]);
  });

  it("does not duplicate visible Date-failure effects on retry", () => {
    const result = visibleTimeBlockScenario(undefined, 2);
    expect({ comments: result.comments.length, blocked: result.labels.filter((label) => label === "agent:blocked").length }).toEqual({ comments: 1, blocked: 1 });
  });

  it("does not trust a visible-block marker copied by another commenter", () => {
    const result = visibleTimeBlockScenario();
    result.labels.splice(result.labels.indexOf("agent:blocked"), 1);
    (result.comments[0].user as { login: string }).login = "stranger";
    visiblyBlockReviewClaimTimeFailure({
      contract: { binding, commentId: "101", automationLogin: "deadloop-a" },
      blockedLabel: "agent:blocked",
      observe: () => ({ kind: "server_time_unverifiable", comments: result.comments, labels: result.labels }),
      comment: (body: string) => { result.comments.push({ id: 103, created_at: "2026-07-20T10:05:00Z", updated_at: "2026-07-20T10:05:00Z", user: { login: "deadloop-a" }, body }); },
      addBlocked: () => { result.labels.push("agent:blocked"); },
    });

    expect(result.comments).toHaveLength(2);
  });

  it("rejects a malformed REST Date header", () => {
    expect(parseGithubRestDate("date: not-a-date", new Date("2026-07-20T10:02:00Z"))).toBeNull();
  });

  it("rejects REST Date evidence older than the protected observation", () => {
    expect(parseGithubRestDate("date: Mon, 20 Jul 2026 10:01:00 GMT", new Date("2026-07-20T10:02:00Z"))).toBeNull();
  });

  it("expires a claim at the exact authority boundary", () => {
    expect(selectReviewClaimWinner([claim()], binding, ["deadloop-a"], new Date("2026-07-20T11:01:00Z"), 3600)).toBeNull();
  });

  it("rejects a claim when the live repository ID differs", () => {
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:in-progress" }] };

    expect(validateActiveReviewClaim(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, {
      repositoryId: "R_other", repository: "owner/repo", targetNumber: 24,
    })).toBe(false);
  });

  it("rejects a claim when the live canonical repository name differs", () => {
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:in-progress" }] };

    expect(validateActiveReviewClaim(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, {
      repositoryId: "R_123", repository: "owner/renamed", targetNumber: 24,
    })).toBe(false);
  });

  it("rejects a claim when the live target PR differs", () => {
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:in-progress" }] };

    expect(validateActiveReviewClaim(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, {
      repositoryId: "R_123", repository: "owner/repo", targetNumber: 25,
    })).toBe(false);
  });

  it("allows an unrelated user label beside the exact active managed state", () => {
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
      managedLabels: ["agent:review", "agent:implement", "agent:update-branch", "agent:in-progress", "agent:blocked"],
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:in-progress" }, { name: "customer:important" }] };

    expect(validateActiveReviewClaim(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, liveTarget)).toBe(true);
  });

  it("rejects later GitHub effects after the active claim is revoked", () => {
    const contract = {
      binding,
      commentId: "101",
      authorizedLogins: ["deadloop-a"],
      authoritySeconds: 3600,
      requestLabel: "agent:review",

      inProgressLabel: "agent:in-progress",
      blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:blocked" }] };
    const headers = "date: Mon, 20 Jul 2026 10:03:00 GMT";
    expect(validateActiveReviewClaim(pr, [request], [claim()], headers, contract, liveTarget)).toBe(false);
  });

  it("rejects an edited winning marker whose owner no longer matches the persisted claim", () => {
    const editedBinding = { ...binding, owner: "host-b" };
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: head, labels: [{ name: "agent:in-progress" }] };
    const edited = claim({ body: renderReviewClaimComment(editedBinding), updatedAt: "2026-07-20T10:02:00Z" });

    expect(validateActiveReviewClaim(pr, [request], [edited], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, liveTarget)).toBe(false);
  });

  it("rejects a repair transition when the live repository ID differs", () => {
    const repairedHead = "b".repeat(40);
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: repairedHead, labels: [{ name: "agent:in-progress" }] };

    expect(validatePushedHeadAuthorityTransition(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, {
      repositoryId: "R_other", repository: "owner/repo", targetNumber: 24,
    }, { originalHeadOid: head, headOid: repairedHead })).toBe(false);
  });

  it("rejects a repair transition when the live canonical repository name differs", () => {
    const repairedHead = "b".repeat(40);
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: repairedHead, labels: [{ name: "agent:in-progress" }] };

    expect(validatePushedHeadAuthorityTransition(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, {
      repositoryId: "R_123", repository: "owner/renamed", targetNumber: 24,
    }, { originalHeadOid: head, headOid: repairedHead })).toBe(false);
  });

  it("rejects a repair transition when the live target PR differs", () => {
    const repairedHead = "b".repeat(40);
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: repairedHead, labels: [{ name: "agent:in-progress" }] };

    expect(validatePushedHeadAuthorityTransition(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, {
      repositoryId: "R_123", repository: "owner/repo", targetNumber: 25,
    }, { originalHeadOid: head, headOid: repairedHead })).toBe(false);
  });

  it("requires an explicit repair transition before an old-head claim can authorize a repaired head", () => {
    const repairedHead = "b".repeat(40);
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: repairedHead, labels: [{ name: "agent:in-progress" }] };

    expect(validatePushedHeadAuthorityTransition(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, liveTarget, {
      originalHeadOid: head, headOid: repairedHead,
    })).toBe(true);
  });

  it("rejects an old-head claim as ordinary authority for a repaired head", () => {
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    const pr = { state: "OPEN", headRefOid: "b".repeat(40), labels: [{ name: "agent:in-progress" }, { name: "agent:in-progress" }] };

    expect(validateActiveReviewClaim(pr, [request], [claim()], "date: Mon, 20 Jul 2026 10:03:00 GMT", contract, liveTarget)).toBe(false);
  });

  it.each([
    ["authoritySeconds", (value: any) => ({ ...value, authoritySeconds: 7200 })],
    ["managed label", (value: any) => ({ ...value, blockedLabel: "attacker:state" })],
    ["repository", (value: any) => ({ ...value, binding: { ...value.binding, repository: "other/repo" } })],
    ["target", (value: any) => ({ ...value, binding: { ...value.binding, targetNumber: 25 } })],
    ["request", (value: any) => ({ ...value, binding: { ...value.binding, requestEventId: "event-evil" } })],
    ["head", (value: any) => ({ ...value, binding: { ...value.binding, revision: "b".repeat(40) } })],
    ["owner", (value: any) => ({ ...value, binding: { ...value.binding, owner: "host-evil" } })],
  ])("rejects caller tampering with saved claim %s before authorization", (_name, mutate) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-claim-"));
    const runDir = path.join(root, "runs", "attempt");
    fs.mkdirSync(runDir, { recursive: true });
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    fs.writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
      attemptId: "attempt", launchUuid: "launch", project: "demo", repository: binding.repository,
      role: "reviewer", target: { kind: "pull-request", number: 24 }, inputRevision: { head },
      branch: "feature", worktreePath: "/worktree", agentName: "reviewer", workspaceLabel: "reviewer",
      promptFile: "/prompt", promiseFile: "/promise", phase: "agent_started", lastSuccessfulPhase: "agent_started",
      reviewClaim: contract,
    }));
    try {
      expect(() => savedReviewClaimContract(path.join(runDir, "attempt.json"), mutate(contract), {
        stateDir: root, githubRepo: binding.repository, projectId: "demo", targetNumber: 24,
      })).toThrow("does not exactly match");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ["reviewer", "reviewer"],
    ["review repair", "review-repair"],
    ["branch update", "branch-update"],
  ] as const)("returns the saved claim contract a %s attempt holds", (_name, role) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-claim-role-"));
    const runDir = path.join(root, "runs", "attempt");
    fs.mkdirSync(runDir, { recursive: true });
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    };
    fs.writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
      attemptId: "attempt", launchUuid: "launch", project: "demo", repository: binding.repository,
      role, target: { kind: "pull-request", number: 24 }, inputRevision: { head },
      branch: "feature", worktreePath: "/worktree", agentName: "agent", workspaceLabel: role,
      promptFile: "/prompt", promiseFile: "/promise", phase: "agent_started", lastSuccessfulPhase: "agent_started",
      reviewClaim: contract,
    }));
    try {
      expect(savedReviewClaimContract(path.join(runDir, "attempt.json"), contract, {
        stateDir: root, githubRepo: binding.repository, projectId: "demo", targetNumber: 24,
      })).toEqual(contract);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects a role that never holds a saved claim contract", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-claim-worker-"));
    const runDir = path.join(root, "runs", "attempt");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
      attemptId: "attempt", launchUuid: "launch", project: "demo", repository: binding.repository,
      role: "worker", target: { kind: "pull-request", number: 24 }, inputRevision: { head },
      branch: "feature", worktreePath: "/worktree", agentName: "worker", workspaceLabel: "worker",
      promptFile: "/prompt", promiseFile: "/promise", phase: "agent_started", lastSuccessfulPhase: "agent_started",
      reviewClaim: { binding },
    }));
    try {
      expect(() => savedReviewClaimContract(path.join(runDir, "attempt.json"), undefined, {
        stateDir: root, githubRepo: binding.repository, projectId: "demo", targetNumber: 24,
      })).toThrow("saved active work claim is missing");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an arbitrary attempt.json outside the canonical runs directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-claim-path-"));
    const arbitrary = path.join(root, "attempt.json");
    fs.writeFileSync(arbitrary, "{}");
    try {
      expect(() => savedReviewClaimContract(arbitrary, {}, {
        stateDir: root, githubRepo: binding.repository, projectId: "demo", targetNumber: 24,
      })).toThrow("canonical runs directory");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ["reviewer runtime", { reviewerMaxRuntimeSeconds: 3499, authoritySeconds: 3599 }],
    ["cleanup grace", { cleanupGraceSeconds: 99, authoritySeconds: 3599 }],
    ["managed labels", { managedLabels: [...managedLabels.slice(0, 5), "agent:halted"] }],
    ["repository ID", { repositoryId: "R_other" }],
    ["repository name", { repository: "owner/renamed" }],
    ["authorized identities", { authorizedLogins: ["deadloop-a", "deadloop-b"] }],
    ["authenticated login", { authenticatedLogin: "deadloop-b" }],
    ["reviewer agent", { reviewerAgent: "claude" }],
  ])("rejects current activation changes in %s", (_name, override) => {
    const contract = {
      binding, authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi",
      reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100,
      authoritySeconds: 3600, reviewLabel: "agent:review",
      inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked", managedLabels,
    };
    expect(() => assertClaimMatchesCurrentConfiguration(contract, {
      reviewerMaxRuntimeSeconds: 3500,
      cleanupGraceSeconds: 100,
      authoritySeconds: 3600,
      managedLabels,
      requestLabel: "agent:review",
      requiredLabels: ["agent:in-progress"],
      repositoryId: "R_123",
      repository: "owner/repo",
      authorizedLogins: ["deadloop-a"],
      authenticatedLogin: "deadloop-a",
      reviewerAgent: "pi",
      ...override,
    })).toThrow("current enablement");
  });

  it("rejects a saved claim when the current authority duration differs", () => {
    const contract = {
      binding, authoritySeconds: 3600, inProgressLabel: "agent:in-progress", managedLabels,
    };
    expect(claimContractMatchesConfiguration(contract, {
      authoritySeconds: 7200, managedLabels, requestLabel: "agent:review", requiredLabels: ["agent:in-progress"],
    })).toBe(false);
  });

  it("rejects a saved claim when the current active-state contract differs", () => {
    const contract = {
      binding, authoritySeconds: 3600, inProgressLabel: "agent:in-progress", managedLabels,
    };
    expect(claimContractMatchesConfiguration(contract, {
      authoritySeconds: 3600, managedLabels, requestLabel: "agent:review", requiredLabels: ["agent:in-progress"],
    })).toBe(false);
  });

  it("rejects a saved contract whose authority duration disagrees with its marker binding", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-review-claim-contract-"));
    const runDir = path.join(root, "runs", "attempt");
    fs.mkdirSync(runDir, { recursive: true });
    const contract = {
      binding, commentId: "101", authorizedLogins: ["deadloop-a"], automationLogin: "deadloop-a", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 7200,
      requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
      managedLabels,
    };
    fs.writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
      attemptId: "attempt", launchUuid: "launch", project: "demo", repository: binding.repository,
      role: "reviewer", target: { kind: "pull-request", number: 24 }, inputRevision: { head },
      branch: "feature", worktreePath: "/worktree", agentName: "reviewer", workspaceLabel: "reviewer",
      promptFile: "/prompt", promiseFile: "/promise", phase: "agent_started", lastSuccessfulPhase: "agent_started",
      reviewClaim: contract,
    }));
    try {
      expect(() => savedReviewClaimContract(path.join(runDir, "attempt.json"), contract, {
        stateDir: root, githubRepo: binding.repository, projectId: "demo", targetNumber: 24,
      })).toThrow("internally inconsistent");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("does not let marker expiry extend authority", () => {
    const original = renderReviewClaimComment(binding);
    const encoded = original.match(/v1=([A-Za-z0-9_-]+)/)?.[1] || "";
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const extended = Buffer.from(JSON.stringify({ ...payload, expiresAt: "2099-01-01T00:00:00Z" })).toString("base64url");
    const body = original.replace(encoded, extended);
    expect(selectReviewClaimWinner([claim({ body, createdAt: "2026-07-20T08:00:00Z", updatedAt: "2026-07-20T08:00:00Z" })], binding, ["deadloop-a"], new Date("2026-07-20T10:03:00Z"), 3600)).toBeNull();
  });
});
