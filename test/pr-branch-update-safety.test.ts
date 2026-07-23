import { describe, expect, it } from "vitest";

const { decidePushGuard, finalizeBranchUpdate } = require("../extensions/deadloop/automations/pr-branch-update-finalize.ts");
const {
  branchUpdateAttemptExists,
  branchUpdateRetryKey,
  renderBranchUpdateMarker,
} = require("../extensions/deadloop/automations/pr-branch-update-state.ts");

const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function finalizeWith(commands: string[][], actualHead = head, headAfterAuthorization?: string) {
  let observedHead = actualHead;
  return finalizeBranchUpdate(
    {
      repo: "/worktree",
      projectRepo: "/repo",
      githubRepo: "owner/repo",
      pr: "31",
      branch: "agent/issue-31",
      expectedHead: head,
      expectedBase: base,
      remote: "origin",
      automationDir: "/automation",
      stateDir: "/state",
      enabledAt: 1,
      checkCommand: "npm test",
    },
    {
      assertEnabled: () => { if (headAfterAuthorization) observedHead = headAfterAuthorization; },
      run: (args: string[]) => {
        commands.push(args);
        if (args[0] === "gh") {
          return {
            status: 0,
            stdout: JSON.stringify({
              state: "OPEN",
              isCrossRepository: false,
              headRefName: "agent/issue-31",
              headRefOid: observedHead,
            }),
            stderr: "",
          };
        }
        if (args.at(-1) === "HEAD" && args.includes("rev-parse")) {
          return { status: 0, stdout: "cccccccccccccccccccccccccccccccccccccccc\n", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  );
}

function finalizeWhileDisabled() {
  const commands: string[][] = [];
  let error = "";
  try {
    finalizeBranchUpdate(
      {
        repo: "/worktree", projectRepo: "/repo", githubRepo: "owner/repo", pr: "31",
        branch: "agent/issue-31", expectedHead: head, expectedBase: base, remote: "origin",
        automationDir: "/automation", stateDir: "/state", enabledAt: 1, checkCommand: "npm test",
      },
      {
        assertEnabled: () => { throw new Error("deadloop is disabled for this repository"); },
        run: (args: string[]) => {
          commands.push(args);
          if (args[0] === "gh") return { status: 0, stdout: JSON.stringify({ state: "OPEN", isCrossRepository: false, headRefName: "agent/issue-31", headRefOid: head }), stderr: "" };
          if (args.at(-1) === "HEAD" && args.includes("rev-parse")) return { status: 0, stdout: `${"c".repeat(40)}\n`, stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return { error, commands };
}

describe("PR branch-update safety", () => {
  it("derives the same retry key for the same exact pair", () => {
    expect(branchUpdateRetryKey(head, base)).toBe("63bdfe090637cf9ff5d4");
  });

  it("recognizes a persisted exact-pair attempt marker", () => {
    expect(branchUpdateAttemptExists([{ body: renderBranchUpdateMarker(head, base) }], head, base)).toBe(true);
  });

  it("allows a new attempt when the base head changes", () => {
    expect(branchUpdateAttemptExists([{ body: renderBranchUpdateMarker(head, base) }], head, "cccccccccccccccccccccccccccccccccccccccc")).toBe(false);
  });

  it("stops a stale PR head without authorizing push", () => {
    expect(
      decidePushGuard(
        { state: "OPEN", isCrossRepository: false, headRefName: "agent/issue-31", headRefOid: base },
        "agent/issue-31",
        head,
      ).action,
    ).toBe("stale_head");
  });

  it("treats a cross-repository target as unsafe", () => {
    expect(
      decidePushGuard(
        { state: "OPEN", isCrossRepository: true, headRefName: "agent/issue-31", headRefOid: head },
        "agent/issue-31",
        head,
      ).action,
    ).toBe("blocked");
  });

  it("runs the configured check before querying the PR head", () => {
    const commands: string[][] = [];
    finalizeWith(commands);

    expect(commands.findIndex((command) => command[0] === "node")).toBeLessThan(commands.findIndex((command) => command[0] === "gh"));
  });

  it("pushes only the selected existing branch without force", () => {
    const commands: string[][] = [];
    finalizeWith(commands);

    expect(commands.find((command) => command.includes("push"))).toEqual([
      "git",
      "-C",
      "/worktree",
      "push",
      "--porcelain",
      "origin",
      "HEAD:refs/heads/agent/issue-31",
    ]);
  });

  it("does not push when the immediate PR-head check is stale", () => {
    const commands: string[][] = [];
    finalizeWith(commands, base);

    expect(commands.some((command) => command.includes("push"))).toBe(false);
  });

  it("rechecks the PR head after waiting for the enablement lock", () => {
    const commands: string[][] = [];
    finalizeWith(commands, head, base);

    expect(commands.some((command) => command.includes("push"))).toBe(false);
  });

  it("reports disabled enablement before finalization", () => {
    expect(finalizeWhileDisabled().error).toBe("deadloop is disabled for this repository");
  });

  it("does not push when deadloop is disabled before finalization", () => {
    expect(finalizeWhileDisabled().commands.some((command) => command.includes("push"))).toBe(false);
  });
});
