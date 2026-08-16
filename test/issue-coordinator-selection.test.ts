import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const { DEPENDENCY_QUERY_TIMEOUT_MS, defaultIssueDecisionConfig, remainingIssueDecisionTimeout, selectIssueForImplementation } = require("../extensions/deadloop/automations/issue-coordinator-decisions.ts");
const { issueRecoverySelectionView } = require("../extensions/deadloop/automations/issue-coordinator-driver.ts");
const decisionScript = "extensions/deadloop/automations/issue-coordinator-decisions.ts";

function runDecision(args: string[]) {
  return spawnSync("node", [decisionScript, ...args], { cwd: process.cwd(), encoding: "utf8" });
}

describe("issue coordinator selection", () => {
  const decide = (issues: Record<string, unknown>[]) => selectIssueForImplementation(
    issues, defaultIssueDecisionConfig(), () => new Set(), () => "CLOSED",
  );

  it("selects implementation without ready-for-agent", () => {
    expect(decide([{ number: 1, labels: [{ name: "agent:implement" }] }]).role).toBe("worker");
  });

  it("selects explore before implementation when both are requested", () => {
    expect(decide([{ number: 1, labels: [{ name: "agent:implement" }, { name: "agent:explore" }] }]).role).toBe("explorer");
  });

  it("selects repository exploration before an earlier implementation request", () => {
    expect(decide([
      { number: 1, labels: [{ name: "agent:implement" }] },
      { number: 2, labels: [{ name: "agent:explore" }] },
    ]).number).toBe(2);
  });

  it("does not make exploration wait for an open implementation dependency", () => {
    const decision = selectIssueForImplementation(
      [{ number: 1, body: "Blocked by #2", labels: [{ name: "agent:explore" }] }],
      defaultIssueDecisionConfig(), () => new Set(), () => "OPEN",
    );
    expect(decision.role).toBe("explorer");
  });

  it("does not let a pre-block request starve a valid Issue", () => {
    const issues = [1, 2].map((number) => ({ number, labels: [{ name: "agent:blocked" }, { name: "agent:implement" }] }));
    const events = new Map([
      [1, [
        { id: "10", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:implement" } },
        { id: "11", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:blocked" } },
      ]],
      [2, [
        { id: "20", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:blocked" } },
        { id: "21", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:implement" } },
      ]],
    ]);
    const view = issueRecoverySelectionView(issues, defaultIssueDecisionConfig(), (number: number) => events.get(number));
    expect(decide(view).number).toBe(2);
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
