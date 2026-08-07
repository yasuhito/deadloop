import { describe, expect, it } from "vitest";

const { persistAuthorizedApproval } = require("../extensions/deadloop/automations/pr-review-repair-dispatch.ts");
const { handoffReviewedPr } = require("../extensions/deadloop/automations/handoff-reviewed-pr.ts");

const head = "a".repeat(40);
const args = {
  projectRepo: "/repo",
  githubRepo: "owner/repo",
  stateDir: "/state",
  enabledAt: 1,
  pr: "24",
  expectedHead: head,
  reviewPromise: "/state/runs/reviewer/promise.json",
  reviewLabel: "agent:review",
  reviewingLabel: "agent:reviewing",
  blockedLabel: "agent:blocked",
  humanLabel: "ready-for-human",
};

function handoffMutationCount(options: { verificationError?: string; policyChanges?: boolean }): number {
  let edits = 0;
  let policyReads = 0;
  try {
    handoffReviewedPr(args, {
      withLock: (_project: unknown, operation: (enabled: object, recheck: () => void) => number) => operation({ githubRepositoryId: "R_repo" }, () => {}),
      isAutoMergeEnabled: () => options.policyChanges === true && ++policyReads > 1,
      assertReviewVerification: () => {
        if (options.verificationError) throw new Error(options.verificationError);
      },
      run: (command: string[]) => {
        if (command[2] === "view") {
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              isDraft: false,
              headRefOid: head,
              labels: [{ name: "agent:review" }, { name: "agent:reviewing" }],
            }),
            stderr: "",
          };
        }
        edits += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    });
  } catch {
    // A rejected boundary is the expected path for these fixtures.
  }
  return edits;
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
});
