import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  decideRepairSize,
  finalizeReviewRepair,
} = require("../extensions/deadloop/automations/pr-review-repair-finalize.ts");
const { readLivePr, repairWorkerPrompt } = require("../extensions/deadloop/automations/pr-review-repair-dispatch.ts");
const cumulativeRepairFixture = require("./fixtures/pr-review-repair/cumulative-limit.json");

const automationLogin = "deadloop-bot";
const cumulativeComments = cumulativeRepairFixture.comments.map((comment: Record<string, unknown>) => ({
  ...comment,
  author: { login: automationLogin },
}));
const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const sizeLimitCases = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/pr-review-repair/size-limit-cases.json"), "utf8"),
);
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
  localHeadChanges: { afterChecks?: string; beforePush?: string; projectCommonDir?: string; worktreeCommonDir?: string; checkedOutBranch?: string; changedFileCount?: number; changedFiles?: string[] } = {},
) {
  let observedHead = actualHead;
  let localHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  return finalizeReviewRepair(
    {
      repo: "/worktree",
      projectId: "demo",
      projectRepo: "/repo",
      githubRepo: "owner/repo",
      attemptRecord: "/state/runs/attempt/attempt.json",
      pr: "243",
      branch: "agent/issue-243",
      expectedHead: head,
      remote: "origin",
      automationDir: "/automation",
      stateDir: "/state",
      enabledAt: 1,
      checkCommand: "npm test",
      resultFile: "/state/result.json",
    },
    {
      ensureVerification: (_args: unknown, _candidate: string, _repositoryId: string, run: (args: string[]) => unknown) => run(["node", "/automation/run-project-check.ts"]),
      readRepairFindingCount: () => findings.length,
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
        if (args.includes("--git-common-dir")) {
          return { status: 0, stdout: `${args[2] === "/repo" ? localHeadChanges.projectCommonDir || "/common" : localHeadChanges.worktreeCommonDir || "/common"}\n`, stderr: "" };
        }
        if (args.includes("symbolic-ref")) return { status: 0, stdout: `${localHeadChanges.checkedOutBranch || "agent/issue-243"}\n`, stderr: "" };
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
        if (args.includes("diff")) {
          const changedFiles = localHeadChanges.changedFiles
            || Array.from({ length: localHeadChanges.changedFileCount || 0 }, (_value, index) => `file-${index}.ts`);
          return { status: 0, stdout: `${changedFiles.join("\0")}${changedFiles.length ? "\0" : ""}`, stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );
}

function finalizeWithLowAmbientRenameLimit() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-repair-renames-"));
  const branch = "agent/issue-243";
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  try {
    git(["init", "--quiet"]);
    git(["checkout", "--quiet", "-b", branch]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    for (let index = 1; index <= 3; index += 1) {
      fs.writeFileSync(path.join(repo, `old-${index}.txt`), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    }
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "base"]);
    const expectedHead = git(["rev-parse", "HEAD"]);
    for (let index = 1; index <= 3; index += 1) {
      git(["mv", `old-${index}.txt`, `new-${index}.txt`]);
      fs.appendFileSync(path.join(repo, `new-${index}.txt`), `changed-${index}\n`);
    }
    git(["commit", "--quiet", "-am", "candidate"]);
    git(["config", "diff.renameLimit", "1"]);

    return finalizeReviewRepair(
      {
        repo,
        projectId: "demo",
        projectRepo: repo,
        githubRepo: "owner/repo",
        attemptRecord: "/state/runs/attempt/attempt.json",
        pr: "243",
        branch,
        expectedHead,
        remote: "origin",
        automationDir: "/automation",
        stateDir: "/state",
        enabledAt: 1,
        checkCommand: "true",
        resultFile: "/state/result.json",
      },
      {
        ensureVerification: (_args: unknown, _candidate: string, _repositoryId: string, run: (args: string[]) => unknown) => run(["node", "/automation/run-project-check.ts"]),
        readRepairFindingCount: () => 1,
        assertEnabled: () => ({ githubRepo: "owner/repo", githubRepositoryId: "R_repo" }),
        run: (args: string[]) => {
          if (args[0] === "node" || args.includes("push")) return { status: 0, stdout: "", stderr: "" };
          if (args.includes("ls-remote")) return { status: 0, stdout: `${expectedHead}\trefs/heads/${branch}\n`, stderr: "" };
          if (args.includes("get-url")) return { status: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" };
          if (args[0] === "gh" && args[1] === "repo") return { status: 0, stdout: JSON.stringify({ id: "R_repo" }), stderr: "" };
          if (args[0] === "gh") {
            return { status: 0, stdout: JSON.stringify({ state: "OPEN", isCrossRepository: false, headRefName: branch, headRefOid: expectedHead }), stderr: "" };
          }
          const result = spawnSync(args[0], args.slice(1), { encoding: "utf8" });
          return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
        },
      },
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

function finalizeWhileDisabled() {
  const commands: string[][] = [];
  let error = "";
  try {
    finalizeReviewRepair(
      {
        repo: "/worktree", projectId: "demo", projectRepo: "/repo", githubRepo: "owner/repo", attemptRecord: "/state/runs/attempt/attempt.json", pr: "243",
        branch: "agent/issue-243", expectedHead: head, remote: "origin",
        automationDir: "/automation", stateDir: "/state", enabledAt: 1, checkCommand: "npm test",
        resultFile: "/state/result.json",
      },
      {
        readRepairFindingCount: () => findings.length,
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
  return repairWorkerPrompt("243", "agent/issue-243", head, findings, "attempt-key", "/state/promise.json", "/worktree", {
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
    expect(selectRepairAttempt([], head, findings, automationLogin).action).toBe("launch_repair");
  });

  it("persists the exact head and review fingerprint attempt", () => {
    const fingerprint = reviewResultFingerprint(findings);

    expect(renderRepairMarker(head, fingerprint)).toContain(`head=${head} review=${fingerprint}`);
  });

  it("does not relaunch an already-recorded exact repair attempt", () => {
    const fingerprint = reviewResultFingerprint(findings);
    const comments = [{ body: renderRepairMarker(head, fingerprint), author: { login: automationLogin } }];

    expect(selectRepairAttempt(comments, head, findings, automationLogin).action).toBe("already_attempted");
  });

  it("requires a human when the same findings recur after repair", () => {
    const fingerprint = reviewResultFingerprint(findings);
    const comments = [{ body: renderRepairMarker(head, fingerprint), author: { login: automationLogin } }];

    expect(selectRepairAttempt(comments, "b".repeat(40), findings, automationLogin).reason).toBe("repeated_findings");
  });

  it("launches the third cumulative repair attempt", () => {
    expect(
      selectRepairAttempt(
        cumulativeComments.slice(0, 2),
        cumulativeRepairFixture.nextHead,
        cumulativeRepairFixture.nextFindings,
        automationLogin,
      ).action,
    ).toBe("launch_repair");
  });

  it("requires a human after three cumulative repair attempts", () => {
    expect(
      selectRepairAttempt(
        cumulativeComments,
        cumulativeRepairFixture.nextHead,
        cumulativeRepairFixture.nextFindings,
        automationLogin,
      ).reason,
    ).toBe("cumulative_repair_limit");
  });

  it("flags duplicate recovery after the cumulative limit is exceeded", () => {
    const fingerprint = reviewResultFingerprint(cumulativeRepairFixture.nextFindings);
    const comments = [
      ...cumulativeComments,
      {
        body: renderRepairMarker(cumulativeRepairFixture.nextHead, fingerprint),
        author: { login: automationLogin },
      },
    ];

    expect(
      selectRepairAttempt(comments, cumulativeRepairFixture.nextHead, cumulativeRepairFixture.nextFindings, automationLogin)
        .cumulativeLimitExceeded,
    ).toBe(true);
  });

  it("does not count repair markers from untrusted authors", () => {
    const comments = cumulativeRepairFixture.comments.map((comment: Record<string, unknown>) => ({
      ...comment,
      author: { login: "untrusted-user" },
    }));

    expect(
      selectRepairAttempt(comments, cumulativeRepairFixture.nextHead, cumulativeRepairFixture.nextFindings, automationLogin).action,
    ).toBe("launch_repair");
  });

  it("counts trusted repair markers beyond the first GitHub comment page", () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ body: `comment ${index}` }));
    const apiComments = cumulativeRepairFixture.comments.map((comment: Record<string, unknown>) => ({
      ...comment,
      user: { login: automationLogin },
    }));
    const runner = {
      runJson: (args: string[]) => args[1] === "pr"
        ? { comments: firstPage }
        : [firstPage, apiComments],
    };
    const pr = readLivePr("owner/repo", "243", runner);

    expect(
      selectRepairAttempt(pr.comments, cumulativeRepairFixture.nextHead, cumulativeRepairFixture.nextFindings, automationLogin).reason,
    ).toBe("cumulative_repair_limit");
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

  it("does not expose the safety-critical finding count as a worker CLI argument", () => {
    expect(prompt()).not.toContain("--finding-count");
  });

  it("qualifies configured checks as limited to repairs within the size limit", () => {
    expect(prompt()).toContain("for repairs within the size limit, it runs configured checks");
  });

  it("gives an oversized repair an exact blocked promise shape", () => {
    expect(prompt()).toContain('result={reason:"repair_size_limit_exceeded",explanation:"the changed-file count and finalizer limit",recovery:"have a human inspect and complete the repair"}, and evidence={}');
  });

  it("forbids direct pushes from the repair worker", () => {
    expect(prompt()).toContain("Do not run git push directly");
  });

  it("requires stale repair outputRevision from the finalizer receipt", () => {
    expect(prompt()).toContain('result={outcome:"stale_head",outputRevision:"<finalizer currentRemoteHeadOid>"}');
  });

  it.each(sizeLimitCases)("applies repair size policy: $name", (fixture: any) => {
    expect(decideRepairSize(fixture.changedFileCount, fixture.findingCount).action).toBe(fixture.expectedAction);
  });

  it("does not push a repair that exceeds the size limit", () => {
    const commands: string[][] = [];
    const result = finalizeWith(commands, head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { changedFileCount: 6 });

    expect({ action: result.action, pushed: commands.some((command) => command.includes("push")) }).toEqual({ action: "blocked", pushed: false });
  });

  it("counts a whitespace-only filename without trimming NUL-delimited git output", () => {
    const commands: string[][] = [];
    const result = finalizeWith(commands, head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { changedFiles: [" ", "a", "b", "c", "d", "e"] });

    expect(result.action).toBe("blocked");
  });

  it("overrides a low ambient rename limit when counting changed files", () => {
    expect(finalizeWithLowAmbientRenameLimit().size.changedFileCount).toBe(3);
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

    expect(timeouts.slice(firstGuardedCommand)).toEqual([25_000, 25_000, 25_000, 25_000, 25_000, 25_000]);
  });

  it("pushes the exact branch with an exact-head lease", () => {
    const commands: string[][] = [];
    finalizeWith(commands);

    expect(commands.find((command) => command.includes("push"))).toEqual([
      "git",
      "-C",
      "/worktree",
      "push",
      "--porcelain",
      `--force-with-lease=refs/heads/agent/issue-243:${head}`,
      "https://github.com/owner/repo.git",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:refs/heads/agent/issue-243",
    ]);
  });

  it("rejects a repair source from a foreign Git common directory", () => {
    expect(() => finalizeWith([], head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { worktreeCommonDir: "/foreign" })).toThrow(
      "does not belong to the enabled checkout",
    );
  });

  it("rejects a repair source with the wrong checked-out branch", () => {
    expect(() => finalizeWith([], head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { checkedOutBranch: "agent/issue-999" })).toThrow(
      "does not match the requested branch",
    );
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

  it("records the current remote head in a stale repair receipt", () => {
    const result = finalizeWith([], head, undefined, [], "https://github.com/owner/repo.git", {}, "c".repeat(40));

    expect(result.currentRemoteHeadOid).toBe("c".repeat(40));
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
