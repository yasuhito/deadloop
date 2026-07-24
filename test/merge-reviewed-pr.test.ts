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
  labels: [{ name: "agent:review" }, { name: "agent:reviewing" }],
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
      reviewLabel: "agent:review",
      reviewingLabel: "agent:reviewing",
      blockedLabel: "agent:blocked",
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
        mutationObservedInsideLock = lockHeld;
        const status = options.mergeStatus ?? 0;
        return { status, stdout: "", stderr: status ? "head commit changed" : "" };
      },
    },
  );
  return { action, commands, configObservedInsideLock, mutationObservedInsideLock };
}

describe("reviewed PR merge", () => {
  it("passes the reviewed head to GitHub's atomic merge guard", () => {
    expect(runMerge().commands[1]).toEqual([
      "gh", "pr", "merge", "24", "-R", "owner/repo",
      "--squash", "--delete-branch", "--match-head-commit", expectedHead,
    ]);
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

  it("fails closed when a required review label is removed", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, labels: [{ name: "agent:review" }] } })).toThrow("required review labels");
  });

  it("fails closed when the blocked label is added", () => {
    expect(() => runMerge({ pr: { ...eligiblePr, labels: [...eligiblePr.labels, { name: "agent:blocked" }] } })).toThrow("PR is blocked");
  });

  it("fails closed when GitHub's atomic head guard rejects the merge", () => {
    expect(() => runMerge({ mergeStatus: 1 })).toThrow("head commit changed");
  });
});
