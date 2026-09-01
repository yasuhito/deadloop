import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { closeSettledAttemptWorkspace, readSettledWorkspaceCleanupReceipt, recordSettledWorkspaceCleanupReceipt } = require("../src/settled-workspace-closure.cts");

const HEAD = "a".repeat(40);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

type World = {
  root: string;
  runDir: string;
  worktreePath: string;
  workspaceList: unknown[];
  closeError?: Error;
  gitFailures?: string[];
};

function fixture(overrides: Partial<World> = {}): World {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-settled-closure-"));
  roots.push(root);
  const runDir = path.join(root, "runs", "attempt-1");
  const worktreePath = path.join(root, "worktrees", "pr-42");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "attempt.json"), `${JSON.stringify({
    attemptId: "attempt-1", launchUuid: "launch-1", project: "demo", repository: "octo/demo", role: "reviewer",
    target: { kind: "pull-request", number: 42 }, inputRevision: { head: HEAD }, branch: "pr-42",
    worktreePath, agentName: "reviewer", workspaceLabel: "reviewer 42",
    promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"),
    phase: "github_persisted", lastSuccessfulPhase: "github_persisted",
    workspaceId: "workspace-1", tabId: "tab-1", rootPaneId: "pane-1",
  })}\n`);
  const world: World = {
    root, runDir, worktreePath,
    workspaceList: [{ workspace_id: "workspace-1", pane_count: 1, tab_count: 1, worktree: { checkout_path: worktreePath } }],
    ...overrides,
  };
  return world;
}

function commandRunner(world: World) {
  return {
    runText(args: string[]) {
      if (args[0] === "git" && args.includes("--git-common-dir")) return `${world.root}/.git\n`;
      if (args[0] === "git" && args.includes("--show-toplevel")) return `${world.worktreePath}\n`;
      if (args[0] === "git" && args.includes("--porcelain")) return `worktree ${world.root}\n\nworktree ${world.worktreePath}\nbranch refs/heads/pr-42\n`;
      if (args[0] === "herdr" && args[1] === "workspace" && args[2] === "close") {
        if (world.closeError) throw world.closeError;
        world.workspaceList = [];
        return "";
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    },
    runJson(args: string[]) {
      if (args[0] === "herdr" && args[1] === "workspace") return { result: { workspaces: world.workspaceList } };
      throw new Error(`unexpected ${args.join(" ")}`);
    },
  };
}

function close(world: World) {
  return closeSettledAttemptWorkspace({
    attemptRecord: path.join(world.runDir, "attempt.json"),
    projectId: "demo", projectRepo: world.root, githubRepo: "octo/demo", stateDir: world.root, enabledAt: "1",
  }, commandRunner(world));
}

function receipt(world: World): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(world.runDir, "settled-workspace-cleanup.json"), "utf8"));
}

describe("settled workspace closure", () => {
  it("closes an exactly-owned workspace and records the bounded receipt", () => {
    const world = fixture();
    const outcome = close(world);
    expect({ outcome, list: world.workspaceList, receipt: receipt(world).outcome }).toEqual({
      outcome: { closed: true },
      list: [],
      receipt: "closed",
    });
  });

  it("refuses a workspace its journal does not exactly own and records the reason", () => {
    const world = fixture({
      workspaceList: [{ workspace_id: "workspace-1", pane_count: 1, tab_count: 1, worktree: { checkout_path: "/somewhere/else" } }],
    });
    const outcome = close(world);
    expect({ outcome, receipt: receipt(world) }).toEqual({
      outcome: { closed: false, detail: "workspace ownership is ambiguous" },
      receipt: { schemaVersion: 1, attemptId: "attempt-1", phase: "github_persisted", outcome: "failed", detail: "workspace ownership is ambiguous", at: expect.any(String) },
    });
  });

  it("keeps the close failure reason in the receipt when Herdr refuses the close", () => {
    const world = fixture({ closeError: new Error("close timed out") });
    const outcome = close(world);
    expect({ outcome, receipt: receipt(world).detail }).toEqual({
      outcome: { closed: false, detail: "close timed out" },
      receipt: "close timed out",
    });
  });
});

describe("patrol receipt for a closure command that failed before writing one", () => {
  function runDir(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-settled-receipt-"));
    roots.push(root);
    return root;
  }

  it("records the failed attempt so the patrol does not retry it every tick", () => {
    const dir = runDir();
    recordSettledWorkspaceCleanupReceipt(dir, { attemptId: "attempt-1", phase: "authority_released" }, "failed", "command timed out");

    expect(readSettledWorkspaceCleanupReceipt(dir)).toMatchObject({ attemptId: "attempt-1", outcome: "failed", detail: "command timed out" });
  });

  it("keeps the failure reason readable for doctor's retry command", () => {
    const dir = runDir();
    recordSettledWorkspaceCleanupReceipt(dir, { attemptId: "attempt-2", phase: "authority_released" }, "failed", "workspace observation is pending");

    expect(readSettledWorkspaceCleanupReceipt(dir)?.detail).toBe("workspace observation is pending");
  });
});
