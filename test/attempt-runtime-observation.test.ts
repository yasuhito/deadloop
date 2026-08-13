import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { checkoutIsIdle, worktreeIsRetained } = require("../src/attempt-runtime-observation.ts");

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

function record(worktreePath: string) {
  return { worktreePath, agentName: "dl-r-31-owner", rootPaneId: "pane-1" };
}

function runner(overrides: Record<string, unknown> = {}) {
  return { listWorkspaces: () => [], listAgents: () => [], listWorktrees: () => [], ...overrides };
}

describe("attempt runtime observation", () => {
  it("reports an empty checkout idle", () => {
    const worktree = checkout();

    expect(checkoutIsIdle(runner(), record(worktree))).toBe(true);
  });

  it("does not report a checkout idle while an agent works inside it", () => {
    const worktree = checkout();
    const busy = runner({ listAgents: () => [{ name: "other", paneId: "pane-9", cwd: path.join(worktree, "src") }] });

    expect(checkoutIsIdle(busy, record(worktree))).toBe(false);
  });

  it("does not report a checkout idle while an agent reaches it through a symlink", () => {
    const worktree = checkout();
    const link = path.join(path.dirname(worktree), `${path.basename(worktree)}-link`);
    fs.symlinkSync(worktree, link);
    const busy = runner({ listAgents: () => [{ name: "other", paneId: "pane-9", cwd: link }] });

    expect(checkoutIsIdle(busy, record(worktree))).toBe(false);
  });

  it("does not report a checkout idle while the attempt's own agent is listed", () => {
    const worktree = checkout();
    const busy = runner({ listAgents: () => [{ name: "dl-r-31-owner", paneId: "pane-2", cwd: "/elsewhere" }] });

    expect(checkoutIsIdle(busy, record(worktree))).toBe(false);
  });

  it("does not report a checkout idle while a workspace holds it", () => {
    const worktree = checkout();
    const busy = runner({ listWorkspaces: () => [{ workspaceId: "w1", worktreePath: worktree }] });

    expect(checkoutIsIdle(busy, record(worktree))).toBe(false);
  });

  it("reports a listed worktree retained", () => {
    const worktree = checkout();
    const listing = runner({ listWorktrees: () => [{ path: worktree }] });

    expect(worktreeIsRetained(listing, record(worktree), "/repo")).toBe(true);
  });

  it("does not report an unlisted worktree retained", () => {
    const worktree = checkout();

    expect(worktreeIsRetained(runner(), record(worktree), "/repo")).toBe(false);
  });

  it("does not report a worktree retained without a project checkout to list", () => {
    const worktree = checkout();
    const listing = runner({ listWorktrees: () => [{ path: worktree }] });

    expect(worktreeIsRetained(listing, record(worktree), "")).toBe(false);
  });
});
