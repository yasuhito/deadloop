import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const { DEPENDENCY_QUERY_TIMEOUT_MS, defaultIssueDecisionConfig, remainingIssueDecisionTimeout, selectIssueForImplementation } = require("../extensions/deadloop/automations/issue-coordinator-decisions.ts");
const decisionScript = "extensions/deadloop/automations/issue-coordinator-decisions.ts";

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

  it("selects a recovery request ordered after an Issue block", () => {
    const decision = selectIssueForImplementation(
      [{
        number: 1,
        body: "",
        labels: [{ name: "agent:explore" }, { name: "agent:blocked" }],
        timelineEvents: [
          { id: "10", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:blocked" } },
          { id: "11", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:explore" } },
        ],
      }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => "CLOSED",
    );

    expect(decision.number).toBe(1);
  });

  it("rejects a blocked request ordered before the Issue block", () => {
    const decision = selectIssueForImplementation(
      [{
        number: 1,
        body: "",
        labels: [{ name: "agent:explore" }, { name: "agent:blocked" }],
        timelineEvents: [
          { id: "10", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:explore" } },
          { id: "11", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:blocked" } },
        ],
      }],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => "CLOSED",
    );

    expect(decision.selected).toBe(false);
  });

  it("skips an invalid blocked candidate before selecting another Issue", () => {
    const decision = selectIssueForImplementation(
      [
        {
          number: 1,
          body: "",
          labels: [{ name: "agent:explore" }, { name: "agent:blocked" }],
          timelineEvents: [
            { id: "10", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:explore" } },
            { id: "11", event: "labeled", created_at: "2026-08-16T00:00:00Z", label: { name: "agent:blocked" } },
          ],
        },
        { number: 2, body: "", labels: [{ name: "agent:explore" }] },
      ],
      defaultIssueDecisionConfig(),
      () => new Set(),
      () => "CLOSED",
    );

    expect(decision.number).toBe(2);
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
