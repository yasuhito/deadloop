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

function finalizeWith(
  commands: string[][],
  actualHead = head,
  headAfterAuthorization?: string,
  timeouts: Array<number | undefined> = [],
  pushUrl = "https://github.com/owner/repo.git",
  repositoryIds: Record<string, string> = {},
  raceRemoteHead?: string | null,
  localHeadChanges: { afterChecks?: string; beforePush?: string } = {},
) {
  let observedHead = actualHead;
  let localHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
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
      enabledAt: 1,
      checkCommand: "npm test",
    },
    {
      assertEnabled: () => {
        if (headAfterAuthorization) observedHead = headAfterAuthorization;
        return { githubRepo: "owner/repo", githubRepositoryId: "R_repo" };
      },
      run: (args: string[], timeoutMs?: number) => {
        commands.push(args);
        timeouts.push(timeoutMs);
        if (args[0] === "node" && localHeadChanges.afterChecks) localHead = localHeadChanges.afterChecks;
        if (args.includes("get-url")) return { status: 0, stdout: `${pushUrl}\n`, stderr: "" };
        if (args.includes("push") && raceRemoteHead !== undefined && raceRemoteHead !== head) {
          return { status: 1, stdout: "", stderr: "rejected (non-fast-forward)" };
        }
        if (args.includes("ls-remote")) {
          const remoteLine = raceRemoteHead === null ? "" : `${raceRemoteHead ?? head}\trefs/heads/agent/issue-243\n`;
          return { status: 0, stdout: remoteLine, stderr: "" };
        }
        if (args[0] === "gh" && args[1] === "repo") {
          if (localHeadChanges.beforePush) localHead = localHeadChanges.beforePush;
          return { status: 0, stdout: JSON.stringify({ id: repositoryIds[args[3]] || (args[3] === "other/repo" ? "R_other" : "R_repo") }), stderr: "" };
        }
        if (args[0] === "gh") {
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              isCrossRepository: false,
              headRefName: "agent/issue-243",
              headRefOid: observedHead,
            }),
            stderr: "",
          };
        }
        if (args.includes("rev-parse")) return { status: 0, stdout: `${localHead}\n`, stderr: "" };
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
        automationDir: "/automation", stateDir: "/state", enabledAt: 1, checkCommand: "npm test",
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

  it("bounds every command after authorization while holding the enablement lock", () => {
    const commands: string[][] = [];
    const timeouts: Array<number | undefined> = [];
    finalizeWith(commands, head, undefined, timeouts);
    const firstGuardedCommand = commands.findIndex((command) => command[0] === "gh");

    expect(timeouts.slice(firstGuardedCommand)).toEqual([25_000, 25_000, 25_000, 25_000, 25_000]);
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
      "https://github.com/owner/repo.git",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:refs/heads/agent/issue-243",
    ]);
  });

  it("rejects HEAD changing during configured checks", () => {
    expect(() => finalizeWith([], head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { afterChecks: "c".repeat(40) })).toThrow(
      "repair HEAD changed during checks",
    );
  });

  it("rejects HEAD changing immediately before push", () => {
    expect(() => finalizeWith([], head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { beforePush: "c".repeat(40) })).toThrow(
      "repair HEAD changed immediately before push",
    );
  });

  it("rejects a repair push remote for another repository", () => {
    expect(() => finalizeWith([], head, undefined, [], "https://github.com/other/repo.git")).toThrow(
      "push remote origin does not resolve exclusively to owner/repo",
    );
  });

  it("accepts a renamed-repository alias recorded by locked enablement", () => {
    const commands: string[][] = [];
    finalizeWith(commands, head, undefined, [], "https://github.com/old/repo.git");

    expect(commands.find((command) => command.includes("push"))).toContain("https://github.com/old/repo.git");
  });

  it("rejects a recorded repair alias when its repository name has been reused", () => {
    expect(() => finalizeWith([], head, undefined, [], "https://github.com/old/repo.git", { "old/repo": "R_reused" })).toThrow(
      "push remote origin does not resolve exclusively to owner/repo",
    );
  });

  it("pins the verified repair destination before a mutable remote can redirect the push", () => {
    const commands: string[][] = [];
    finalizeWith(commands);

    expect(commands.find((command) => command.includes("push"))).toContain("https://github.com/owner/repo.git");
  });

  it("reports stale when a concurrent remote update rejects the push", () => {
    const commands: string[][] = [];
    const result = finalizeWith(commands, head, undefined, [], "https://github.com/owner/repo.git", {}, "c".repeat(40));

    expect(result.action).toBe("stale_head");
  });

  it("rejects a concurrent rewind to an ancestor with an exact-head lease", () => {
    const result = finalizeWith([], head, undefined, [], "https://github.com/owner/repo.git", {}, "0".repeat(40));

    expect(result.action).toBe("stale_head");
  });

  it("does not recreate a concurrently deleted remote branch", () => {
    const result = finalizeWith([], head, undefined, [], "https://github.com/owner/repo.git", {}, null);

    expect(result.action).toBe("stale_head");
  });

  it("does not push after a stale immediate head recheck", () => {
    const commands: string[][] = [];
    finalizeWith(commands, "c".repeat(40));

    expect(commands.some((command) => command.includes("push"))).toBe(false);
  });

  it("rechecks the PR head after waiting for the enablement lock", () => {
    const commands: string[][] = [];
    finalizeWith(commands, head, "c".repeat(40));

    expect(commands.some((command) => command.includes("push"))).toBe(false);
  });

  it("reports disabled enablement before repair finalization", () => {
    expect(finalizeWhileDisabled().error).toBe("deadloop is disabled for this repository");
  });

  it("does not push when deadloop is disabled before repair finalization", () => {
    expect(finalizeWhileDisabled().commands.some((command) => command.includes("push"))).toBe(false);
  });
});
