import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { observeAttemptLiveness, observeAttemptRuntime, observeAttemptTurn } = require("../src/attempt-runtime-observation.cts");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function checkout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-runtime-observation-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  return root;
}

function attempt(overrides: Record<string, unknown> = {}) {
  return { attemptId: "attempt-1", workspaceId: "workspace-1", worktreePath: "/wt", rootPaneId: "pane-1", agentName: "owner", ...overrides };
}

function runner(overrides: Record<string, unknown> = {}) {
  return {
    listWorkspaces: () => [{ workspaceId: "workspace-1", worktreePath: "/wt", tabCount: 1, paneCount: 1 }],
    listAgents: () => [],
    listWorktrees: () => [{ path: "/wt" }],
    ...overrides,
  };
}

/** A run directory holding the receipt the host writes before closing the workspace it owns. */
function closedWorkspaceRunDir(receipt: Record<string, unknown> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-close-proof-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "authority-release-started.json"), JSON.stringify({
    schemaVersion: 1, attemptId: "attempt-1", workspaceId: "workspace-1", worktreePath: "/wt", ...receipt,
  }));
  return root;
}

describe("attempt liveness observation", () => {
  it("reports an attempt whose agent left the runtime owner absent", () => {
    expect(observeAttemptLiveness(runner(), attempt()).kind).toBe("owner_absent");
  });

  it("reports the attempt's own working agent live", () => {
    const working = runner({ listAgents: () => [{ name: "owner", paneId: "pane-1", cwd: "/wt", status: "working" }] });

    expect(observeAttemptLiveness(working, attempt()).kind).toBe("live");
  });

  it("reports the attempt's own agent awaiting input live", () => {
    const awaiting = runner({ listAgents: () => [{ name: "owner", paneId: "pane-1", cwd: "/wt", status: "idle" }] });

    expect(observeAttemptLiveness(awaiting, attempt()).kind).toBe("live");
  });

  it("reports the attempt's own agent that finished its turn live", () => {
    const finished = runner({ listAgents: () => [{ name: "owner", paneId: "pane-1", cwd: "/wt", status: "done" }] });

    expect(observeAttemptLiveness(finished, attempt()).kind).toBe("live");
  });

  it("reports the attempt's own agent blocked on its own prompt live", () => {
    const blocked = runner({ listAgents: () => [{ name: "owner", paneId: "pane-1", cwd: "/wt", status: "blocked" }] });

    expect(observeAttemptLiveness(blocked, attempt()).kind).toBe("live");
  });

  it("reports the attempt's own agent of unreadable status live", () => {
    const unreadable = runner({ listAgents: () => [{ name: "owner", paneId: "pane-1", cwd: "/wt", status: "unknown" }] });

    expect(observeAttemptLiveness(unreadable, attempt()).kind).toBe("live");
  });

  it("reports owner absent while the attempt's own workspace stays open", () => {
    const openWorkspace = runner({ listWorkspaces: () => [{ workspaceId: "workspace-1", worktreePath: "/wt", tabCount: 1, paneCount: 1 }] });

    expect(observeAttemptLiveness(openWorkspace, attempt()).kind).toBe("owner_absent");
  });

  it("reports owner absent after the workspace closed without a receipt", () => {
    const closed = runner({ listWorkspaces: () => [], listWorktrees: () => [] });

    expect(observeAttemptLiveness(closed, attempt()).kind).toBe("owner_absent");
  });

  it("does not ask the runtime about workspaces", () => {
    const workspacesRefused = runner({ listWorkspaces: () => { throw new Error("workspaces must not decide liveness"); } });

    expect(observeAttemptLiveness(workspacesRefused, attempt()).kind).toBe("owner_absent");
  });

  it("fails closed when another agent occupies the checkout", () => {
    const foreign = runner({ listAgents: () => [{ name: "foreign", paneId: "pane-2", cwd: "/wt", status: "working" }] });

    expect(observeAttemptLiveness(foreign, attempt()).kind).toBe("ambiguous");
  });

  it("fails closed when another agent occupies a nested checkout path", () => {
    const nested = runner({ listAgents: () => [{ name: "foreign", paneId: "pane-2", cwd: "/wt/src", status: "working" }] });

    expect(observeAttemptLiveness(nested, attempt()).kind).toBe("ambiguous");
  });

  it("fails closed when an agent reaches the checkout through a symlink", () => {
    const worktree = checkout();
    const link = path.join(path.dirname(worktree), `${path.basename(worktree)}-link`);
    fs.symlinkSync(worktree, link);
    const linked = runner({ listAgents: () => [{ name: "foreign", paneId: "pane-2", cwd: link, status: "working" }] });

    expect(observeAttemptLiveness(linked, attempt({ worktreePath: worktree })).kind).toBe("ambiguous");
  });

  it("fails closed when an agent shares the attempt's name from another checkout", () => {
    const renamed = runner({ listAgents: () => [{ name: "owner", paneId: "pane-9", cwd: "/elsewhere", status: "done" }] });

    expect(observeAttemptLiveness(renamed, attempt()).kind).toBe("ambiguous");
  });

});

