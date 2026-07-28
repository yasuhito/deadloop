/**
 * Byte-for-byte baseline of the selected Herdr 0.7.3 runtime path.
 *
 * The disposable-workspace tickets land the 0.7.5 lifecycle as unselected modules, so every ticket
 * before activation must leave this log untouched. A failure here means the live launch path moved:
 * either that was unintended, or the activation ticket is retiring 0.7.3 on purpose and rewrites the
 * fixture in the same change. The fixture is never regenerated automatically.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const { createHerdrRunner } = require("../src/herdr-runner.ts");
const { launchAgentFlow } = require("../src/agent-launch-flow.ts");

const BASELINE_FILE = "test/fixtures/herdr-0.7.3-baseline.json";

type CommandLog = unknown[];

function captureHerdrCommands(): CommandLog {
  const commands: CommandLog = [];
  const record = (command: string, args: string[]) => {
    commands.push([command, ...args]);
  };
  const runner = createHerdrRunner({
    runJson: (command: string, args: string[]) => {
      record(command, args);
      return { workspace_id: "w1", path: "/wt", tab_id: "tab-1" };
    },
    runText: (command: string, args: string[]) => {
      record(command, args);
      return "";
    },
  });

  runner.createWorktree({ repoPath: "/repo", branch: "agent/issue-1", baseBranch: "origin/main", label: "dl-worker" });
  runner.openWorktree({ repoPath: "/repo", branch: "agent/issue-1", label: "dl-reviewer" });
  runner.createTab({ workspaceId: "w1", cwd: "/wt", label: "dl-reviewer" });
  runner.startAgent({
    name: "dl-reviewer",
    cwd: "/wt",
    tabId: "tab-1",
    agentArgv: ["pi", "--prompt-file", "/state/deadloop/runs/U-baseline/reviewer-prompt.md"],
  });
  runner.listWorktrees("/repo");
  runner.listAgents();
  runner.removeAgent("agent-1");
  runner.removeWorktree("w1");
  runner.closeTab("tab-1");
  return commands;
}

type WorktreeRequest = { mode: "create"; branch: string; baseBranch: string } | { mode: "open"; branch: string };

function captureLaunch(worktree: WorktreeRequest, name: string, promptFilePrefix: string): unknown {
  const calls: string[] = [];
  const writes: Record<string, string> = {};
  const unexpected = (operation: string) => () => {
    throw new Error(`unexpected ${operation}`);
  };

  const result = launchAgentFlow(
    {
      worktree,
      repoPath: "/repo",
      automationDir: "/automation",
      stateDir: "/state/deadloop",
      name,
      agent: "pi",
      model: "",
      level: "medium",
      uuid: "U-baseline",
      promptFilePrefix,
      renderPrompt: ({ promiseFile }: { promiseFile: string }) => `promise: ${promiseFile}`,
    },
    {
      mkdirSync: () => {},
      runner: {
        createWorktree: () => {
          calls.push("createWorktree");
          return { workspaceId: "w1", worktreePath: "/wt" };
        },
        openWorktree: () => {
          calls.push("openWorktree");
          return { workspaceId: "w1", worktreePath: "/wt" };
        },
        createTab: () => {
          calls.push("createTab");
          return { tabId: "tab-1" };
        },
        startAgent: unexpected("startAgent"),
        listWorktrees: () => [],
        listAgents: () => [],
        removeAgent: () => "",
        removeWorktree: () => "",
      },
      runText: (args: string[]) => {
        calls.push(args.join(" "));
        return "launch output";
      },
      writeFileSync: (file: string, text: string) => {
        writes[file] = text;
      },
    },
  );

  return { calls, writes, result };
}

function captureAutomationSelection(): unknown {
  const config = JSON.parse(readFileSync("extensions/deadloop/projects.example.json", "utf8"));
  return config.projects.map((project: Record<string, unknown>) => ({
    id: project.id,
    automations: (project.automations as Record<string, unknown>[]).map((automation) => ({
      id: automation.id,
      promptFile: automation.promptFile,
      precheckFile: automation.precheckFile,
      driverFile: automation.driverFile,
    })),
  }));
}

function captureBaseline() {
  return {
    herdrCommands: captureHerdrCommands(),
    launchCommandLog: {
      worker: captureLaunch({ mode: "create", branch: "agent/issue-1", baseBranch: "origin/main" }, "dl-worker", "worker-prompt"),
      reviewer: captureLaunch({ mode: "open", branch: "agent/issue-1" }, "dl-reviewer", "reviewer-prompt"),
    },
    automationSelection: captureAutomationSelection(),
  };
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
const observed = captureBaseline();

describe("Herdr 0.7.3 baseline", () => {
  it("pins the Herdr command argv", () => {
    expect(serialize(observed.herdrCommands)).toBe(serialize(baseline.herdrCommands));
  });

  it("pins the launch command log for every worktree mode", () => {
    expect(serialize(observed.launchCommandLog)).toBe(serialize(baseline.launchCommandLog));
  });

  it("pins the automation selection", () => {
    expect(serialize(observed.automationSelection)).toBe(serialize(baseline.automationSelection));
  });
});
