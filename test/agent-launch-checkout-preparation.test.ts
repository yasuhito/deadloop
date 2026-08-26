import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const { launchAgentFlow, prepareAgentLaunchFlow, recordAgentLaunchGithubClaimed } = require("../src/agent-launch-flow.cts");

const HEAD = "a".repeat(40);
const WORKTREE_PATH = "/wt/review";
const BRANCH = "feature/review";

function input(root: string) {
  return {
    worktree: { mode: "open" as const, branch: BRANCH, remote: "origin" },
    repoPath: "/repo",
    automationDir: "/automation",
    stateDir: root,
    workspaceLabel: "Reviewer PR 44",
    agent: "pi",
    model: "",
    level: "medium",
    uuid: "launch-reviewer",
    promptFilePrefix: "reviewer-prompt",
    project: "demo",
    repository: "owner/repo",
    role: "reviewer",
    target: { kind: "pull-request" as const, number: 44 },
    inputRevision: { head: HEAD },
    requiredVerification: {
      repository: "owner/repo",
      command: "npm test",
      source: { kind: "repo_policy" as const, location: "deadloop.json" },
      baseRevision: HEAD,
    },
    requestEventId: "request-22",
    intendedWorktreePath: WORKTREE_PATH,
    renderPrompt: ({ promiseFile }: { promiseFile: string }) => `promise=${promiseFile}`,
  };
}

/** A valid prior attempt journal on the same canonical checkout. */
function writePriorAttempt(root: string, name: string, record: Record<string, unknown>): void {
  const runDir = path.join(root, "runs", name);
  mkdirSync(runDir, { recursive: true });
  const base = {
    attemptId: name, launchUuid: `${name}-uuid`, project: "demo", repository: "owner/repo",
    role: "reviewer", target: { kind: "pull-request", number: 44 }, inputRevision: { head: HEAD },
    branch: BRANCH, worktreePath: WORKTREE_PATH, agentName: `prior-${name}`, workspaceLabel: "old",
    promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"),
    requestEventId: "request-21",
    ...record,
  };
  writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify(base), "utf8");
}

