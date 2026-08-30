import { describe, expect, it } from "vitest";

const { failedExplorationBody, issueStopMarkerReason } = require("../src/issue-request-transition.cts");

function stopInput(reason: string) {
  return {
    github: {},
    repository: "owner/repository",
    issueNumber: 12,
    requestLabel: "agent:implement",
    requestLabels: ["agent:implement"],
    requestEventId: "evt-1",
    inProgressLabel: "agent:in-progress",
    blockedLabel: "agent:blocked",
    automationLogin: "bot",
    automationLogins: ["bot"],
    attemptId: "attempt-1",
    persistGithub: () => undefined,
    failure: { reason, explanation: "the worker could not continue", recovery: "add a new request" },
    stopNoun: "implementation",
  };
}

describe("issue stop marker reason", () => {
  it("publishes a stop code unchanged", () => {
    expect(issueStopMarkerReason("fix_environment")).toBe("fix_environment");
  });

  it("folds an agent-written reason outside the stop codes into add_request", () => {
    expect(issueStopMarkerReason("worker_blocked")).toBe("add_request");
  });

  it("folds deadloop's own invalid_exploration_report into add_request", () => {
    expect(issueStopMarkerReason("invalid_exploration_report")).toBe("add_request");
  });

  it("writes only the folded code into the issue-attempt-stop marker", () => {
    expect(failedExplorationBody(stopInput("some_legacy_reason"))).toMatch(/<!-- deadloop:issue-attempt-stop:v1 [^>]*reason=add_request -->/);
  });

  it("keeps the cause in the comment prose", () => {
    expect(failedExplorationBody(stopInput("some_legacy_reason"))).toContain("the worker could not continue");
  });
});
