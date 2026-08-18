import { describe, expect, it } from "vitest";

const { mergeReviewedPr } = require("../extensions/deadloop/automations/merge-reviewed-pr.ts");

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
  enabled?: { githubRepositoryId: string; githubRepo: string; firstEnableAutoMerge: boolean; firstStartPending: boolean; autoMergeAcknowledged: boolean };
  pr?: Record<string, unknown>;
  review?: typeof approvedReview;
  verificationError?: string;
  verificationChangesAfterPrRead?: boolean;
  onMerge?: () => void;
  repository?: { id: string; nameWithOwner: string };
  finalRace?: "head" | "repository" | "policy" | "history";
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
  let repositoryReads = 0;
  let markedReady = false;
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
    },
    {
      loadAttemptRecord: () => ({
        role: "reviewer", repository: "owner/repo", target: { kind: "pull-request", number: 24 },
        inputRevision: { head: expectedHead },
      }),
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
        if (options.finalRace === "policy" && repositoryReads >= 3) {
          throw new Error("required verification blocked: stale_policy; current policy differs from the fixed attempt contract");
        }
      },
      assertReviewHistoryFresh: () => {
        if (options.finalRace === "history" && repositoryReads >= 3) {
          throw new Error("PR review history changed; automatic merge stopped");
        }
        options.onHistoryCheck?.(++historyChecks);
      },
      run: (args: string[]) => {
        commands.push(args);
        if (args[1] === "repo" && args[2] === "view") {
          repositoryReads += 1;
          const repository = repositoryReads >= 3 && options.finalRace === "repository"
            ? { id: "R_other", nameWithOwner: "other/repo" }
            : options.repository || { id: "R_repo", nameWithOwner: "owner/repo" };
          return { status: 0, stdout: JSON.stringify(repository), stderr: "" };
        }
        if (args[1] === "pr" && args[2] === "ready") {
          markedReady = true;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[2] === "view") {
          prReads += 1;
          const observed = options.pr || eligiblePr;
          const basePr = markedReady ? { ...observed, isDraft: false, mergeStateStatus: "CLEAN" } : observed;
          const finalPr = prReads >= 3 && options.finalRace === "head"
            ? { ...basePr, headRefOid: "b".repeat(40) }
            : basePr;
          return { status: 0, stdout: JSON.stringify(finalPr), stderr: "" };
        }
        if (args[1] === "api" && args[2] === "user") return { status: 0, stdout: "deadloop-bot\n", stderr: "" };
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
  it("passes the reviewed head to GitHub's atomic merge guard", () => {
    expect(runMerge().commands.at(-1)).toEqual([
      "gh", "pr", "merge", "24", "-R", "owner/repo",
      "--squash", "--delete-branch", "--match-head-commit", expectedHead,
    ]);
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

  it("does not merge when required-verification policy changes during the final PR read", () => {
    let merges = 0;
    try {
      runMerge({ verificationChangesAfterPrRead: true, onMerge: () => { merges += 1; } });
    } catch {
      // The changed policy must stop the guarded merge.
    }
    expect(merges).toBe(0);
  });

  it("does not merge when the trusted policy changes during the final revalidation", () => {
    let merges = 0;
    try {
      runMerge({ finalRace: "policy", onMerge: () => { merges += 1; } });
    } catch {
      // The changed policy must stop the guarded merge.
    }
    expect(merges).toBe(0);
  });

  it("does not merge when the accepted review history changes during the final revalidation", () => {
    let merges = 0;
    try {
      runMerge({ finalRace: "history", onMerge: () => { merges += 1; } });
    } catch {
      // The changed history must stop the guarded merge.
    }
    expect(merges).toBe(0);
  });

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
    expect(() => runMerge({ pr: { ...eligiblePr, isDraft: undefined } })).toThrow("draft state is unknown");
  });

  it("marks a reviewed draft ready before the guarded merge", () => {
    const run = runMerge({ pr: { ...eligiblePr, isDraft: true, mergeStateStatus: "DRAFT" } });

    expect(run.commands.some((command) => command[1] === "pr" && command[2] === "ready")).toBe(true);
  });

  it("merges the reviewed draft after it becomes ready", () => {
    const run = runMerge({ pr: { ...eligiblePr, isDraft: true, mergeStateStatus: "DRAFT" } });

    expect(run.commands.at(-1)?.slice(1, 3)).toEqual(["pr", "merge"]);
  });

  it("does not repeat the ready transition for a pull request that is already ready", () => {
    const run = runMerge({});

    expect(run.commands.some((command) => command[1] === "pr" && command[2] === "ready")).toBe(false);
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

  it("fails closed when the active in-progress label is removed", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, labels: [] } })).toThrow("required in-progress label");
  });

  it("fails closed when the blocked label is added", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, labels: [...eligiblePr.labels, { name: "agent:blocked" }] } })).toThrow("PR is blocked");
  });

  it("fails closed when the live repository ID differs from enablement", () => {
    expect(() => runMerge({ repository: { id: "R_other", nameWithOwner: "owner/repo" } })).toThrow("repository identity changed");
  });

  it("fails closed when the live repository name differs from enablement", () => {
    expect(() => runMerge({ repository: { id: "R_repo", nameWithOwner: "other/repo" } })).toThrow("repository identity changed");
  });

  it("fails closed when the exact PR head races a final merge guard", () => {
    expect(() => runMerge({ finalRace: "head" })).toThrow("PR head changed");
  });

  it("fails closed when repository identity races immediately before merge", () => {
    expect(() => runMerge({ finalRace: "repository" })).toThrow("repository identity changed");
  });

  it("fails closed when GitHub's atomic head guard rejects the merge", () => {
    expect(() => runMerge({ mergeStatus: 1 })).toThrow("head commit changed");
  });
});