describe("attempt turn observation", () => {
  it("reports the attempt's working turn", () => {
    const working = runner({ listAgents: () => [{ name: "owner", paneId: "pane-1", cwd: "/wt", status: "working" }] });

    expect(observeAttemptTurn(working, attempt())).toEqual({ kind: "working", agent: { name: "owner", paneId: "pane-1", cwd: "/wt", status: "working" } });
  });

  it.each(["idle", "done", "blocked"])("reports the attempt's %s turn terminal", (status) => {
    const terminal = runner({ listAgents: () => [{ name: "owner", paneId: "pane-1", cwd: "/wt", status }] });

    expect(observeAttemptTurn(terminal, attempt())).toMatchObject({ kind: "terminal", status });
  });

  it("does not infer a turn from an unknown runtime status", () => {
    const unknown = runner({ listAgents: () => [{ name: "owner", paneId: "pane-1", cwd: "/wt", status: "unknown" }] });

    expect(observeAttemptTurn(unknown, attempt()).kind).toBe("ambiguous");
  });

  it("reports an absent owner separately from a terminal turn", () => {
    expect(observeAttemptTurn(runner(), attempt()).kind).toBe("owner_absent");
  });
});

describe("attempt runtime observation", () => {
  it("reports the attempt's own working agent live", () => {
    const working = runner({ listAgents: () => [{ name: "owner", paneId: "pane-1", cwd: "/wt", status: "working" }] });

    expect(observeAttemptRuntime(working, attempt()).kind).toBe("live_matching_owner");
  });

  it("reports an attempt whose agent left the runtime owner absent", () => {
    expect(observeAttemptRuntime(runner(), attempt()).kind).toBe("owner_absent_owned");
  });

  it("reports the attempt's own agent that finished its turn live", () => {
    const finished = runner({ listAgents: () => [{ name: "owner", paneId: "pane-1", cwd: "/wt", status: "done" }] });

    expect(observeAttemptRuntime(finished, attempt()).kind).toBe("live_matching_owner");
  });

  it("refuses absent-owner ownership when another workspace holds the checkout", () => {
    const shared = runner({ listWorkspaces: () => [
      { workspaceId: "workspace-1", worktreePath: "/wt", tabCount: 1, paneCount: 1 },
      { workspaceId: "workspace-2", worktreePath: "/wt", tabCount: 1, paneCount: 1 },
    ] });

    expect(observeAttemptRuntime(shared, attempt()).kind).toBe("ambiguous");
  });

  it("refuses absent-owner ownership when the workspace has an extra pane", () => {
    const extraPane = runner({ listWorkspaces: () => [{ workspaceId: "workspace-1", worktreePath: "/wt", tabCount: 1, paneCount: 2 }] });

    expect(observeAttemptRuntime(extraPane, attempt()).kind).toBe("ambiguous");
  });

  it("refuses absent-owner ownership when the workspace has an extra tab", () => {
    const extraTab = runner({ listWorkspaces: () => [{ workspaceId: "workspace-1", worktreePath: "/wt", tabCount: 2, paneCount: 1 }] });

    expect(observeAttemptRuntime(extraTab, attempt()).kind).toBe("ambiguous");
  });

  it("refuses absent-owner ownership when another agent occupies the checkout", () => {
    const foreign = runner({ listAgents: () => [{ name: "foreign", paneId: "pane-2", cwd: "/wt", status: "working" }] });

    expect(observeAttemptRuntime(foreign, attempt()).kind).toBe("ambiguous");
  });

  it("refuses absent-owner ownership when another agent occupies a nested checkout path", () => {
    const nested = runner({ listAgents: () => [{ name: "foreign", paneId: "pane-2", cwd: "/wt/src", status: "working" }] });

    expect(observeAttemptRuntime(nested, attempt()).kind).toBe("ambiguous");
  });

  it("refuses absent-owner ownership when an agent reaches the checkout through a symlink", () => {
    const worktree = checkout();
    const link = path.join(path.dirname(worktree), `${path.basename(worktree)}-link`);
    fs.symlinkSync(worktree, link);
    const linked = runner({
      listWorkspaces: () => [{ workspaceId: "workspace-1", worktreePath: worktree, tabCount: 1, paneCount: 1 }],
      listAgents: () => [{ name: "foreign", paneId: "pane-2", cwd: link, status: "working" }],
    });

    expect(observeAttemptRuntime(linked, attempt({ worktreePath: worktree })).kind).toBe("ambiguous");
  });

  it("reports the matching owner of unreadable status live", () => {
    const unreadable = runner({ listAgents: () => [{ name: "owner", paneId: "pane-1", cwd: "/wt", status: "unknown" }] });

    expect(observeAttemptRuntime(unreadable, attempt()).kind).toBe("live_matching_owner");
  });

  it("reports the owner absent after its own workspace was closed with a receipt", () => {
    const runDir = closedWorkspaceRunDir();
    const closed = runner({ listWorkspaces: () => [] });

    expect(observeAttemptRuntime(closed, attempt({ runDir }), process.cwd()).kind).toBe("owner_absent_owned");
  });

  it("refuses absent-owner ownership for a closed workspace whose worktree is gone", () => {
    const runDir = closedWorkspaceRunDir();
    const discarded = runner({ listWorkspaces: () => [], listWorktrees: () => [] });

    expect(observeAttemptRuntime(discarded, attempt({ runDir }), process.cwd()).kind).toBe("ambiguous");
  });

  it("refuses absent-owner ownership for a closed workspace without a matching receipt", () => {
    const runDir = closedWorkspaceRunDir({ attemptId: "other-attempt" });
    const closed = runner({ listWorkspaces: () => [] });

    expect(observeAttemptRuntime(closed, attempt({ runDir }), process.cwd()).kind).toBe("ambiguous");
  });

  it("applies nested checkout occupancy proof when recovering a close receipt", () => {
    const runDir = closedWorkspaceRunDir();
    const nested = runner({ listWorkspaces: () => [], listAgents: () => [{ name: "foreign", paneId: "pane-2", cwd: "/wt/src", status: "working" }] });

    expect(observeAttemptRuntime(nested, attempt({ runDir }), process.cwd()).kind).toBe("ambiguous");
  });

  it("applies checkout-wide agent proof when recovering a close receipt", () => {
    const runDir = closedWorkspaceRunDir();
    const occupied = runner({ listWorkspaces: () => [], listAgents: () => [{ name: "foreign", paneId: "pane-2", cwd: "/wt", status: "working" }] });

    expect(observeAttemptRuntime(occupied, attempt({ runDir }), process.cwd()).kind).toBe("ambiguous");
  });

  it("fails closed on an unknown owner status while recovering a close receipt", () => {
    const runDir = closedWorkspaceRunDir();
    const unknown = runner({ listWorkspaces: () => [], listAgents: () => [{ name: "owner", paneId: "pane-1", cwd: "/wt/src", status: "unknown" }] });

    expect(observeAttemptRuntime(unknown, attempt({ runDir }), process.cwd()).kind).toBe("ambiguous");
  });

  it("refuses absent-owner ownership for a closed workspace without a project checkout to list", () => {
    const runDir = closedWorkspaceRunDir();
    const closed = runner({ listWorkspaces: () => [] });

    expect(observeAttemptRuntime(closed, attempt({ runDir })).kind).toBe("ambiguous");
  });

  it("reports the owner absent for a github_persisted journal whose workspace closed without a receipt", () => {
    const closed = runner({ listWorkspaces: () => [] });

    expect(observeAttemptRuntime(closed, attempt({ phase: "github_persisted" }), process.cwd()).kind).toBe("owner_absent_owned");
  });

  it("refuses a github_persisted journal whose closed workspace left no retained worktree", () => {
    const discarded = runner({ listWorkspaces: () => [], listWorktrees: () => [] });

    expect(observeAttemptRuntime(discarded, attempt({ phase: "github_persisted" }), process.cwd()).kind).toBe("ambiguous");
  });

  it("refuses a github_persisted journal whose closed checkout another agent occupies", () => {
    const occupied = runner({ listWorkspaces: () => [], listAgents: () => [{ name: "foreign", paneId: "pane-2", cwd: "/wt", status: "working" }] });

    expect(observeAttemptRuntime(occupied, attempt({ phase: "github_persisted" }), process.cwd()).kind).toBe("ambiguous");
  });
});
