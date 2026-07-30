import { describe, expect, it } from "vitest";

const { launchAgentFlow } = require("../src/agent-launch-flow.ts");

describe("エージェント起動フロー", () => {
  it("renders a Worker prompt with the exact created worktree HEAD", () => {
    let prompt = "";

    launchAgentFlow(
      {
        worktree: { mode: "create", branch: "agent/issue-1", baseBranch: "origin/main" },
        repoPath: "/repo",
        automationDir: "/automation",
        stateDir: "/state/deadloop",
        name: "demo-issue-1-worker",
        agent: "pi",
        model: "",
        level: "medium",
        uuid: "U-worker",
        promptFilePrefix: "worker-prompt",
        resolveWorktreeHead: true,
        renderPrompt: ({ worktreeHead }: { worktreeHead?: string }) => `head: ${worktreeHead}`,
      },
      {
        mkdirSync: () => {},
        runner: {
          createWorktree: () => ({ workspaceId: "workspace-1", worktreePath: "/wt/worker" }),
          openWorktree: () => { throw new Error("unexpected openWorktree"); },
          createTab: () => ({ tabId: "tab-1" }),
          startAgent: () => { throw new Error("unexpected startAgent"); },
          listWorktrees: () => [],
          listAgents: () => [],
          removeAgent: () => "",
          removeWorktree: () => "",
        },
        runText: (args: string[]) => args.includes("rev-parse") ? `${"a".repeat(40)}\n` : "launch output",
        writeFileSync: (_file: string, text: string) => { prompt = text; },
      },
    );

    expect(prompt).toBe(`head: ${"a".repeat(40)}`);
  });

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
});
