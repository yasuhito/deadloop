import { describe, expect, it } from "vitest";

const { handoffReviewedPr } = require("../extensions/deadloop/automations/handoff-reviewed-pr.ts");

const expectedHead = "a".repeat(40);
const acceptedHistory = { repository: "owner/repo", pullRequestNumber: 24, revision: "accepted", history: {} };
const livePr = {
  state: "OPEN",
  isDraft: false,
  headRefOid: expectedHead,
  labels: [{ name: "agent:in-progress" }],
};
const approvedReview = {
  status: "complete",
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
  const result = handoffReviewedPr(
    {
      projectRepo: "/repo", githubRepo: "owner/repo", stateDir: "/state", enabledAt: 1,
      pr: "24", expectedHead, reviewPromise: "/state/promise.json", historyObservation: "/state/history.json",
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress",
      blockedLabel: "agent:blocked", humanLabel: "ready-for-human",
    },
    {
      withLock: (_project: unknown, operation: (_enabled: unknown, recheck: () => void) => unknown) => operation({}, () => {}),
      validateReviewPromise: () => options.validation || approvedReview,
      readHistory: () => acceptedHistory,
      observeHistory: () => observations[Math.min(observationIndex++, observations.length - 1)],
      run: (args: string[]) => {
        commands.push(args);
        if (args[2] !== "view") return { status: 0, stdout: "", stderr: "" };
        const views = options.prViews || [livePr];
        const view = views[Math.min(prViewIndex++, views.length - 1)];
        return { status: 0, stdout: JSON.stringify(view), stderr: "" };
      },
    },
  );
  return { result, commands };
}

describe("reviewed PR human handoff", () => {
  it("releases the active review claim when history changes after dispatcher approval", () => {
    const run = runHandoff([acceptedHistory, { revision: "new-comment" }]);

    expect({ result: run.result, mutation: run.commands.at(-1) }).toEqual({
      result: { action: "stale_history" },
      mutation: [
        "gh", "pr", "edit", "24", "-R", "owner/repo",
        "--remove-label", "agent:in-progress", "--remove-label", "agent:reviewing", "--add-label", "agent:review",
      ],
    });
  });

  it("hands off only after both history observations remain current", () => {
    const run = runHandoff([acceptedHistory, acceptedHistory]);

    expect(run.commands.at(-1)).toEqual([
      "gh", "pr", "edit", "24", "-R", "owner/repo",
      "--remove-label", "agent:in-progress", "--remove-label", "agent:review", "--remove-label", "agent:reviewing",
      "--add-label", "ready-for-human",
    ]);
  });

  it("rechecks handoff eligibility after the final history observation", () => {
    expect(() => runHandoff([acceptedHistory, acceptedHistory], {
      prViews: [livePr, { ...livePr, labels: [{ name: "agent:in-progress" }, { name: "agent:blocked" }] }],
    })).toThrow("the active review claim state is no longer present");
  });

  it("stops when a concurrent workflow transition removed the active claim during observation", () => {
    expect(() => runHandoff([acceptedHistory, acceptedHistory], {
      prViews: [livePr, { ...livePr, labels: [{ name: "ready-for-human" }] }],
    })).toThrow("the active review claim state is no longer present");
  });

  it("preserves validated legacy complete promises when accepted history is genuinely absent", () => {
    const commands: string[][] = [];
    const result = handoffReviewedPr(
      {
        projectRepo: "/repo", githubRepo: "owner/repo", stateDir: "/state", enabledAt: 1,
        pr: "24", expectedHead, reviewPromise: "/state/promise.json", historyObservation: "/definitely/absent/history.json",
        reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", inProgressLabel: "agent:in-progress",
        blockedLabel: "agent:blocked", humanLabel: "ready-for-human",
      },
      {
        withLock: (_project: unknown, operation: (_enabled: unknown, recheck: () => void) => unknown) => operation({}, () => {}),
        validateReviewPromise: () => ({
          status: "complete",
          evidenceStrength: "legacy-weak",
          promise: { status: "complete", reason: "", summary: "Legacy approval" },
        }),
        run: (args: string[]) => {
          commands.push(args);
          return args[2] === "view"
            ? { status: 0, stdout: JSON.stringify(livePr), stderr: "" }
            : { status: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect({ action: result.action, mutation: commands.at(-1)?.slice(0, 3) }).toEqual({
      action: "handed_off",
      mutation: ["gh", "pr", "edit"],
    });
  });
});
