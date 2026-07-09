import { describe, expect, it } from "vitest";

const { launchAgentFlow } = require("../src/agent-launch-flow.ts");

describe("エージェント起動フロー", () => {
  it("opens a PR worktree through the runner, writes prompt and promise paths, and starts the reviewer through the launcher", () => {
    const calls: string[] = [];
    const writes: Record<string, string> = {};

    const result = launchAgentFlow(
      {
        worktree: { mode: "open", branch: "feature/review" },
        repoPath: "/repo",
        automationDir: "/automation",
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
        promptFile: "/wt/review/.deadloop/reviewer-prompt-U-review.md",
        promiseFile: "/wt/review/.deadloop/promise-U-review.json",
        launchOutput: "launch output",
      },
      calls: [
        "openWorktree",
        "createTab",
        "node /automation/launch-agent.ts --agent pi --name demo-pr-44-reviewer --cwd /wt/review --repo-path /repo --level medium --model  --uuid U-review --prompt-file /wt/review/.deadloop/reviewer-prompt-U-review.md --tab tab-1",
      ],
      writes: {
        "/wt/review/.deadloop/reviewer-prompt-U-review.md": "review promise: /wt/review/.deadloop/promise-U-review.json",
      },
    });
  });

  it("creates a Worker worktree from the base branch before starting the Worker through the launcher", () => {
    const calls: string[] = [];

    launchAgentFlow(
      {
        worktree: { mode: "create", branch: "agent/issue-12-task", baseBranch: "origin/main" },
        repoPath: "/repo",
        automationDir: "/automation",
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
          removeWorktree: () => "",
        },
        runText: () => "launch output",
        writeFileSync: () => {},
      },
    );

    expect(calls[0]).toBe("agent/issue-12-task:origin/main:demo-issue-12-worker");
  });
});
