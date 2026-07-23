import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const decisionScript = "extensions/deadloop/automations/pr-branch-update-decision.ts";

function runDecisionFixture(fixtureName: string) {
  const result = spawnSync(
    "node",
    [decisionScript, "--fixture", path.join("test/fixtures/pr-branch-update", fixtureName)],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout);
}

describe("PR branch update decision", () => {
  it("does not update a head that already contains the base", () => {
    expect(runDecisionFixture("no-update.json").action).toBe("no_update");
  });

  it("updates mechanically when the head can fast-forward to the base", () => {
    expect(runDecisionFixture("fast-forward.json").action).toBe("mechanical_update");
  });

  it("updates mechanically when a diverged head merges cleanly", () => {
    expect(runDecisionFixture("clean-merge.json").action).toBe("mechanical_update");
  });

  it("delegates one worker when the branch update conflicts", () => {
    expect(runDecisionFixture("conflict.json").action).toBe("delegate_worker");
  });

  it("blocks mechanical updates from a dirty worktree", () => {
    expect(runDecisionFixture("dirty-worktree.json").reason).toBe("dirty_worktree");
  });

  it("blocks mechanical updates from a stale head", () => {
    expect(runDecisionFixture("stale-head.json").reason).toBe("stale_head");
  });
});
