import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const decisionScript = "extensions/deadloop/automations/issue-coordinator-decisions.ts";

function runDecision(args: string[]) {
  return spawnSync("node", [decisionScript, ...args], { cwd: process.cwd(), encoding: "utf8" });
}

describe("issue coordinator selection", () => {
  it("shows CLI help without requiring a repo", () => {
    expect(runDecision(["--help"]).status).toBe(0);
  });

  it("rejects unknown CLI flags", () => {
    expect(runDecision(["--typo"]).status).toBe(2);
  });
});
