import { describe, expect, it } from "vitest";

const { mergeReviewedPr } = require("../extensions/deadloop/automations/merge-reviewed-pr.ts");
const { renderReviewClaimComment } = require("../extensions/deadloop/automations/pr-review-claim.ts");

const expectedHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const eligiblePr = {
  state: "OPEN",
  isDraft: false,
  headRefOid: expectedHead,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  labels: [{ name: "agent:in-progress" }],
};
const approvedReview = {
  status: "complete",
  promise: { status: "complete", outcome: "approved", reviewedHead: expectedHead, reason: "", summary: "approved", findings: [] },
};

function runMerge(options: {
  mergeStatus?: number;
  autoMergeEnabled?: boolean | boolean[];
  enabled?: { firstEnableAutoMerge: boolean; firstStartPending: boolean; autoMergeAcknowledged: boolean };
  pr?: Record<string, unknown>;
  review?: typeof approvedReview;
  reviewClaim?: boolean;
} = {}) {
  const commands: string[][] = [];
  let lockHeld = false;
  let configObservedInsideLock = false;
  let mutationObservedInsideLock = false;
  let autoMergeChecks = 0;
  const action = mergeReviewedPr(
    {
      projectRepo: "/repo",
      githubRepo: "owner/repo",
      stateDir: "/state",
      enabledAt: 1,
      pr: "24",
      expectedHead,
      reviewPromise: "/state/reviewer-promise.json",
      inProgressLabel: "agent:in-progress",
      blockedLabel: "agent:blocked",
      ...(options.reviewClaim !== false ? { reviewClaim: {
        binding: { repositoryId: "R_repo", repository: "owner/repo", targetNumber: 24, requestEventId: "22", role: "reviewer", revision: expectedHead, owner: "host-a" },
        commentId: "101", authorizedLogins: ["deadloop-bot"], authoritySeconds: 3600,
        reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
      } } : {}),
    },
    {
      withLock: (_project: unknown, operation: (enabled: unknown) => number) => {
        lockHeld = true;
        try {
          return operation(options.enabled || {
            firstEnableAutoMerge: false,
            firstStartPending: false,
            autoMergeAcknowledged: false,
          });
        } finally {
          lockHeld = false;
        }
      },
      isAutoMergeEnabled: () => {
        configObservedInsideLock = lockHeld;
        const configured = options.autoMergeEnabled ?? true;
        return Array.isArray(configured)
          ? (configured[autoMergeChecks++] ?? configured.at(-1) ?? false)
          : configured;
      },
      validateReviewPromise: () => options.review || approvedReview,
      run: (args: string[]) => {
        commands.push(args);
        if (args[2] === "view") {
          return { status: 0, stdout: JSON.stringify(options.pr || eligiblePr), stderr: "" };
        }
        if (args.some((arg) => arg.endsWith("/events"))) {
          return { status: 0, stdout: JSON.stringify([[], [{ id: 22, event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } }]]), stderr: "" };
        }
        if (args.some((arg) => arg.endsWith("/comments"))) {
          const binding = { repositoryId: "R_repo", repository: "owner/repo", targetNumber: 24, requestEventId: "22", role: "reviewer", revision: expectedHead, owner: "host-a" };
          return { status: 0, stdout: JSON.stringify([[], [{ id: 101, created_at: "2026-07-20T10:01:00Z", updated_at: "2026-07-20T10:01:00Z", user: { login: "deadloop-bot" }, body: renderReviewClaimComment(binding) }]]), stderr: "" };
        }
        if (args[1] === "api") return { status: 0, stdout: "date: Mon, 20 Jul 2026 10:03:00 GMT", stderr: "" };
        mutationObservedInsideLock = lockHeld;
        const status = options.mergeStatus ?? 0;
        return { status, stdout: "", stderr: status ? "head commit changed" : "" };
      },
    },
  );
  return { action, commands, configObservedInsideLock, mutationObservedInsideLock };
}

