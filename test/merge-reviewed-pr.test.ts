import { describe, expect, it } from "vitest";

const { mergeReviewedPr } = require("../extensions/deadloop/automations/merge-reviewed-pr.ts");
const { renderReviewClaimComment } = require("../extensions/deadloop/automations/pr-review-claim.ts");

const expectedHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const activeReviewState = {
  managedLabels: ["agent:review", "agent:reviewing", "agent:implement", "agent:update-branch", "agent:in-progress", "agent:blocked"],
  requestLabel: "agent:review",
  requiredLabels: ["agent:in-progress"],
};
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
  enabled?: { githubRepositoryId: string; githubRepo: string; firstEnableAutoMerge: boolean; firstStartPending: boolean; autoMergeAcknowledged: boolean };
  pr?: Record<string, unknown>;
  review?: typeof approvedReview;
  verificationError?: string;
  verificationChangesAfterPrRead?: boolean;
  onMerge?: () => void;
  reviewClaim?: boolean;
  repository?: { id: string; nameWithOwner: string };
  claimTargetNumber?: number;
  finalRace?: "expiry" | "comment" | "request" | "head" | "labels";
  currentConfiguration?: Record<string, unknown>;
  dateUnavailable?: boolean;
  editedClaim?: boolean;
  onHistoryCheck?: (count: number) => void;
} = {}) {
  const commands: string[][] = [];
  let lockHeld = false;
  let configObservedInsideLock = false;
  let mutationObservedInsideLock = false;
  let autoMergeChecks = 0;
  let verificationChecks = 0;
  let historyChecks = 0;
  let prReads = 0;
  let eventReads = 0;
  let commentReads = 0;
  let dateReads = 0;
  const authoritativeReviewClaim = {
    binding: {
      repositoryId: "R_repo", repository: "owner/repo", targetNumber: options.claimTargetNumber ?? 24,
      requestEventId: "22", role: "reviewer", revision: expectedHead, owner: "host-a",
      authority: { durationSeconds: 3600 }, activeState: activeReviewState,
    },
    commentId: "101", authorizedLogins: ["deadloop-bot"], automationLogin: "deadloop-bot", reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 3500, cleanupGraceSeconds: 100, authoritySeconds: 3600,
    reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
  };
  let action: number;
  try {
    action = mergeReviewedPr(
    {
      attemptRecord: "/state/runs/reviewer/attempt.json",
      projectRepo: "/repo",
      githubRepo: "owner/repo",
      stateDir: "/state",
      enabledAt: 1,
      pr: "24",
      expectedHead,
      reviewPromise: "/state/reviewer-promise.json",
      historyObservation: "/state/runs/reviewer/pr-review-history-accepted.json",
      inProgressLabel: "agent:in-progress",
      blockedLabel: "agent:blocked",
      ...(options.reviewClaim !== false ? { reviewClaim: authoritativeReviewClaim } : {}),
    },
    {
      ...(options.reviewClaim !== false ? {
        loadSavedReviewClaim: () => authoritativeReviewClaim,
        loadCurrentReviewClaimConfiguration: () => ({
          reviewerMaxRuntimeSeconds: 3500,
          cleanupGraceSeconds: 100,
          authoritySeconds: 3600,
          managedLabels: activeReviewState.managedLabels,
          requestLabel: "agent:review",
          requiredLabels: ["agent:in-progress"],
          repositoryId: "R_repo",
          repository: "owner/repo",
          authorizedLogins: ["deadloop-bot"],
          authenticatedLogin: "deadloop-bot",
          reviewerAgent: "pi",
          ...options.currentConfiguration,
        }),
      } : {}),
      withLock: (_project: unknown, operation: (enabled: unknown) => number) => {
        lockHeld = true;
        try {
          return operation({
            repoPath: "/repo",
            baseBranch: "origin/main",
            automationLogin: "deadloop-bot",
            ...(options.enabled || {
              githubRepositoryId: "R_repo",
              githubRepo: "owner/repo",
              firstEnableAutoMerge: false,
              firstStartPending: false,
              autoMergeAcknowledged: false,
            }),
          });
        } finally {
          lockHeld = false;
        }
      },
      isAutoMergeEnabled: () => {
        commands.push(["config"]);
        configObservedInsideLock = lockHeld;
        const configured = options.autoMergeEnabled ?? true;
        return Array.isArray(configured)
          ? (configured[autoMergeChecks++] ?? configured.at(-1) ?? false)
          : configured;
      },
      validateReviewPromise: () => options.review || approvedReview,
      assertReviewVerification: () => {
        verificationChecks += 1;
        if (options.verificationError) throw new Error(options.verificationError);
        if (options.verificationChangesAfterPrRead && prReads > 0 && verificationChecks > 1) {
          throw new Error("required verification policy changed");
        }
      },
      assertReviewHistoryFresh: () => options.onHistoryCheck?.(++historyChecks),
      run: (args: string[]) => {
        commands.push(args);
        if (args[1] === "repo" && args[2] === "view") {
          return { status: 0, stdout: JSON.stringify(options.repository || { id: "R_repo", nameWithOwner: "owner/repo" }), stderr: "" };
        }
        if (args[2] === "view") {
          prReads += 1;
          const basePr = options.pr || eligiblePr;
          const finalPr = prReads >= 3 && options.finalRace === "head"
            ? { ...basePr, headRefOid: "b".repeat(40) }
            : prReads >= 3 && options.finalRace === "labels"
              ? { ...basePr, labels: [...eligiblePr.labels, { name: "agent:blocked" }] }
              : basePr;
          return { status: 0, stdout: JSON.stringify(finalPr), stderr: "" };
        }
        if (args.some((arg) => arg.endsWith("/events"))) {
          eventReads += 1;
          const id = eventReads >= 2 && options.finalRace === "request" ? 23 : 22;
          return { status: 0, stdout: JSON.stringify([[], [{ id, event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } }]]), stderr: "" };
        }
        if (args.some((arg) => arg.endsWith("/comments"))) {
          commentReads += 1;
          const binding = {
            repositoryId: "R_repo", repository: "owner/repo", targetNumber: 24, requestEventId: "22",
            role: "reviewer", revision: expectedHead, owner: "host-a",
            authority: { durationSeconds: 3600 }, activeState: activeReviewState,
          };
          const comments = commentReads >= 2 && options.finalRace === "comment" ? [] : [{ id: 101, created_at: "2026-07-20T10:01:00Z", updated_at: options.editedClaim ? "2026-07-20T10:02:00Z" : "2026-07-20T10:01:00Z", user: { login: "deadloop-bot" }, body: renderReviewClaimComment(binding) }];
          return { status: 0, stdout: JSON.stringify([[], comments]), stderr: "" };
        }
        if (args[1] === "api" && args[2] === "user") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
        if (args[1] === "api") {
          dateReads += 1;
          const date = dateReads >= 2 && options.finalRace === "expiry" ? "Mon, 20 Jul 2026 11:01:00 GMT" : "Mon, 20 Jul 2026 10:03:00 GMT";
          return { status: 0, stdout: options.dateUnavailable ? "" : `date: ${date}`, stderr: "" };
        }
        options.onMerge?.();
        mutationObservedInsideLock = lockHeld;
        const status = options.mergeStatus ?? 0;
        return { status, stdout: "", stderr: status ? "head commit changed" : "" };
      },
    },
    );
  } catch (error) {
    Object.assign(error instanceof Error ? error : new Error(String(error)), { commands });
    throw error;
  }
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

  it("rejects merge when the live repository ID differs from the claim", () => {
    expect(() => runMerge({ repository: { id: "R_other", nameWithOwner: "owner/repo" } })).toThrow("reauthorized");
  });

  it("rejects merge when the live canonical repository name differs from the claim", () => {
    expect(() => runMerge({ repository: { id: "R_repo", nameWithOwner: "owner/renamed" } })).toThrow("reauthorized");
  });

  it("rejects merge when the actual target PR differs from the claim", () => {
    expect(() => runMerge({ claimTargetNumber: 25 })).toThrow("reauthorized");
  });

  it("visibly blocks ready/merge when only REST Date is unavailable", () => {
    let commands: string[][] = [];
    try { runMerge({ dateUnavailable: true }); } catch (error) { commands = (error as { commands?: string[][] }).commands || []; }

    expect(commands.some((command) => command[1] === "pr" && command[2] === "comment")).toBe(true);
  });

  it("adds only blocked at the ready/merge Date-failure seam", () => {
    let commands: string[][] = [];
    try { runMerge({ dateUnavailable: true }); } catch (error) { commands = (error as { commands?: string[][] }).commands || []; }

    expect(commands.find((command) => command[1] === "pr" && command[2] === "edit")?.slice(-2)).toEqual(["--add-label", "agent:blocked"]);
  });

  it("performs no ready/merge GitHub mutation for an edited claim with missing REST Date", () => {
    let commands: string[][] = [];
    try { runMerge({ dateUnavailable: true, editedClaim: true }); } catch (error) { commands = (error as { commands?: string[][] }).commands || []; }

    expect(commands.some((command) => command[1] === "pr" && ["comment", "edit", "merge"].includes(command[2]))).toBe(false);
  });

  it.each([
    ["shortened runtime", { reviewerMaxRuntimeSeconds: 3400, authoritySeconds: 3500 }],
    ["changed labels", { requestLabel: "agent:review-v2" }],
    ["changed identities", { authorizedLogins: ["deadloop-bot", "other-bot"] }],
    ["changed repository", { repositoryId: "R_other" }],
  ])("stops merge before mutation when current claim configuration has %s", (_name, currentConfiguration) => {
    expect(() => runMerge({ currentConfiguration })).toThrow("current enablement");
  });

  it("revalidates current auto-merge configuration while holding the enablement lock", () => {
    expect(runMerge().configObservedInsideLock).toBe(true);
  });

  it("rechecks review history freshness immediately before the merge mutation", () => {
    const counts: number[] = [];
    runMerge({ onHistoryCheck: (count) => counts.push(count) });
    expect(counts).toEqual([1, 2]);
  });

  it("holds the enablement lock while performing the merge mutation", () => {
    expect(runMerge().mutationObservedInsideLock).toBe(true);
  });

  it("fails closed when auto-merge was disabled after launch", () => {
    expect(() => runMerge({ autoMergeEnabled: false })).toThrow("autoMerge is not currently enabled");
  });

  it("rechecks auto-merge before the final fresh claim observation adjacent to merge", () => {
    const commands = runMerge().commands;
    expect(commands.slice(-9).map((args) => args.join(" "))).toEqual([
      "config",
      "gh pr view 24 -R owner/repo --json state,isDraft,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,labels",
      "gh api user --jq .login",
      "gh repo view owner/repo --json id,nameWithOwner",
      "gh pr view 24 -R owner/repo --json state,headRefOid,labels",
      "gh api --paginate --slurp repos/owner/repo/issues/24/events",
      "gh api --paginate --slurp repos/owner/repo/issues/24/comments",
      "gh api --include repos/owner/repo",
      `gh pr merge 24 -R owner/repo --squash --delete-branch --match-head-commit ${expectedHead}`,
    ]);
  });

  it("stops before the final claim observation when auto-merge is disabled", () => {
    expect(() => runMerge({ autoMergeEnabled: [true, false] })).toThrow("autoMerge is not currently enabled");
  });

  it("does not merge when required-verification policy changes during the final PR read", () => {
    let merges = 0;
    try {
      runMerge({ verificationChangesAfterPrRead: true, onMerge: () => { merges += 1; } });
    } catch {
      // The changed policy must stop the guarded merge.
    }
    expect(merges).toBe(0);
  });

  it.each([
    ["expiry", "reauthorized"],
    ["comment", "reauthorized"],
    ["request", "reauthorized"],
    ["head", "PR head changed"],
    ["labels", "PR is blocked"],
  ] as const)(
    "suppresses merge when %s changes during the final claim inspection",
    (finalRace, expected) => {
      expect(() => runMerge({ finalRace })).toThrow(expected);
    },
  );

  it("rejects auto-merge during the first safe start", () => {
    expect(() => runMerge({ enabled: { githubRepositoryId: "R_repo", githubRepo: "owner/repo", firstEnableAutoMerge: true, firstStartPending: true, autoMergeAcknowledged: false } })).toThrow("first safe start");
  });

  it("rejects a preexisting true setting until it is acknowledged", () => {
    expect(() => runMerge({ enabled: { githubRepositoryId: "R_repo", githubRepo: "owner/repo", firstEnableAutoMerge: true, firstStartPending: false, autoMergeAcknowledged: false } })).toThrow("has not been acknowledged");
  });

  it("allows an acknowledged post-enable true setting", () => {
    expect(runMerge({ enabled: { githubRepositoryId: "R_repo", githubRepo: "owner/repo", firstEnableAutoMerge: true, firstStartPending: false, autoMergeAcknowledged: true } }).action).toBe(0);
  });

  it("fails closed without a validated reviewer approval", () => {
    expect(() => runMerge({ review: { status: "none" } as typeof approvedReview })).toThrow("reviewer approval");
  });

  it("fails closed when current-head required verification is missing", () => {
    expect(() => runMerge({ verificationError: "required verification passed record is missing" })).toThrow("record is missing");
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
