import { describe, expect, it } from "vitest";

const { mergeReviewedPr } = require("../extensions/deadloop/automations/merge-reviewed-pr.ts");

const expectedHead = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function runMerge(status = 0) {
  const commands: string[][] = [];
  let lockHeld = false;
  let mutationObservedInsideLock = false;
  const action = mergeReviewedPr(
    {
      projectRepo: "/repo",
      githubRepo: "owner/repo",
      stateDir: "/state",
      enabledAt: 1,
      pr: "24",
      expectedHead,
    },
    {
      withLock: (_project: unknown, operation: () => number) => {
        lockHeld = true;
        try { return operation(); } finally { lockHeld = false; }
      },
      run: (args: string[]) => {
        commands.push(args);
        mutationObservedInsideLock = lockHeld;
        return { status, stdout: "", stderr: status ? "head commit changed" : "" };
      },
    },
  );
  return { action, commands, mutationObservedInsideLock };
}

describe("reviewed PR merge", () => {
  it("passes the reviewed head to GitHub's atomic merge guard", () => {
    expect(runMerge().commands[0]).toEqual([
      "gh", "pr", "merge", "24", "-R", "owner/repo",
      "--squash", "--delete-branch", "--match-head-commit", expectedHead,
    ]);
  });

  it("holds the enablement lock while performing the merge mutation", () => {
    expect(runMerge().mutationObservedInsideLock).toBe(true);
  });

  it("fails closed when the PR head changes immediately before merge", () => {
    expect(() => runMerge(1)).toThrow("head commit changed");
  });
});
