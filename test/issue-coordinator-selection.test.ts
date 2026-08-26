import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const { DEPENDENCY_QUERY_TIMEOUT_MS, defaultIssueDecisionConfig, remainingIssueDecisionTimeout, selectIssueForImplementation } = require("../extensions/deadloop/automations/issue-coordinator-decisions.cts");
const decisionScript = "extensions/deadloop/automations/issue-coordinator-decisions.cts";

function runDecision(args: string[]) {
  return spawnSync("node", [decisionScript, ...args], { cwd: process.cwd(), encoding: "utf8" });
}

describe("issue coordinator selection", () => {
  it("prefers exploration when one Issue requests both roles", () => {
    const decision = selectIssueForImplementation(
      [{ number: 1, body: "", labels: [{ name: "agent:explore" }, { name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => "CLOSED",
    );

    expect(decision.role).toBe("explorer");
  });

  it("selects implementation when exploration is not requested", () => {
    const decision = selectIssueForImplementation(
      [{ number: 1, body: "", labels: [{ name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => "CLOSED",
    );

    expect(decision.role).toBe("worker");
  });

  it("does not select an Issue whose same-repository dependency is open", () => {
    const decision = selectIssueForImplementation(
      [{ number: 2, body: "## Blocked by\n- Depends on #1", labels: [{ name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      (number) => (number === 1 ? "OPEN" : null),
    );

    expect(decision.selected).toBe(false);
  });

  it("selects an Issue whose same-repository dependency is closed", () => {
    const decision = selectIssueForImplementation(
      [{ number: 2, body: "## Blocked by\n- Depends on #1", labels: [{ name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      (number) => (number === 1 ? "CLOSED" : null),
    );

    expect(decision.selected).toBe(true);
  });

  it("ignores a linked dependency reference that names another repository", () => {
    const decision = selectIssueForImplementation(
      [{
        number: 2,
        body: "## Blocked by\n- [other repo](https://github.com/qorraq/qorraq-prototype/issues/348)",
        labels: [{ name: "agent:implement" }],
      }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => null,
      "owner/repo",
    );

    expect(decision.selected).toBe(true);
  });

  it("ignores a shorthand dependency reference that names another repository", () => {
    const decision = selectIssueForImplementation(
      [{ number: 2, body: "## Blocked by\n- qorraq/qorraq-prototype#348", labels: [{ name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => null,
      "owner/repo",
    );

    expect(decision.selected).toBe(true);
  });

  it("counts a linked reference naming the target repository as a local dependency", () => {
    const decision = selectIssueForImplementation(
      [{
        number: 2,
        body: "## Blocked by\n- [sibling](https://github.com/owner/repo/issues/9)",
        labels: [{ name: "agent:implement" }],
      }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      (number) => (number === 9 ? "OPEN" : null),
      "owner/repo",
    );

    expect(decision.selected).toBe(false);
  });

  it("keeps fail-closed behavior when a dependency number does not exist", () => {
    const decision = selectIssueForImplementation(
      [{ number: 2, body: "## Blocked by\n- Depends on #404", labels: [{ name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => null,
    );

    expect(decision.selected).toBe(false);
  });

  it("marks a nonexistent dependency number as UNKNOWN in the skip record", () => {
    const decision = selectIssueForImplementation(
      [{ number: 2, body: "## Blocked by\n- Depends on #404", labels: [{ name: "agent:implement" }] }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => null,
    );

    expect(decision.skipped.find((entry) => entry.reason === "open_dependency").dependencies[0].state).toBe("UNKNOWN");
  });

  it("lists external references separately in the skip record", () => {
    const decision = selectIssueForImplementation(
      [{
        number: 2,
        body: "## Blocked by\n- Depends on #1\n- [other repo](https://github.com/qorraq/qorraq-prototype/issues/348)",
        labels: [{ name: "agent:implement" }],
      }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      (number) => (number === 1 ? "OPEN" : null),
      "owner/repo",
    );

    expect(decision.skipped.find((entry) => entry.reason === "open_dependency").externalDependencies).toEqual(["qorraq/qorraq-prototype#348"]);
  });

  it("shows CLI help without requiring a repo", () => {
    expect(runDecision(["--help"]).status).toBe(0);
  });

  it("rejects unknown CLI flags", () => {
    expect(runDecision(["--typo"]).status).toBe(2);
  });

  it("caps each dependency query below the overall revalidation deadline", () => {
    expect(remainingIssueDecisionTimeout(12_000, 10_000)).toBe(2_000);
  });

  it("gives ordinary dependency queries a strict timeout", () => {
    expect(remainingIssueDecisionTimeout(undefined, 10_000)).toBe(DEPENDENCY_QUERY_TIMEOUT_MS);
  });

  it("stops dependency queries once the overall deadline expires", () => {
    expect(() => remainingIssueDecisionTimeout(10_000, 10_000)).toThrow("deadline exceeded");
  });
});
