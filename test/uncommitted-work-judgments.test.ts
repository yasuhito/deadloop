import { describe, expect, it } from "vitest";

import {
  checkUncommittedWorkJudgments,
  loadUncommittedWorkJudgmentSources,
  type SourceFile,
} from "../src/check-uncommitted-work-judgments";

function sources(source: string, filePath = "src/example.ts"): SourceFile[] {
  return [{ path: filePath, source }];
}

describe("uncommitted work judgments in shipped code", () => {
  it("reports a git status invocation written out instead of shared", () => {
    const source = `const dirty = checked(ops, ["git", "-C", repo, "status", "--porcelain"]);`;
    expect(checkUncommittedWorkJudgments(sources(source))).toContain(
      "src/example.ts:1: a git status judgment must use UNCOMMITTED_WORK_STATUS_ARGS and hasUncommittedWork from src/agent-scratch-area.cjs",
    );
  });

  it("accepts a judgment that spreads the shared argument list", () => {
    const source = `const dirty = hasUncommittedWork(runText(["git", "-C", repo, ...UNCOMMITTED_WORK_STATUS_ARGS]));`;
    expect(checkUncommittedWorkJudgments(sources(source))).toEqual([]);
  });

  it("accepts a status subcommand that carries no output option", () => {
    const source = `const server = ops.probe("herdr", ["status", "server"]);`;
    expect(checkUncommittedWorkJudgments(sources(source))).toEqual([]);
  });

  it("accepts the file that defines the shared argument list", () => {
    const source = `const UNCOMMITTED_WORK_STATUS_ARGS = ["status", "--porcelain", "--untracked-files=all"];`;
    expect(checkUncommittedWorkJudgments(sources(source, "src/agent-scratch-area.cjs"))).toEqual([]);
  });

  it("accepts the pristine proof that counts ignored files too", () => {
    const source = `const status = git(worktree, ["status", "--porcelain", "--untracked-files=all", "--ignored"]);`;
    expect(checkUncommittedWorkJudgments(sources(source, "src/enablement-verification.ts"))).toEqual([]);
  });
});

describe("uncommitted work judgments in agent prompts", () => {
  it("reports a prompt that asks the agent for a clean worktree", () => {
    const source = "function repairWorkerPrompt() {\n  return `Repair the findings.\n- First require a clean worktree.`;\n}";
    expect(checkUncommittedWorkJudgments(sources(source))).toContain(
      'src/example.ts:3: a prompt must not ask an agent to judge uncommitted work ("clean worktree")',
    );
  });

  it("reports a prompt that directs the agent to read git status", () => {
    const source = "const renderPrompt = () => `Start by reading git status.`;";
    expect(checkUncommittedWorkJudgments(sources(source))).toContain(
      'src/example.ts:1: a prompt must not ask an agent to judge uncommitted work ("git status")',
    );
  });

  it("reports a prompt phrase that reaches the agent through a template substitution", () => {
    const source = "function workerPrompt(head) {\n  return `Target ${head}.\n- Require a clean worktree first.`;\n}";
    expect(checkUncommittedWorkJudgments(sources(source))).toContain(
      'src/example.ts:3: a prompt must not ask an agent to judge uncommitted work ("clean worktree")',
    );
  });

  it("accepts the same wording outside a prompt", () => {
    const source = `throw new Error("repair worktree is dirty before checks");`;
    expect(checkUncommittedWorkJudgments(sources(source))).toEqual([]);
  });
});

describe("uncommitted work judgments in this repository", () => {
  it("leaves no judgment outside the shared implementation", () => {
    expect(checkUncommittedWorkJudgments(loadUncommittedWorkJudgmentSources())).toEqual([]);
  });

  it("scans the CommonJS automation drivers that implement the gate", () => {
    expect(loadUncommittedWorkJudgmentSources().map((source) => source.path))
      .toContain("extensions/deadloop/automations/pr-review-comments.cts");
  });
});
