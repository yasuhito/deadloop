import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
  decideTechnicalReviewFailure,
  renderRepairMarker,
  renderTechnicalFailureMarker,
  repairAttempts,
  reviewOutcomeFingerprint,
  reviewResultFingerprint,
  selectRepairAttempt,
  technicalFailureCount,
} = require("../extensions/deadloop/automations/pr-review-repair-state.ts");
const {
  decideRepairPushGuard,
  finalizeReviewRepair,
} = require("../extensions/deadloop/automations/pr-review-repair-finalize.ts");
const { readLivePr, repairWorkerPrompt } = require("../extensions/deadloop/automations/pr-review-repair-dispatch.ts");
const { renderReviewClaimComment } = require("../extensions/deadloop/automations/pr-review-claim.ts");
const cumulativeRepairFixture = require("./fixtures/pr-review-repair/cumulative-limit.json");

const automationLogin = "deadloop-bot";
const cumulativeComments = cumulativeRepairFixture.comments.map((comment: Record<string, unknown>) => ({
  ...comment,
  author: { login: automationLogin },
}));
const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const activeReviewState = {
  managedLabels: ["agent:review", "agent:implement", "agent:update-branch", "agent:in-progress", "agent:blocked"],
  requestLabel: "agent:review",
  requiredLabels: ["agent:in-progress"],
};
const reviewClaimBinding = {
  repositoryId: "R_repo", repository: "owner/repo", targetNumber: 243, requestEventId: "22", role: "reviewer", revision: head, owner: "host-a",
  authority: { durationSeconds: 86700 }, activeState: activeReviewState,
};
const reviewClaim = {
  binding: reviewClaimBinding, commentId: "101", authorizedLogins: [automationLogin], automationLogin, reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 86400, cleanupGraceSeconds: 300, authoritySeconds: 86700,
  requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
};
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
  localHeadChanges: { afterChecks?: string; beforePush?: string; projectCommonDir?: string; worktreeCommonDir?: string; checkedOutBranch?: string; dirty?: boolean; missingAncestor?: boolean; checkFailure?: boolean; finalManagedConflict?: boolean; currentConfiguration?: Record<string, unknown>; dateHeaders?: string; expireAfterObservations?: boolean } = {},
) {
  let observedHead = actualHead;
  let localHead = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  let prReads = 0;
  let claimObservationComplete = false;
  return finalizeReviewRepair(
    {
      repo: "/worktree",
      attemptRecord: "/state/runs/repair/attempt.json",
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
      resultFile: "/state/result.json",
      reviewClaim,
    },
    {
      loadSavedReviewClaim: () => reviewClaim,
      loadCurrentReviewClaimConfiguration: () => ({
        reviewerMaxRuntimeSeconds: 86400, cleanupGraceSeconds: 300, authoritySeconds: 86700,
        managedLabels: activeReviewState.managedLabels, requestLabel: "agent:review", requiredLabels: ["agent:in-progress"],
        repositoryId: "R_repo", repository: "owner/repo", authorizedLogins: [automationLogin],
        authenticatedLogin: automationLogin, reviewerAgent: "pi", ...localHeadChanges.currentConfiguration,
      }),
      assertEnabled: () => {
        if (headAfterAuthorization) observedHead = headAfterAuthorization;
        return { githubRepo: "owner/repo", githubRepositoryId: "R_repo", automationLogin };
      },
      run: (args: string[], timeoutMs?: number) => {
        commands.push(args);
        timeouts.push(timeoutMs);
        if (args[0] === "node" && localHeadChanges.afterChecks) localHead = localHeadChanges.afterChecks;
        if (args[0] === "node" && localHeadChanges.checkFailure) return { status: 1, stdout: "", stderr: "checks failed" };
        if (args.includes("merge-base") && localHeadChanges.missingAncestor) return { status: 1, stdout: "", stderr: "" };
        if (args.includes("status") && localHeadChanges.dirty) return { status: 0, stdout: " M src/a.ts\n", stderr: "" };
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
        if (args[0] === "gh" && args[1] === "api" && args[2] === "user") return { status: 0, stdout: `${automationLogin}\n`, stderr: "" };
        if (args[0] === "gh" && args[1] === "repo") {
          if (localHeadChanges.beforePush) localHead = localHeadChanges.beforePush;
          return { status: 0, stdout: JSON.stringify({ id: repositoryIds[args[3]] || (args[3] === "other/repo" ? "R_other" : "R_repo"), nameWithOwner: args[3] }), stderr: "" };
        }
        if (args[0] === "gh" && args.some((arg) => arg.endsWith("/events"))) {
          return { status: 0, stdout: JSON.stringify([[{ id: 22, event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } }]]), stderr: "" };
        }
        if (args[0] === "gh" && args.some((arg) => arg.endsWith("/comments"))) {
          claimObservationComplete = true;
          return { status: 0, stdout: JSON.stringify([[{ id: 101, created_at: "2026-07-20T10:01:00Z", updated_at: "2026-07-20T10:01:00Z", user: { login: automationLogin }, body: renderReviewClaimComment(reviewClaimBinding) }]]), stderr: "" };
        }
        if (args[0] === "gh" && args.includes("--include")) {
          const date = localHeadChanges.expireAfterObservations && claimObservationComplete
            ? "date: Tue, 21 Jul 2026 10:06:01 GMT"
            : "date: Mon, 20 Jul 2026 10:03:00 GMT";
          return { status: 0, stdout: localHeadChanges.dateHeaders ?? date, stderr: "" };
        }
        if (args[0] === "gh") {
          prReads += 1;
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              isCrossRepository: false,
              headRefName: "agent/issue-243",
              headRefOid: observedHead,
              labels: prReads >= 2 && localHeadChanges.finalManagedConflict
                ? [{ name: "agent:in-progress" }, { name: "agent:blocked" }]
                : [{ name: "agent:in-progress" }],
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

function finalizeVerifiedRename() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-repair-renames-"));
  const branch = "agent/issue-243";
  const git = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  try {
    git(["init", "--quiet"]);
    git(["checkout", "--quiet", "-b", branch]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    for (let index = 1; index <= 29; index += 1) {
      fs.writeFileSync(path.join(repo, `old-${index}.txt`), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n");
    }
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "base"]);
    const expectedHead = git(["rev-parse", "HEAD"]);
    const renameBinding = { ...reviewClaimBinding, revision: expectedHead };
    const renameReviewClaim = { ...reviewClaim, binding: renameBinding };
    for (let index = 1; index <= 29; index += 1) {
      git(["mv", `old-${index}.txt`, `new-${index}.txt`]);
      fs.appendFileSync(path.join(repo, `new-${index}.txt`), `changed-${index}\n`);
    }
    git(["commit", "--quiet", "-am", "candidate"]);

    return finalizeReviewRepair(
      {
        repo,
        attemptRecord: "/state/runs/repair/attempt.json",
        projectRepo: repo,
        githubRepo: "owner/repo",
        pr: "243",
        branch,
        expectedHead,
        remote: "origin",
        automationDir: "/automation",
        stateDir: "/state",
        enabledAt: 1,
        checkCommand: "true",
        resultFile: "/state/result.json",
        reviewClaim: renameReviewClaim,
      },
      {
        loadSavedReviewClaim: () => renameReviewClaim,
        loadCurrentReviewClaimConfiguration: () => ({
          reviewerMaxRuntimeSeconds: 86400, cleanupGraceSeconds: 300, authoritySeconds: 86700,
          managedLabels: activeReviewState.managedLabels, requestLabel: "agent:review", requiredLabels: ["agent:in-progress"],
          repositoryId: "R_repo", repository: "owner/repo", authorizedLogins: [automationLogin],
          authenticatedLogin: automationLogin, reviewerAgent: "pi",
        }),
        assertEnabled: () => ({ githubRepo: "owner/repo", githubRepositoryId: "R_repo", automationLogin }),
        run: (args: string[]) => {
          if (args[0] === "node" || args.includes("push")) return { status: 0, stdout: "", stderr: "" };
          if (args.includes("ls-remote")) return { status: 0, stdout: `${expectedHead}\trefs/heads/${branch}\n`, stderr: "" };
          if (args.includes("get-url")) return { status: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" };
          if (args[0] === "gh" && args[1] === "api" && args[2] === "user") return { status: 0, stdout: `${automationLogin}\n`, stderr: "" };
          if (args[0] === "gh" && args[1] === "repo") return { status: 0, stdout: JSON.stringify({ id: "R_repo", nameWithOwner: "owner/repo" }), stderr: "" };
          if (args[0] === "gh" && args.some((arg) => arg.endsWith("/events"))) return { status: 0, stdout: JSON.stringify([[{ id: 22, event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } }]]), stderr: "" };
          if (args[0] === "gh" && args.some((arg) => arg.endsWith("/comments"))) return { status: 0, stdout: JSON.stringify([[{ id: 101, created_at: "2026-07-20T10:01:00Z", updated_at: "2026-07-20T10:01:00Z", user: { login: automationLogin }, body: renderReviewClaimComment(renameBinding) }]]), stderr: "" };
          if (args[0] === "gh" && args.includes("--include")) return { status: 0, stdout: "date: Mon, 20 Jul 2026 10:03:00 GMT", stderr: "" };
          if (args[0] === "gh") {
            return { status: 0, stdout: JSON.stringify({ state: "OPEN", isCrossRepository: false, headRefName: branch, headRefOid: expectedHead, labels: [{ name: "agent:in-progress" }] }), stderr: "" };
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
        repo: "/worktree", attemptRecord: "/state/runs/repair/attempt.json", projectRepo: "/repo", githubRepo: "owner/repo", pr: "243",
        branch: "agent/issue-243", expectedHead: head, remote: "origin",
        automationDir: "/automation", stateDir: "/state", enabledAt: 1, checkCommand: "npm test",
        resultFile: "/state/result.json",
        reviewClaim,
      },
      {
        loadSavedReviewClaim: () => reviewClaim,
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

function prompt(requiredFindings = findings) {
  return repairWorkerPrompt("243", "agent/issue-243", head, requiredFindings, "attempt-key", "/state/promise.json", "/worktree", {
    projectId: "demo",
    repoPath: "/repo",
    githubRepo: "owner/repo",
    stateDir: "/state",
    checkCommand: "npm test",
    workerAgent: "pi",
    workerModel: "",
    remote: "origin",
    reviewLabel: "agent:review",

    blockedLabel: "agent:blocked",
    automationDir: "/automation",
  });
}

describe("automatic PR review repair", () => {
  it.each([
    ["runtime", { reviewerMaxRuntimeSeconds: 80000, authoritySeconds: 80300 }],
    ["grace", { cleanupGraceSeconds: 100, authoritySeconds: 86500 }],
    ["labels", { requestLabel: "custom:review" }],
    ["identities", { authorizedLogins: ["other-bot"] }],
    ["authenticated login", { authenticatedLogin: "other-bot" }],
  ])("performs no repair push after current %s configuration changes", (_name, currentConfiguration) => {
    const commands: string[][] = [];
    expect(() => finalizeWith(commands, head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { currentConfiguration })).toThrow("current enablement");
  });

  it("fails before repair work when the active review claim is omitted", () => {
    expect(() => finalizeReviewRepair({
      repo: "/worktree", attemptRecord: "/state/runs/repair/attempt.json", projectRepo: "/repo", githubRepo: "owner/repo", pr: "243", branch: "agent/issue-243",
      expectedHead: head, remote: "origin", automationDir: "/automation", stateDir: "/state", enabledAt: 1,
      checkCommand: "npm test", resultFile: "/state/result.json",
    }, { run: () => { throw new Error("unexpected command"); } })).toThrow("active review claim is required");
  });

  it("selects a first repair for an exact head and review result", () => {
    expect(selectRepairAttempt([], head, findings, automationLogin).action).toBe("launch_repair");
  });

  it("persists the exact head and review fingerprint attempt", () => {
    const fingerprint = reviewResultFingerprint(findings);

    expect(renderRepairMarker(head, fingerprint)).toContain(`head=${head} review=${fingerprint}`);
  });

  it("separates approved results that differ only by their advisory observations", () => {
    const withAdvisory = reviewOutcomeFingerprint("approved", "", "Reviewed.", [], [{ title: "Naming", body: "Rename it" }]);

    expect(reviewOutcomeFingerprint("approved", "", "Reviewed.", [], [])).not.toBe(withAdvisory);
  });

  it("keeps the changes-requested fingerprint equal to its repair attempt key", () => {
    expect(reviewOutcomeFingerprint("changes_requested", "", "Repair it.", findings, [{ title: "Naming", body: "Rename it" }]))
      .toBe(reviewResultFingerprint(findings));
  });

  it("does not relaunch an already-recorded exact repair attempt", () => {
    const fingerprint = reviewResultFingerprint(findings);
    const comments = [{ body: renderRepairMarker(head, fingerprint), author: { login: automationLogin } }];

    expect(selectRepairAttempt(comments, head, findings, automationLogin).action).toBe("already_attempted");
  });

  it("launches repair when progress-qualified findings resemble an earlier result on another head", () => {
    const fingerprint = reviewResultFingerprint(findings);
    const comments = [{ body: renderRepairMarker(head, fingerprint), author: { login: automationLogin } }];

    expect(selectRepairAttempt(comments, "b".repeat(40), findings, automationLogin).action).toBe("launch_repair");
  });

  it("launches the fourth progress-qualified repair attempt", () => {
    expect(
      selectRepairAttempt(
        cumulativeComments,
        cumulativeRepairFixture.nextHead,
        cumulativeRepairFixture.nextFindings,
        automationLogin,
      ).action,
    ).toBe("launch_repair");
  });

  it("launches a later progress-qualified repair regardless of historical attempt count", () => {
    const historicalComments = Array.from({ length: 20 }, (_, index) => ({
      body: renderRepairMarker(String(index + 1).padStart(40, "0"), String(index + 1).padStart(20, "0")),
      author: { login: automationLogin },
    }));

    expect(
      selectRepairAttempt(
        historicalComments,
        cumulativeRepairFixture.nextHead,
        cumulativeRepairFixture.nextFindings,
        automationLogin,
      ).action,
    ).toBe("launch_repair");
  });

  it("does not relaunch an exact result even after many historical attempts", () => {
    const fingerprint = reviewResultFingerprint(cumulativeRepairFixture.nextFindings);
    const comments = [
      ...cumulativeComments,
      {
        body: renderRepairMarker(cumulativeRepairFixture.nextHead, fingerprint),
        author: { login: automationLogin },
      },
    ];

    expect(
      selectRepairAttempt(comments, cumulativeRepairFixture.nextHead, cumulativeRepairFixture.nextFindings, automationLogin).action,
    ).toBe("already_attempted");
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

  it("does not treat historical repair markers beyond the first GitHub comment page as a limit", () => {
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
      selectRepairAttempt(pr.comments, cumulativeRepairFixture.nextHead, cumulativeRepairFixture.nextFindings, automationLogin).action,
    ).toBe("launch_repair");
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

  it("passes #243-style lint findings as the repair worker's required contract", () => {
    expect(prompt()).toContain('"title": "Lint contract failure"');
  });

  it("passes all current required findings together in one repair contract", () => {
    const second = { title: "Missing guard", body: "Reject stale input", path: "src/b.ts", line: 8, severity: "blocker" };
    const contract = prompt([...findings, second]).match(/Required findings contract:\n```json\n([\s\S]*?)\n```/)?.[1] || "[]";

    expect(JSON.parse(contract).map((finding: Record<string, unknown>) => finding.title)).toEqual(["Lint contract failure", "Missing guard"]);
  });

  it("forbids scope widening in the repair worker prompt", () => {
    expect(prompt()).toContain("Do not add features, reinterpret the issue, or widen scope");
  });

  it("does not expose the safety-critical finding count as a worker CLI argument", () => {
    expect(prompt()).not.toContain("--finding-count");
  });

  it("requires configured checks for every repair", () => {
    expect(prompt()).toContain("it runs configured checks, immediately re-checks the PR head");
  });

  it("does not describe a quantitative repair-size limit", () => {
    expect(prompt()).not.toMatch(/changed-file count|size limit|line-count limit/);
  });

  it("forbids direct pushes from the repair worker", () => {
    expect(prompt()).toContain("Do not run git push directly");
  });

  it("requires stale repair outputRevision from the finalizer receipt", () => {
    expect(prompt()).toContain('result={outcome:"stale_head",outputRevision:"<finalizer currentRemoteHeadOid>"}');
  });

  it("pushes a verified rename spanning 29 files", () => {
    expect(finalizeVerifiedRename().action).toBe("pushed");
  });

  it("keeps historical repair markers with finding counts readable", () => {
    const marker = renderRepairMarker(head, reviewResultFingerprint(findings)).replace(" -->", " findings=4 -->");

    expect(repairAttempts([{ body: marker }])[0].findingCount).toBe(4);
  });

  it("prevents push when required verification fails", () => {
    expect(() => finalizeWith([], head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { checkFailure: true })).toThrow("checks failed");
  });

  it("prevents push from a dirty repair worktree", () => {
    expect(() => finalizeWith([], head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { dirty: true })).toThrow("repair worktree is dirty before checks");
  });

  it("prevents push when the candidate does not contain the selected head", () => {
    expect(() => finalizeWith([], head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { missingAncestor: true })).toThrow("repair branch does not contain the expected PR head");
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

    expect(timeouts.slice(firstGuardedCommand).every((timeout) => timeout === 25_000)).toBe(true);
  });

  it("pushes the exact branch without forcing", () => {
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

  it("does not push when managed labels change during the final claim inspection", () => {
    const commands: string[][] = [];
    try { finalizeWith(commands, head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { finalManagedConflict: true }); } catch {}

    expect(commands.some((command) => command.includes("push"))).toBe(false);
  });

  it("does not push when the claim expires while repair-push observations are being collected", () => {
    const commands: string[][] = [];
    try { finalizeWith(commands, head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { expireAfterObservations: true }); } catch {}

    expect(commands.some((command) => command.includes("push"))).toBe(false);
  });

  it("posts a visible block comment instead of pushing when only REST Date is unavailable", () => {
    const commands: string[][] = [];
    try { finalizeWith(commands, head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { dateHeaders: "" }); } catch {}

    expect(commands.some((command) => command[0] === "gh" && command[1] === "pr" && command[2] === "comment")).toBe(true);
  });

  it("adds only blocked at the repair-push seam when REST Date is unavailable", () => {
    const commands: string[][] = [];
    try { finalizeWith(commands, head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { dateHeaders: "" }); } catch {}

    expect(commands.find((command) => command[0] === "gh" && command[1] === "pr" && command[2] === "edit")?.slice(-2)).toEqual(["--add-label", "agent:blocked"]);
  });

  it("performs no repair-push GitHub mutation when binding conflicts and REST Date is unavailable", () => {
    const commands: string[][] = [];
    try { finalizeWith(commands, head, undefined, [], "https://github.com/owner/repo.git", {}, undefined, { dateHeaders: "", finalManagedConflict: true }); } catch {}

    expect(commands.some((command) => command[0] === "gh" && command[1] === "pr" && ["comment", "edit"].includes(command[2]))).toBe(false);
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
