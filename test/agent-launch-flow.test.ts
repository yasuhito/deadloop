import { describe, expect, it } from "vitest";

const { launchAgentFlow } = require("../src/agent-launch-flow.ts");

describe("エージェント起動フロー", () => {
  it("opens a PR worktree, creates a tab, writes prompt and promise paths, and starts the reviewer through the launcher", () => {
    const commands: string[][] = [];
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
        runJson: (args) => {
          commands.push(args);
          if (args[1] === "worktree") return { workspace_id: "workspace-1", path: "/wt/review" };
          if (args[1] === "tab") return { tab_id: "tab-1" };
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
        runText: (args) => {
          commands.push(args);
          return "launch output";
        },
        writeFileSync: (file, text) => {
          writes[file] = text;
        },
      },
    );

    expect({ result, commands, writes }).toEqual({
      result: {
        workspaceId: "workspace-1",
        tabId: "tab-1",
        worktreePath: "/wt/review",
        promptFile: "/wt/review/.deadloop/reviewer-prompt-U-review.md",
        promiseFile: "/wt/review/.deadloop/promise-U-review.json",
        launchOutput: "launch output",
      },
      commands: [
        [
          "herdr",
          "worktree",
          "open",
          "--cwd",
          "/repo",
          "--branch",
          "feature/review",
          "--label",
          "demo-pr-44-reviewer",
          "--no-focus",
          "--json",
        ],
        ["herdr", "tab", "create", "--workspace", "workspace-1", "--cwd", "/wt/review", "--label", "demo-pr-44-reviewer", "--no-focus"],
        [
          "node",
          "/automation/launch-agent.ts",
          "--agent",
          "pi",
          "--name",
          "demo-pr-44-reviewer",
          "--cwd",
          "/wt/review",
          "--repo-path",
          "/repo",
          "--level",
          "medium",
          "--model",
          "",
          "--uuid",
          "U-review",
          "--prompt-file",
          "/wt/review/.deadloop/reviewer-prompt-U-review.md",
          "--tab",
          "tab-1",
        ],
      ],
      writes: {
        "/wt/review/.deadloop/reviewer-prompt-U-review.md": "review promise: /wt/review/.deadloop/promise-U-review.json",
      },
    });
  });

  it("creates a Worker worktree from the base branch before starting the Worker through the launcher", () => {
    const commands: string[][] = [];

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
        runJson: (args) => {
          commands.push(args);
          if (args[1] === "worktree") return { workspaceId: "workspace-2", worktreePath: "/wt/worker" };
          if (args[1] === "tab") return { tabId: "tab-2" };
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
        runText: (args) => {
          commands.push(args);
          return "launch output";
        },
        writeFileSync: () => {},
      },
    );

    expect(commands[0]).toEqual([
      "herdr",
      "worktree",
      "create",
      "--cwd",
      "/repo",
      "--branch",
      "agent/issue-12-task",
      "--base",
      "origin/main",
      "--label",
      "demo-issue-12-worker",
      "--no-focus",
      "--json",
    ]);
  });
});
