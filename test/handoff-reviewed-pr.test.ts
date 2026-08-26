import { describe, expect, it } from "vitest";

const { handoffReviewedPr } = require("../extensions/deadloop/automations/handoff-reviewed-pr.cts");

const expectedHead = "a".repeat(40);
const acceptedHistory = { repository: "owner/repo", pullRequestNumber: 24, revision: "accepted", history: {} };
const livePr = {
  state: "OPEN",
  isDraft: true,
  headRefOid: expectedHead,
  labels: [{ name: "agent:in-progress" }],
};
const approvedReview = {
  status: "complete",
  evidenceStrength: "strong",
  promise: { status: "complete", outcome: "approved", reviewedHead: expectedHead, findings: [] },
};

function runHandoff(
  observations: Array<Record<string, unknown>>,
  options: {
    validation?: Record<string, unknown>;
    prViews?: Array<Record<string, unknown>>;
  } = {},
) {
  const commands: string[][] = [];
  let observationIndex = 0;
  let prViewIndex = 0;
  let isDraft = livePr.isDraft;
  const labels = new Set(["agent:in-progress"]);
  const result = handoffReviewedPr(
    {
      projectRepo: "/repo", githubRepo: "owner/repo", stateDir: "/state", enabledAt: 1,
      pr: "24", expectedHead, reviewPromise: "/state/promise.json", historyObservation: "/state/history.json",
      reviewLabel: "agent:review", implementLabel: "agent:implement",
      updateBranchLabel: "agent:update-branch", inProgressLabel: "agent:in-progress",
      blockedLabel: "agent:blocked",
    },
    {
      withLock: (_project: unknown, operation: (_enabled: unknown, recheck: () => void) => unknown) => operation({}, () => {}),
      isAutoMergeEnabled: () => false,
      assertReviewVerification: () => {},
      validateReviewPromise: () => options.validation || approvedReview,
      readHistory: () => acceptedHistory,
      observeHistory: () => observations[Math.min(observationIndex++, observations.length - 1)],
      run: (args: string[]) => {
        commands.push(args);
        if (args[2] === "edit") {
          for (let index = 0; index < args.length; index += 1) {
            if (args[index] === "--remove-label") labels.delete(args[index + 1]);
            if (args[index] === "--add-label") labels.add(args[index + 1]);
          }
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[2] === "ready") {
          isDraft = false;
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[2] !== "view") return { status: 0, stdout: "", stderr: "" };
        const views = options.prViews || [];
        const view = views[prViewIndex++]
          || { ...livePr, isDraft, labels: [...labels].map((name) => ({ name })) };
        if (typeof view.isDraft === "boolean") isDraft = view.isDraft;
        return { status: 0, stdout: JSON.stringify(view), stderr: "" };
      },
    },
  );
  return { result, commands };
}

describe("reviewed PR ready handoff", () => {
  it("releases the active review claim when history changes after dispatcher approval", () => {
    const run = runHandoff([acceptedHistory, { revision: "new-comment" }]);

    expect({ result: run.result, mutation: run.commands.at(-1) }).toEqual({
      result: { action: "stale_history" },
      mutation: [
        "gh", "pr", "edit", "24", "-R", "owner/repo",
        "--remove-label", "agent:in-progress", "--add-label", "agent:review",
      ],
    });
  });

  it("marks the reviewed draft ready only after both history observations remain current", () => {
    const run = runHandoff([acceptedHistory, acceptedHistory]);

    expect(run.commands.find((command) => command[2] === "ready")).toEqual(["gh", "pr", "ready", "24", "-R", "owner/repo"]);
  });

  it("removes every agent workflow label after the pull request becomes ready", () => {
    const run = runHandoff([acceptedHistory, acceptedHistory]);

    expect(run.commands.filter((command) => command[2] === "edit").at(-1)).toEqual([
      "gh", "pr", "edit", "24", "-R", "owner/repo",
      "--remove-label", "agent:review", "--remove-label", "agent:implement",
      "--remove-label", "agent:update-branch", "--remove-label", "agent:in-progress",
      "--remove-label", "agent:blocked",
    ]);
  });

  it("adds no human handoff label to the reviewed pull request", () => {
    const run = runHandoff([acceptedHistory, acceptedHistory]);

    expect(run.commands.flat()).not.toContain("ready-for-human");
  });

  it("leaves an already ready pull request untouched by the ready command", () => {
    const run = runHandoff([acceptedHistory, acceptedHistory], { prViews: [{ ...livePr, isDraft: false }] });

    expect(run.commands.some((command) => command[2] === "ready")).toBe(false);
  });

  it("rechecks handoff eligibility before the final history observation", () => {
    expect(() => runHandoff([acceptedHistory, acceptedHistory], {
      prViews: [livePr, { ...livePr, labels: [{ name: "agent:in-progress" }, { name: "agent:blocked" }] }],
    })).toThrow("the active review claim state is no longer present");
  });

  it("stops when a concurrent workflow transition removed the active claim during observation", () => {
    expect(() => runHandoff([acceptedHistory, acceptedHistory], {
      prViews: [livePr, { ...livePr, labels: [{ name: "customer:urgent" }] }],
    })).toThrow("the active review claim state is no longer present");
  });

  it("releases the active review claim when history changes after the last handoff eligibility read", () => {
    expect(runHandoff([acceptedHistory, acceptedHistory, { revision: "raced-comment" }]).result).toEqual({ action: "stale_history" });
  });

  it("restores the review state when history changes during the handoff mutation", () => {
    expect(() => runHandoff([acceptedHistory, acceptedHistory, acceptedHistory, { revision: "raced-comment" }]))
      .toThrow("ready handoff stopped and review state restored");
  });

  it("restores the review state when a label survives the handoff mutation", () => {
    expect(() => runHandoff([acceptedHistory, acceptedHistory, acceptedHistory], {
      prViews: [
        livePr,
        livePr,
        { ...livePr, isDraft: false, labels: [{ name: "agent:in-progress" }] },
      ],
    })).toThrow("ready handoff stopped and review state restored");
  });


});
