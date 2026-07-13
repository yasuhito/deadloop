import { describe, expect, it } from "vitest";

const { launchAgentFlow } = require("../src/agent-launch-flow.ts");

function attemptReviewerReplacement(agents: Record<string, unknown>[]) {
  return launchAgentFlow(
    {
      worktree: { mode: "open", branch: "feature/review" },
      repoPath: "/repo",
      automationDir: "/automation",
      stateDir: "/state/deadloop",
      name: "demo-pr-44-reviewer",
      agent: "pi",
      model: "",
      level: "medium",
      uuid: "U-review-replacement",
      promptFilePrefix: "reviewer-prompt",
      renderPrompt: ({ promiseFile }) => `review promise: ${promiseFile}`,
    },
    {
      mkdirSync: () => {},
      runner: {
        openWorktree: () => ({ workspaceId: "workspace-1", worktreePath: "/wt/review" }),
        createWorktree: () => {
          throw new Error("unexpected createWorktree");
        },
        createTab: () => {
          throw new Error("unexpected duplicate launch");
        },
        startAgent: () => {
          throw new Error("unexpected startAgent");
        },
        listWorktrees: () => [],
        listAgents: () => agents,
        removeAgent: () => "",
        removeWorktree: () => "",
      },
      runText: () => {
        throw new Error("unexpected duplicate launch");
      },
      writeFileSync: () => {},
    },
  );
}

