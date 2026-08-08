import { describe, expect, it } from "vitest";

const { handoffReviewedPr } = require("../extensions/deadloop/automations/handoff-reviewed-pr.ts");

const expectedHead = "a".repeat(40);
const acceptedHistory = { repository: "owner/repo", pullRequestNumber: 24, revision: "accepted", history: {} };
const livePr = {
  state: "OPEN",
  isDraft: false,
  headRefOid: expectedHead,
  labels: [{ name: "agent:review" }, { name: "agent:reviewing" }],
};
const approvedReview = {
  status: "complete",
  promise: { status: "complete", outcome: "approved", reviewedHead: expectedHead, findings: [] },
};

function runHandoff(observations: Array<Record<string, unknown>>) {
  const commands: string[][] = [];
  let observationIndex = 0;
  const result = handoffReviewedPr(
    {
      projectRepo: "/repo", githubRepo: "owner/repo", stateDir: "/state", enabledAt: 1,
      pr: "24", expectedHead, reviewPromise: "/state/promise.json", historyObservation: "/state/history.json",
      reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", blockedLabel: "agent:blocked", humanLabel: "ready-for-human",
    },
    {
      withLock: (_project: unknown, operation: (_enabled: unknown, recheck: () => void) => unknown) => operation({}, () => {}),
      validateReviewPromise: () => approvedReview,
      readHistory: () => acceptedHistory,
      observeHistory: () => observations[Math.min(observationIndex++, observations.length - 1)],
      run: (args: string[]) => {
        commands.push(args);
        return args[2] === "view"
          ? { status: 0, stdout: JSON.stringify(livePr), stderr: "" }
          : { status: 0, stdout: "", stderr: "" };
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
      mutation: ["gh", "pr", "edit", "24", "-R", "owner/repo", "--remove-label", "agent:reviewing", "--add-label", "agent:review"],
    });
  });

  it("hands off only after both history observations remain current", () => {
    const run = runHandoff([acceptedHistory, acceptedHistory]);

    expect(run.commands.at(-1)).toEqual([
      "gh", "pr", "edit", "24", "-R", "owner/repo",
      "--remove-label", "agent:review", "--remove-label", "agent:reviewing", "--add-label", "ready-for-human",
    ]);
  });
});