describe("reviewed PR merge", () => {
  it("fails closed when the active review claim is omitted", () => {
    expect(() => runMerge({ reviewClaim: false })).toThrow("active review claim is required");
  });

  it("passes the reviewed head to GitHub's atomic merge guard", () => {
    expect(runMerge().commands.at(-1)).toEqual([
      "gh", "pr", "merge", "24", "-R", "owner/repo",
      "--squash", "--delete-branch", "--match-head-commit", expectedHead,
    ]);
  });

  it("authorizes merge when the active claim is on a later REST page", () => {
    expect(runMerge({ reviewClaim: true }).action).toBe(0);
  });

  it("revalidates current auto-merge configuration while holding the enablement lock", () => {
    expect(runMerge().configObservedInsideLock).toBe(true);
  });

  it("holds the enablement lock while performing the merge mutation", () => {
    expect(runMerge().mutationObservedInsideLock).toBe(true);
  });

  it("fails closed when auto-merge was disabled after launch", () => {
    expect(() => runMerge({ autoMergeEnabled: false })).toThrow("autoMerge is not currently enabled");
  });

  it("rechecks auto-merge intent immediately before the merge mutation", () => {
    expect(() => runMerge({ autoMergeEnabled: [true, false] })).toThrow("autoMerge is not currently enabled");
  });

  it("rejects auto-merge during the first safe start", () => {
    expect(() => runMerge({ enabled: { firstEnableAutoMerge: true, firstStartPending: true, autoMergeAcknowledged: false } })).toThrow("first safe start");
  });

  it("rejects a preexisting true setting until it is acknowledged", () => {
    expect(() => runMerge({ enabled: { firstEnableAutoMerge: true, firstStartPending: false, autoMergeAcknowledged: false } })).toThrow("has not been acknowledged");
  });

  it("allows an acknowledged post-enable true setting", () => {
    expect(runMerge({ enabled: { firstEnableAutoMerge: true, firstStartPending: false, autoMergeAcknowledged: true } }).action).toBe(0);
  });

  it("fails closed without a validated reviewer approval", () => {
    expect(() => runMerge({ review: { status: "none" } as typeof approvedReview })).toThrow("reviewer approval");
  });

  it("fails closed when reviewer approval targets another head", () => {
    expect(() => runMerge({ review: { ...approvedReview, promise: { ...approvedReview.promise, reviewedHead: "b".repeat(40) } } })).toThrow("reviewed head");
  });

  it("fails closed when review requests changes", () => {
    expect(() => runMerge({ review: { ...approvedReview, promise: { ...approvedReview.promise, outcome: "changes_requested" } } })).toThrow("not approved");
  });

  it("fails closed when the PR head changes during final revalidation", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, headRefOid: "b".repeat(40) } })).toThrow("PR head changed");
  });

  it("fails closed when the PR is no longer open", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, state: "CLOSED" } })).toThrow("no longer open");
  });

  it("fails closed when the PR becomes a draft", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, isDraft: true } })).toThrow("PR is draft");
  });

  it("fails closed when GitHub reports mergeability as unknown", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, mergeable: "UNKNOWN" } })).toThrow("mergeability");
  });

  it("fails closed when GitHub reports a blocked merge state", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, mergeStateStatus: "BLOCKED" } })).toThrow("merge state");
  });

  it("fails closed when no CI checks are reported", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, statusCheckRollup: [] } })).toThrow("CI checks are missing");
  });

  it("fails closed while CI is pending", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, statusCheckRollup: [{ status: "IN_PROGRESS", conclusion: "" }] } })).toThrow("CI checks have not completed");
  });

  it("fails closed when CI fails", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] } })).toThrow("CI checks did not pass");
  });

  it("fails closed when a CI result is ambiguous", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, statusCheckRollup: [{}] } })).toThrow("CI check state is unknown");
  });

  it("fails closed when the active in-progress claim is removed", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, labels: [] } })).toThrow("required in-progress claim label");
  });

  it("fails closed when the blocked label is added", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, labels: [...eligiblePr.labels, { name: "agent:blocked" }] } })).toThrow("PR is blocked");
  });

  it("fails closed when GitHub's atomic head guard rejects the merge", () => {
    expect(() => runMerge({ mergeStatus: 1 })).toThrow("head commit changed");
  });
});
