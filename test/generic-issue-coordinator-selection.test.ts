import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const decisionScript = "extensions/pi-looper/automations/generic-issue-coordinator-decisions.py";

function runDecisionFixture(fixtureName: string) {
  const result = spawnSync(
    "python3",
    [decisionScript, "--fixture", path.join("test/fixtures/generic-issue-coordinator", fixtureName), "--json"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout);
}

describe("generic issue coordinator selection", () => {
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
});
