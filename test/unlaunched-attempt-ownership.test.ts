import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { reconcile } = require("../extensions/deadloop/automations/reconcile-pr-work-authority.ts");
const { renderReviewClaimComment } = require("../extensions/deadloop/automations/pr-review-claim.ts");

const HEAD = "a".repeat(40);
const roots: string[] = [];
let originalPath: string | undefined;

afterEach(() => {
  if (originalPath !== undefined) process.env.PATH = originalPath;
  originalPath = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function claim(requestEventId: string, commentId: string) {
  const binding = {
    repositoryId: "repo-id", repository: "owner/repo", targetNumber: 42, requestEventId, role: "reviewer",
    revision: HEAD, owner: "host:1", authority: { durationSeconds: 86700 },
    activeState: {
      managedLabels: ["agent:review", "agent:implement", "agent:update-branch", "agent:in-progress", "agent:blocked"],
      requestLabel: "agent:review", requiredLabels: ["agent:in-progress"],
    },
  };
  return {
    binding, commentId, authorizedLogins: ["deadloop-bot"], automationLogin: "deadloop-bot",
    reviewerAgent: "pi", reviewerMaxRuntimeSeconds: 86400, cleanupGraceSeconds: 300, authoritySeconds: 86700,
    requestLabel: "agent:review", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
  };
}

/**
 * The state PR #228 reached: one review that completed and still owes its handoff, beside a second
 * attempt for the same pull request that failed to launch before any workspace was opened.
 */
function pullRequestWithUnlaunchedSecondAttempt(options: { unlaunchedHoldsWorkspace?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "deadloop-unlaunched-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  const stateDir = path.join(root, "deadloop");
  const completedRun = path.join(stateDir, "runs", "completed");
  const unlaunchedRun = path.join(stateDir, "runs", "unlaunched");
  const bin = path.join(root, "bin");
  for (const directory of [repo, worktree, bin, completedRun, unlaunchedRun]) mkdirSync(directory, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  // Every command the completion handler runs for itself resolves inside this fixture, so the loop
  // never reaches a real GitHub.
  writeFileSync(path.join(bin, "gh"), "#!/bin/sh\nprintf '{\"id\":\"repo-id\"}\\n'\n");
  writeFileSync(path.join(bin, "herdr"), "#!/bin/sh\nprintf 'herdr 0.8.0\\n'\n");
  for (const command of ["gh", "herdr"]) execFileSync("chmod", ["+x", path.join(bin, command)]);
  originalPath = process.env.PATH;
  process.env.PATH = `${bin}:${originalPath || ""}`;
  writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({ projects: [{
    repoPath: repo, githubRepo: "owner/repo", githubRepositoryId: "repo-id", enabledAt: 1,
    automationLogin: "deadloop-bot", firstEnableAutoMerge: false, firstStartPending: false,
    lastObservedAutoMerge: false, autoMergeAcknowledged: false, enabled: true,
  }] }));

  const attempt = (overrides: Record<string, unknown>) => ({
    launchUuid: "launch", project: "demo", repository: "owner/repo", role: "reviewer",
    target: { kind: "pull-request", number: 42 }, inputRevision: { head: HEAD },
    branch: "agent/issue-42", worktreePath: worktree, agentName: "dl-r-42-abcdef123456",
    workspaceLabel: "reviewer", ...overrides,
  });
  writeFileSync(path.join(completedRun, "attempt.json"), JSON.stringify(attempt({
    attemptId: "completed", promptFile: path.join(completedRun, "prompt.md"),
    promiseFile: path.join(completedRun, "promise.json"),
    workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1",
    phase: "report_received", lastSuccessfulPhase: "report_received", reviewClaim: claim("10", "100"),
  })));
  writeFileSync(path.join(completedRun, "promise.json"), JSON.stringify({
    schemaVersion: 1, attemptId: "completed", role: "reviewer", status: "complete",
    target: { repository: "owner/repo", kind: "pull-request", number: 42 }, inputRevision: { head: HEAD },
    summary: "two required findings need a person",
    result: {
      outcome: "human_required", reviewedHead: HEAD,
      findings: [{ title: "Race", body: "Re-observe the head", path: "src/a.ts", line: 1, severity: "major" }],
    },
    evidence: { reviewed: ["the exact diff"] },
  }));
  // The second attempt never opened a workspace: it stopped on the launch that found the first
  // attempt's checkout still occupied.
  writeFileSync(path.join(unlaunchedRun, "attempt.json"), JSON.stringify(attempt({
    attemptId: "unlaunched", promptFile: path.join(unlaunchedRun, "prompt.md"),
    promiseFile: path.join(unlaunchedRun, "promise.json"),
    phase: "launch_failed",
    lastSuccessfulPhase: options.unlaunchedHoldsWorkspace ? "workspace_opened" : "github_claimed",
    ...(options.unlaunchedHoldsWorkspace
      ? { workspaceId: "workspace-2", tabId: "tab-2", rootPaneId: "pane-2" }
      : {}),
    reviewClaim: claim("20", "200"),
    launchError: "worktree agent/issue-42 already has an open attempt workspace",
  })));
  return { root, repo, stateDir, worktree, completedRun };
}

async function reconcileOnce(fixture: ReturnType<typeof pullRequestWithUnlaunchedSecondAttempt>) {
  const labels = ["agent:blocked"];
  const comments = [
    { id: "100", author: { login: "deadloop-bot" }, createdAt: "2026-08-01T10:00:01Z", updatedAt: "2026-08-01T10:00:01Z", body: renderReviewClaimComment(claim("10", "100").binding) },
    { id: "200", author: { login: "deadloop-bot" }, createdAt: "2026-08-01T10:05:01Z", updatedAt: "2026-08-01T10:05:01Z", body: renderReviewClaimComment(claim("20", "200").binding) },
  ];
  const events = [
    { id: "10", event: "labeled", created_at: "2026-08-01T09:00:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:review" } },
    { id: "20", event: "labeled", created_at: "2026-08-01T10:04:00Z", actor: { login: "deadloop-bot" }, label: { name: "agent:review" } },
  ];
  const pr = () => ({ number: 42, state: "OPEN", headRefOid: HEAD, labels: labels.map((name) => ({ name })) });
  const commandRunner = {
    runText: (argv: string[]) => {
      if (argv[0] === "herdr") return "";
      if (argv[2] === "user") return "deadloop-bot\n";
      return "date: Sat, 01 Aug 2026 10:06:01 GMT";
    },
    runJson: (argv: string[]) => {
      const command = argv.slice(0, 3).join(" ");
      // The completed attempt's workspace is still open with its agent gone, which is the state
      // PR #228 was measured in.
      if (command === "herdr workspace list") return { result: { workspaces: [{ workspace_id: "workspace-1", pane_count: 1, tab_count: 1, worktree: { checkout_path: fixture.worktree } }] } };
      if (command === "herdr agent list") return { result: { agents: [] } };
      if (command === "herdr worktree list") return { result: { worktrees: [{ path: fixture.worktree }] } };
      if (command === "gh repo view") return { id: "repo-id", nameWithOwner: "owner/repo" };
      if (command === "gh pr list") return [pr()];
      if (command === "gh pr view") return pr();
      const endpoint = String(argv.at(-1) || "");
      if (endpoint.endsWith("/labels")) return [labels.map((name) => ({ name }))];
      if (endpoint.endsWith("/events")) return [[...events]];
      if (endpoint.endsWith("/comments")) return [[...comments]];
      return [];
    },
  };
  const result = await reconcile({
    projectRepo: fixture.repo, githubRepo: "owner/repo", stateDir: fixture.stateDir, projectId: "demo",
    enabledAt: 1, automationLogin: "deadloop-bot",
  }, commandRunner);
  return {
    result,
    unlaunched: JSON.parse(readFileSync(path.join(fixture.stateDir, "runs", "unlaunched", "attempt.json"), "utf8")),
  };
}

describe("a second attempt that never opened a workspace", () => {
  it("finishes the completed review the unlaunched attempt is blocking", async () => {
    const fixture = pullRequestWithUnlaunchedSecondAttempt();
    const { result } = await reconcileOnce(fixture);

    expect(result.results.map((entry: { attemptId?: string }) => entry.attemptId)).toContain("completed");
  });

  it("releases the unlaunched attempt", async () => {
    const fixture = pullRequestWithUnlaunchedSecondAttempt();
    const { unlaunched } = await reconcileOnce(fixture);

    expect(unlaunched.phase).toBe("authority_released");
  });

  it("records why the unlaunched attempt lost its authority", async () => {
    const fixture = pullRequestWithUnlaunchedSecondAttempt();
    const { unlaunched } = await reconcileOnce(fixture);

    expect(unlaunched.authorityRelease.reason).toBe("never_launched");
  });

  it("keeps the launch error of the released attempt as evidence", async () => {
    const fixture = pullRequestWithUnlaunchedSecondAttempt();
    const { unlaunched } = await reconcileOnce(fixture);

    expect(unlaunched.launchError).toContain("already has an open attempt workspace");
  });

  it("keeps a launch failure that already held a workspace", async () => {
    const fixture = pullRequestWithUnlaunchedSecondAttempt({ unlaunchedHoldsWorkspace: true });
    const { unlaunched } = await reconcileOnce(fixture);

    expect(unlaunched.phase).toBe("launch_failed");
  });

  it("reconciles a pull request whose block already removed every request label", async () => {
    const fixture = pullRequestWithUnlaunchedSecondAttempt();
    const { result } = await reconcileOnce(fixture);

    expect(result.results.some((entry: { prNumber?: number }) => entry.prNumber === 42)).toBe(true);
  });
});