function operations(calls: string[], initialWorktrees: unknown[] = [], initialWorkspaces: unknown[] = [], gitHeads: Record<string, string> = {}) {
  let launchedName = "";
  // Closing a workspace clears it from the runtime observation, exactly as Herdr does.
  const worktrees = initialWorktrees;
  const workspaces = initialWorkspaces;
  return {
    mkdirSync: () => {},
    alignCheckout: () => {},
    runner: {
      createWorktree: (request: { branch: string; baseBranch?: string }) => {
        calls.push(`createWorktree ${request.branch} base=${request.baseBranch || ""}`);
        return { workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1", worktreePath: WORKTREE_PATH };
      },
      openWorktree: () => ({ workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1", worktreePath: WORKTREE_PATH }),
      renameWorkspace: () => (calls.push("renameWorkspace"), ""),
      startAgent: () => "",
      closeWorkspace: (workspaceId: string) => {
        calls.push(`closeWorkspace ${workspaceId}`);
        for (const worktree of worktrees) {
          if ((worktree as { workspaceId?: string }).workspaceId === workspaceId) delete (worktree as { workspaceId?: string }).workspaceId;
        }
        const index = workspaces.findIndex((workspace) => (workspace as { workspaceId?: string }).workspaceId === workspaceId);
        if (index >= 0) workspaces.splice(index, 1);
        return "closed";
      },
      listWorkspaces: () => workspaces,
      listWorktrees: () => worktrees,
      listAgents: () => launchedName ? [{ name: launchedName, paneId: "pane-1", cwd: WORKTREE_PATH }] : [],
      removeWorktree: () => "",
    },
    runText: (args: string[]) => {
      if (args[0] === "git") {
        const key = args.slice(3).join(" ");
        if (!(key in gitHeads)) throw new Error(`git fixture missing: ${key}`);
        return gitHeads[key];
      }
      calls.push(args.join(" "));
      const nameIndex = args.indexOf("--name");
      if (nameIndex >= 0) launchedName = args[nameIndex + 1];
      return "started";
    },
    writeFileSync: (file: string, text: string) => writeFileSync(file, text, "utf8"),
  };
}

describe("canonical checkout preparation for reviewer relaunches", () => {
  const claimedLaunch = (root: string) => {
    // The reviewer flow prepares the journal, then records the consumed request event before any
    // workspace mutation.
    prepareAgentLaunchFlow(input(root), operations([], [], [], {}));
    recordAgentLaunchGithubClaimed(input(root));
  };

  it("closes a retained workspace a released attempt left open and proceeds", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-checkout-"));
    try {
      writePriorAttempt(root, "prior-stale", {
        phase: "authority_released", lastSuccessfulPhase: "github_claimed",
        workspaceId: "ws-stale", tabId: "tab-stale", rootPaneId: "pane-stale",
        authorityRelease: { reason: "never_launched", releasedAt: "2026-08-01T00:00:00Z" },
      });
      const calls: string[] = [];
      const ops = operations(
        calls,
        [{ path: WORKTREE_PATH, branch: BRANCH, workspaceId: "ws-stale" }],
        [],
        {},
      );
      claimedLaunch(root);
      launchAgentFlow(input(root), ops);
      expect(calls).toContain("closeWorkspace ws-stale");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses a retained workspace owned by an attempt that still holds authority", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-checkout-"));
    try {
      writePriorAttempt(root, "prior-live", {
        phase: "workspace_opened", lastSuccessfulPhase: "workspace_opened",
        workspaceId: "ws-live", tabId: "tab-live", rootPaneId: "pane-live",
      });
      const ops = operations(
        [],
        [{ path: WORKTREE_PATH, branch: BRANCH, workspaceId: "ws-live" }],
      );
      claimedLaunch(root);
      expect(() => launchAgentFlow(input(root), ops)).toThrow(/owned by attempt prior-live/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("prepares the missing canonical checkout through the runner when none exists", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-checkout-"));
    try {
      const calls: string[] = [];
      const ops = operations(
        calls,
        [],
        [],
        {
          "fetch --quiet origin refs/heads/feature/review": "",
          [`rev-parse --verify FETCH_HEAD^{commit}`]: HEAD,
        },
      );
      claimedLaunch(root);
      launchAgentFlow(input(root), ops);
      expect(calls).toContain(`createWorktree ${BRANCH} base=${HEAD}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("stops preparation when the remote branch does not carry the recorded head", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-checkout-"));
    try {
      const otherHead = "b".repeat(40);
      const ops = operations(
        [],
        [],
        [],
        {
          "fetch --quiet origin refs/heads/feature/review": "",
          [`rev-parse --verify FETCH_HEAD^{commit}`]: otherHead,
        },
      );
      claimedLaunch(root);
      expect(() => launchAgentFlow(input(root), ops))
        .toThrow(/does not carry the recorded head/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses to move a local branch that diverged from the recorded head", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-checkout-"));
    try {
      const divergedHead = "b".repeat(40);
      const ops = operations(
        [],
        [],
        [],
        {
          "fetch --quiet origin refs/heads/feature/review": "",
          [`rev-parse --verify FETCH_HEAD^{commit}`]: HEAD,
          [`rev-parse --verify refs/heads/${BRANCH}`]: divergedHead,
        },
      );
      claimedLaunch(root);
      expect(() => launchAgentFlow(input(root), ops))
        .toThrow(/align it by hand instead of moving it silently/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("keeps refusing an ambiguous partial match without touching anything", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-launch-checkout-"));
    try {
      const ops = operations([], [{ path: "/wt/other", branch: BRANCH }]);
      claimedLaunch(root);
      expect(() => launchAgentFlow(input(root), ops))
        .toThrow(/does not resolve to the recorded canonical checkout/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
