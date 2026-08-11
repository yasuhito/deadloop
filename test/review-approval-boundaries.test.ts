import { describe, expect, it } from "vitest";

const { persistAuthorizedApproval } = require("../extensions/deadloop/automations/pr-review-repair-dispatch.ts");
const { handoffReviewedPr } = require("../extensions/deadloop/automations/handoff-reviewed-pr.ts");

const head = "a".repeat(40);
const acceptedHistory = { repository: "owner/repo", pullRequestNumber: 24, revision: "accepted", history: {} };
const approvedReview = {
  status: "complete",
  promise: { status: "complete", outcome: "approved", reviewedHead: head, findings: [] },
};
const args = {
  projectRepo: "/repo",
  githubRepo: "owner/repo",
  stateDir: "/state",
  enabledAt: 1,
  pr: "24",
  expectedHead: head,
  reviewPromise: "/state/runs/reviewer/promise.json",
  historyObservation: "/state/runs/reviewer/pr-review-history-accepted.json",
  reviewLabel: "agent:review",
  reviewingLabel: "agent:reviewing",
  inProgressLabel: "agent:in-progress",
  blockedLabel: "agent:blocked",
  humanLabel: "ready-for-human",
};

function runHandoff(options: {
  verificationError?: string;
  policyChanges?: boolean;
  headChangesDuringAuthorization?: boolean;
  headChangesDuringLabelMutation?: boolean;
  policyChangesDuringFinalPrRead?: boolean;
}): { edits: number; labels: string[] } {
  let edits = 0;
  let policyReads = 0;
  let verificationReads = 0;
  let prReads = 0;
  let requiredVerificationPolicyChanged = false;
  let liveHead = head;
  let labels = ["agent:in-progress"];
  try {
    handoffReviewedPr(args, {
      withLock: (_project: unknown, operation: (enabled: object, recheck: () => void) => number) => operation({ githubRepositoryId: "R_repo" }, () => {}),
      isAutoMergeEnabled: () => options.policyChanges === true && ++policyReads > 1,
      validateReviewPromise: () => approvedReview,
      readHistory: () => acceptedHistory,
      observeHistory: () => acceptedHistory,
      assertReviewVerification: () => {
        verificationReads += 1;
        if (options.verificationError) throw new Error(options.verificationError);
        if (requiredVerificationPolicyChanged && verificationReads > 1) throw new Error("required verification policy changed");
        if (options.headChangesDuringAuthorization) liveHead = "b".repeat(40);
      },
      run: (command: string[]) => {
        if (command[2] === "view") {
          prReads += 1;
          if (options.policyChangesDuringFinalPrRead && prReads === 2) requiredVerificationPolicyChanged = true;
          return {
            status: 0,
            stdout: JSON.stringify({ state: "OPEN", isDraft: false, headRefOid: liveHead, labels: labels.map((name) => ({ name })) }),
            stderr: "",
          };
        }
        edits += 1;
        if (command.includes("--add-label") && command.at(-1) === "ready-for-human") {
          if (options.headChangesDuringLabelMutation) liveHead = "b".repeat(40);
          labels = ["ready-for-human"];
        } else {
          labels = ["agent:in-progress"];
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
  } catch {
    // A rejected boundary is the expected path for these fixtures.
  }
  return { edits, labels };
}

function handoffMutationCount(options: Parameters<typeof runHandoff>[0]): number {
  return runHandoff(options).edits;
}

describe("review approval persistence boundary", () => {
  it("does not persist an approved marker when policy changes before the guarded mutation", () => {
    let policy = "fixed";
    let markers = 0;
    const authorize = () => {
      if (policy !== "fixed") throw new Error("stale_policy");
    };
    authorize();

    persistAuthorizedApproval(
      (mutation: () => void) => {
        policy = "changed";
        mutation();
      },
      authorize,
      () => { markers += 1; },
    );

    expect(markers).toBe(0);
  });
});

describe("reviewed PR human-handoff boundary", () => {
  it("rejects a missing host verification record before changing labels", () => {
    expect(handoffMutationCount({ verificationError: "required verification record is missing" })).toBe(0);
  });

  it("rejects a failed host verification record before changing labels", () => {
    expect(handoffMutationCount({ verificationError: "required verification did not pass" })).toBe(0);
  });

  it("rejects a host verification record for an old head before changing labels", () => {
    expect(handoffMutationCount({ verificationError: "required verification does not match the current target commit" })).toBe(0);
  });

  it("rejects a policy change before changing labels", () => {
    expect(handoffMutationCount({ policyChanges: true })).toBe(0);
  });

  it("rejects a head change during authorization before changing labels", () => {
    expect(handoffMutationCount({ headChangesDuringAuthorization: true })).toBe(0);
  });

  it("restores the active claim state when the head changes during the handoff mutation", () => {
    expect(runHandoff({ headChangesDuringLabelMutation: true })).toEqual({
      edits: 2,
      labels: ["agent:in-progress"],
    });
  });

  it("rejects required-verification policy changes during the final PR read", () => {
    expect(handoffMutationCount({ policyChangesDuringFinalPrRead: true })).toBe(0);
  });
});
