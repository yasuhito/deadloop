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
} = require("../extensions/deadloop/automations/pr-review-repair-finalize.ts");
const { repairWorkerPrompt } = require("../extensions/deadloop/automations/pr-review-repair-dispatch.ts");

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

function finalizeWith(commands: string[][], actualHead = head) {
  return finalizeReviewRepair(
    {
      repo: "/worktree",
      projectRepo: "/repo",
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
      assertEnabled: () => {},
      run: (args: string[]) => {
        commands.push(args);
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
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );
}

function finalizeWhileDisabled() {
  const commands: string[][] = [];
  let error = "";
  try {
    finalizeReviewRepair(
      {
        repo: "/worktree", projectRepo: "/repo", githubRepo: "owner/repo", pr: "243",
        branch: "agent/issue-243", expectedHead: head, remote: "origin",
        automationDir: "/automation", stateDir: "/state", checkCommand: "npm test",
      },
      {
        assertEnabled: () => { throw new Error("deadloop is disabled for this repository"); },
        run: (args: string[]) => {
          commands.push(args);
          if (args[0] === "gh") return { status: 0, stdout: JSON.stringify({ state: "OPEN", isCrossRepository: false, headRefName: "agent/issue-243", headRefOid: head }), stderr: "" };
          if (args.includes("rev-parse")) return { status: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return { error, commands };
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

  it("does not push after a stale immediate head recheck", () => {
    const commands: string[][] = [];
    finalizeWith(commands, "c".repeat(40));

    expect(commands.some((command) => command.includes("push"))).toBe(false);
  });

  it("reports disabled enablement before repair finalization", () => {
    expect(finalizeWhileDisabled().error).toBe("deadloop is disabled for this repository");
  });

  it("does not push when deadloop is disabled before repair finalization", () => {
    expect(finalizeWhileDisabled().commands.some((command) => command.includes("push"))).toBe(false);
  });
});
