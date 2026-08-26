import { describe, expect, it } from "vitest";

const { agentWorkflowLabels, humanHandoffComplete, humanHandoffLabelMove } = require("../src/human-handoff.cts");

const labels = {
  reviewLabel: "agent:review",
  implementLabel: "agent:implement",
  updateBranchLabel: "agent:update-branch",
  inProgressLabel: "agent:in-progress",
  blockedLabel: "agent:blocked",
};

describe("human handoff definition", () => {
  it("keeps every agent workflow label in the handoff set", () => {
    expect(agentWorkflowLabels(labels)).toEqual([
      "agent:review", "agent:implement", "agent:update-branch", "agent:in-progress", "agent:blocked",
    ]);
  });

  it("completes a handoff that is ready with no agent workflow label left", () => {
    expect(humanHandoffComplete({ isDraft: false, labels: ["team:platform"] }, labels)).toBe(true);
  });

  it("does not complete a handoff while an agent workflow label remains", () => {
    expect(humanHandoffComplete({ isDraft: false, labels: ["agent:blocked"] }, labels)).toBe(false);
  });

  it("does not complete a handoff while the pull request is still a draft", () => {
    expect(humanHandoffComplete({ isDraft: true, labels: [] }, labels)).toBe(false);
  });
});

describe("human handoff label move", () => {
  it("removes every agent workflow label and adds none", () => {
    expect(humanHandoffLabelMove(labels)).toEqual({
      remove: ["agent:review", "agent:implement", "agent:update-branch", "agent:in-progress", "agent:blocked"],
      add: [],
    });
  });
});