describe("エージェント起動フロー", () => {
  it("opens a PR worktree through the runner, writes prompt and promise paths, and starts the reviewer through the launcher", () => {
    const calls: string[] = [];
    const writes: Record<string, string> = {};

    const result = launchAgentFlow(
      {
        worktree: { mode: "open", branch: "feature/review" },
        repoPath: "/repo",
        automationDir: "/automation",
        stateDir: "/state/deadloop",
        name: "demo-pr-44-reviewer",
        agent: "pi",
        model: "",
        level: "medium",
        uuid: "U-review",
        promptFilePrefix: "reviewer-prompt",
        renderPrompt: ({ promiseFile }) => `review promise: ${promiseFile}`,
      },
      {
        mkdirSync: () => {},
        runner: {
          openWorktree: () => {
            calls.push("openWorktree");
            return { workspaceId: "workspace-1", worktreePath: "/wt/review" };
          },
          createWorktree: () => {
            throw new Error("unexpected createWorktree");
          },
          createTab: () => {
            calls.push("createTab");
            return { tabId: "tab-1" };
          },
          startAgent: () => {
            throw new Error("unexpected startAgent");
          },
          listWorktrees: () => [],
          listAgents: () => [],
          removeAgent: () => "",
          removeWorktree: () => "",
        },
        runText: (args) => {
          calls.push(args.join(" "));
          return "launch output";
        },
        writeFileSync: (file, text) => {
          writes[file] = text;
        },
      },
    );

    expect({ result, calls, writes }).toEqual({
      result: {
        workspaceId: "workspace-1",
        tabId: "tab-1",
        worktreePath: "/wt/review",
        promptFile: "/state/deadloop/runs/U-review/reviewer-prompt.md",
        promiseFile: "/state/deadloop/runs/U-review/promise.json",
        launchOutput: "launch output",
      },
      calls: [
        "openWorktree",
        "createTab",
        "node /automation/launch-agent.ts --agent pi --name demo-pr-44-reviewer --cwd /wt/review --repo-path /repo --level medium --model  --uuid U-review --prompt-file /state/deadloop/runs/U-review/reviewer-prompt.md --tab tab-1",
      ],
      writes: {
        "/state/deadloop/runs/U-review/reviewer-prompt.md": "review promise: /state/deadloop/runs/U-review/promise.json",
      },
    });
  });

  it("retires a finished same-name reviewer before starting its replacement", () => {
    const calls: string[] = [];

    launchAgentFlow(
      {
        worktree: { mode: "open", branch: "feature/review" },
        repoPath: "/repo",
        automationDir: "/automation",
        stateDir: "/state/deadloop",
        name: "demo-pr-44-reviewer",
        agent: "pi",
        model: "",
        level: "medium",
        uuid: "U-review-2",
        promptFilePrefix: "reviewer-prompt",
        renderPrompt: ({ promiseFile }) => `review promise: ${promiseFile}`,
      },
      {
        mkdirSync: () => {},
        runner: {
          openWorktree: () => ({ workspaceId: "workspace-1", worktreePath: "/wt/review" }),
          createWorktree: () => {
            throw new Error("unexpected createWorktree");
          },
          createTab: () => {
            calls.push("createTab");
            return { tabId: "tab-2" };
          },
          startAgent: () => {
            throw new Error("unexpected startAgent");
          },
          listWorktrees: () => [],
          listAgents: () => [
            {
              name: "demo-pr-44-reviewer",
              status: "done",
              cwd: "/wt/review",
              agentId: "pane-finished",
            },
          ],
          removeAgent: (agentId: string) => {
            calls.push(`removeAgent:${agentId}`);
            return "";
          },
          removeWorktree: () => "",
        },
        runText: () => {
          calls.push("launch");
          return "launch output";
        },
        writeFileSync: () => {},
      },
    );

    expect(calls).toEqual(["removeAgent:pane-finished", "createTab", "launch"]);
  });

  it("refuses to duplicate a working same-name reviewer", () => {
    expect(() =>
      attemptReviewerReplacement([
        { name: "demo-pr-44-reviewer", status: "working", cwd: "/wt/review", agentId: "pane-working" },
      ]),
    ).toThrow("agent name demo-pr-44-reviewer is working; refusing duplicate launch");
  });

  it("refuses to clean up ambiguous same-name reviewers", () => {
    expect(() =>
      attemptReviewerReplacement([
        { name: "demo-pr-44-reviewer", status: "done", cwd: "/wt/review", agentId: "pane-1" },
        { name: "demo-pr-44-reviewer", status: "done", cwd: "/wt/review", agentId: "pane-2" },
      ]),
    ).toThrow("agent name demo-pr-44-reviewer has 2 live candidates; refusing cleanup");
  });

  it("refuses to clean up a same-name reviewer from another worktree", () => {
    expect(() =>
      attemptReviewerReplacement([
        { name: "demo-pr-44-reviewer", status: "done", cwd: "/wt/other", agentId: "pane-other" },
      ]),
    ).toThrow("agent name demo-pr-44-reviewer belongs to a different worktree; refusing cleanup");
  });

  it("creates a Worker worktree from the base branch before starting the Worker through the launcher", () => {
    const calls: string[] = [];

    launchAgentFlow(
      {
        worktree: { mode: "create", branch: "agent/issue-12-task", baseBranch: "origin/main" },
        repoPath: "/repo",
        automationDir: "/automation",
        stateDir: "/state/deadloop",
        name: "demo-issue-12-worker",
        agent: "pi",
        model: "gpt-5",
        level: "medium",
        uuid: "U-worker",
        promptFilePrefix: "worker-prompt",
        renderPrompt: ({ promiseFile }) => `worker promise: ${promiseFile}`,
      },
      {
        mkdirSync: () => {},
        runner: {
          createWorktree: (input) => {
            calls.push(`${input.branch}:${input.baseBranch}:${input.label}`);
            return { workspaceId: "workspace-2", worktreePath: "/wt/worker" };
          },
          openWorktree: () => {
            throw new Error("unexpected openWorktree");
          },
          createTab: () => ({ tabId: "tab-2" }),
          startAgent: () => {
            throw new Error("unexpected startAgent");
          },
          listWorktrees: () => [],
          listAgents: () => [],
          removeAgent: () => "",
          removeWorktree: () => "",
        },
        runText: () => "launch output",
        writeFileSync: () => {},
      },
    );

    expect(calls[0]).toBe("agent/issue-12-task:origin/main:demo-issue-12-worker");
  });
});
