import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const { DEPENDENCY_QUERY_TIMEOUT_MS, remainingIssueDecisionTimeout } = require("../extensions/deadloop/automations/issue-coordinator-decisions.ts");
const decisionScript = "extensions/deadloop/automations/issue-coordinator-decisions.ts";

function runDecision(args: string[]) {
  return spawnSync("node", [decisionScript, ...args], { cwd: process.cwd(), encoding: "utf8" });
}

function runDecisionFixture(fixtureName: string) {
  const result = spawnSync(
    "node",
    [decisionScript, "--fixture", path.join("test/fixtures/issue-coordinator", fixtureName), "--json"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout);
}

describe("issue coordinator selection", () => {
  it("selects an issue labeled ready-for-agent and agent:implement", () => {
    expect(runDecisionFixture("selection-ready-implement.json").number).toBe(1);
  });

  it("skips issues with the in-progress label", () => {
    expect(runDecisionFixture("selection-in-progress.json").selected).toBe(false);
  });

  it("skips issues with an open dependency from the body", () => {
    expect(runDecisionFixture("selection-open-body-dependency.json").selected).toBe(false);
  });

  it("selects issues once the body dependency is closed", () => {
    expect(runDecisionFixture("selection-closed-body-dependency.json").number).toBe(2);
  });

  it("skips issues with an open GitHub relationship dependency", () => {
    expect(runDecisionFixture("selection-open-relationship-dependency.json").selected).toBe(false);
  });

  it("skips issues with an open final dependency section", () => {
    expect(runDecisionFixture("selection-open-final-section-dependency.json").selected).toBe(false);
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
