import { describe, expect, it } from "vitest";

const {
  decideTechnicalReviewFailure,
  renderRepairMarker,
  renderTechnicalFailureMarker,
  reviewResultFingerprint,
  selectRepairAttempt,
  technicalFailureCount,
} = require("../extensions/deadloop/automations/pr-review-repair-state.ts");
const {
  decideRepairPushGuard,
  finalizeReviewRepair,
  renderRepairCompletionComment,
} = require("../extensions/deadloop/automations/pr-review-repair-finalize.ts");
const {
  renderReviewFindingsComment,
  repairWorkerPrompt,
} = require("../extensions/deadloop/automations/pr-review-repair-dispatch.ts");

const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const findings = [
  {
    title: "Lint contract failure",
    body: "Format src/a.ts and keep the public contract unchanged",
    path: "src/a.ts",
    line: 4,
    severity: "major",
  },
];

function finalizeWith(commands: string[][], actualHead = head, commentFailures = 0, metadataFailure = false) {
  let remainingCommentFailures = commentFailures;
  return finalizeReviewRepair(
    {
      repo: "/worktree",
      githubRepo: "owner/repo",
      pr: "243",
      branch: "agent/issue-243",
      expectedHead: head,
      remote: "origin",
      automationDir: "/automation",
      stateDir: "/state",
      checkCommand: "npm test",
    },
    {
      run: (args: string[]) => {
        commands.push(args);
        if (args[0] === "gh" && args.includes("comment")) {
          if (remainingCommentFailures > 0) {
            remainingCommentFailures -= 1;
            return { status: 1, stdout: "", stderr: "comment failed" };
          }
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "gh") {
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              isCrossRepository: false,
              headRefName: "agent/issue-243",
              headRefOid: actualHead,
            }),
            stderr: "",
          };
        }
        if (args.includes("rev-parse")) return { status: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" };
        if (args.includes("log")) {
          return metadataFailure
            ? { status: 1, stdout: "", stderr: "log failed" }
            : { status: 0, stdout: "Fix lint contract\n", stderr: "" };
        }
        if (args.includes("diff") && args.includes("--stat")) {
          return metadataFailure
            ? { status: 1, stdout: "", stderr: "diff failed" }
            : { status: 0, stdout: " src/a.ts | 2 +-\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );
}

function prompt() {
  return repairWorkerPrompt("243", "agent/issue-243", head, findings, "/state/promise.json", "/worktree", {
    projectId: "demo",
    repoPath: "/repo",
    githubRepo: "owner/repo",
    stateDir: "/state",
    checkCommand: "npm test",
    workerAgent: "pi",
    workerModel: "",
    remote: "origin",
    reviewLabel: "agent:review",
    reviewingLabel: "agent:reviewing",
    blockedLabel: "agent:blocked",
    automationDir: "/automation",
  });
}

describe("automatic PR review repair", () => {
  it("selects a first repair for an exact head and review result", () => {
    expect(selectRepairAttempt([], head, findings).action).toBe("launch_repair");
  });

  it("persists the exact head and review fingerprint attempt", () => {
    const fingerprint = reviewResultFingerprint(findings);

    expect(renderRepairMarker(head, fingerprint)).toContain(`head=${head} review=${fingerprint}`);
  });

  it("requires a human when the same findings recur after repair", () => {
    const fingerprint = reviewResultFingerprint(findings);
    const comments = [{ body: renderRepairMarker(head, fingerprint) }];

    expect(selectRepairAttempt(comments, "b".repeat(40), findings).reason).toBe("repeated_findings");
  });

  it("retries the first technical reviewer failure without human blocking", () => {
    expect(decideTechnicalReviewFailure([], head).action).toBe("retry");
  });

  it("human-blocks only after the bounded technical retry is exhausted", () => {
    const comments = [{ body: renderTechnicalFailureMarker(head) }];

    expect(decideTechnicalReviewFailure(comments, head).action).toBe("human_required");
  });

  it("counts only technical failures for the exact PR head", () => {
    const comments = [{ body: renderTechnicalFailureMarker(head) }];

    expect(technicalFailureCount(comments, "b".repeat(40))).toBe(0);
  });

  it("publishes the review summary and actionable findings for the exact head", () => {
    expect(renderReviewFindingsComment(head, "Review found one defect.", findings, "<!-- attempt -->")).toContain(
      "Review found one defect.\n\n1. **[major] Lint contract failure** (`src/a.ts:4`)\n   Format src/a.ts and keep the public contract unchanged",
    );
  });

  it("retains the attempt marker when oversized review text is truncated", () => {
    const marker = "<!-- deadloop:review-repair-attempt key=abc -->";

    expect(renderReviewFindingsComment(head, "x".repeat(70_000), findings, marker).endsWith(marker)).toBe(true);
  });

  it("keeps oversized review comments below the GitHub limit", () => {
    expect(renderReviewFindingsComment(head, "x".repeat(70_000), findings, "<!-- attempt -->").length).toBeLessThanOrEqual(
      60_000,
    );
  });

  it("retains actionable findings when an oversized summary is truncated", () => {
    expect(renderReviewFindingsComment(head, "x".repeat(70_000), findings, "<!-- attempt -->")).toContain(
      "Lint contract failure",
    );
  });

  it("passes #243-style lint findings as the repair worker's bounded contract", () => {
    expect(prompt()).toContain('"title": "Lint contract failure"');
  });

  it("forbids scope widening in the repair worker prompt", () => {
    expect(prompt()).toContain("Do not add features, reinterpret the issue, or widen scope");
  });

  it("forbids direct pushes from the repair worker", () => {
    expect(prompt()).toContain("Do not run git push directly");
  });

  it("stops a stale repair without authorizing push", () => {
    expect(
      decideRepairPushGuard(
        { state: "OPEN", isCrossRepository: false, headRefName: "agent/issue-243", headRefOid: "b".repeat(40) },
        "agent/issue-243",
        head,
      ).action,
    ).toBe("stale_head");
  });

  it("runs configured checks before the immediate PR head recheck", () => {
    const commands: string[][] = [];
    finalizeWith(commands);

    expect(commands.findIndex((command) => command[0] === "node")).toBeLessThan(commands.findIndex((command) => command[0] === "gh"));
  });

  it("pushes only the exact existing branch without force", () => {
    const commands: string[][] = [];
    finalizeWith(commands);

    expect(commands.find((command) => command.includes("push"))).toEqual([
      "git",
      "-C",
      "/worktree",
      "push",
      "--porcelain",
      "origin",
      "HEAD:refs/heads/agent/issue-243",
    ]);
  });

  it("posts a separate repair summary after a successful push", () => {
    const commands: string[][] = [];
    finalizeWith(commands);

    expect(commands.find((command) => command[0] === "gh" && command.includes("comment"))?.at(-1)).toContain(
      "Fix lint contract",
    );
  });

  it("bounds oversized repair metadata comments", () => {
    expect(renderRepairCompletionComment(head, "b".repeat(40), "fix", "x".repeat(70_000)).length).toBeLessThanOrEqual(
      41_000,
    );
  });

  it("retries a failed repair summary comment once", () => {
    const commands: string[][] = [];
    finalizeWith(commands, head, 1);

    expect(commands.filter((command) => command[0] === "gh" && command.includes("comment"))).toHaveLength(2);
  });

  it("surfaces repair summary failure after the bounded retry", () => {
    const commands: string[][] = [];

    expect(finalizeWith(commands, head, 2).action).toBe("pushed_comment_failed");
  });

  it("surfaces repair metadata collection failure after push", () => {
    const commands: string[][] = [];

    expect(finalizeWith(commands, head, 0, true).reason).toBe("repair_comment_metadata_failed");
  });

  it("prevents repair metadata from injecting attempt markers", () => {
    const comment = renderRepairCompletionComment(head, "b".repeat(40), "fix <!-- deadloop:review-repair-attempt", "");

    expect(comment).not.toContain("<!-- deadloop:review-repair-attempt");
  });

  it("does not push after a stale immediate head recheck", () => {
    const commands: string[][] = [];
    finalizeWith(commands, "c".repeat(40));

    expect(commands.some((command) => command.includes("push"))).toBe(false);
  });
});
