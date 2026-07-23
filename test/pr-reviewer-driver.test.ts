import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const driverScript = "extensions/deadloop/automations/pr-reviewer-driver.ts";

function runDriverFixture(fixtureName: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("node", [driverScript, "--fixture", path.join("test/fixtures/pr-reviewer-driver", fixtureName)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEADLOOP_PROJECT_ID: "demo",
      DEADLOOP_REPO_PATH: "/repo",
      DEADLOOP_GITHUB_REPO: "owner/repo",
      DEADLOOP_REVIEWER_AGENT: "pi",
      DEADLOOP_REVIEWER_MODEL: "",
      DEADLOOP_AUTO_MERGE: "0",
      DEADLOOP_NOW: "2026-07-08T00:00:00Z",
      ...extraEnv,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout);
}

describe("PR reviewer deterministic driver", () => {
  it("skips candidate-free runs", () => {
    expect(runDriverFixture("no-candidate.json").action).toBe("skip");
  });

  it("skips pending CI without sending a review prompt", () => {
    expect(runDriverFixture("pending-ci.json").driverAction).toBe("wait");
  });

  it("launches reviewer by default without external review", () => {
    expect(runDriverFixture("external-review-request.json").driverAction).toBe("reviewer_monitor_request");
  });

  it("persists reviewer monitor input as a generation-bound handoff", () => {
    expect(runDriverFixture("external-review-request.json").monitorHandoff.kind).toBe("reviewer");
  });

  it("waits for fresh external review when external review is enabled", () => {
    expect(runDriverFixture("external-review-wait.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).driverAction).toBe("wait");
  });

  it("requests external review deterministically when external review is enabled", () => {
    expect(runDriverFixture("external-review-request.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).driverAction).toBe("external_review_requested");
  });

  it("renders a blocked comment for draft PRs", () => {
    expect(runDriverFixture("draft-pr.json").comment).toContain("## Recovery steps");
  });

  it("launches stale external-review fallback deterministically before monitoring", () => {
    expect(runDriverFixture("fallback-review.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).driverAction).toBe("reviewer_monitor_request");
  });

  it("reports the deterministic reviewer promise path outside the worktree", () => {
    expect(
      runDriverFixture("fallback-review.json", {
        DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1",
        DEADLOOP_STATE_DIR: "/state/deadloop",
      }).launch.promiseFile,
    ).toBe("/state/deadloop/runs/fixture-reviewer-uuid/promise.json");
  });

  it("isolates runtime artifacts during reviewer monitor validation", () => {
    expect(
      runDriverFixture("fallback-review.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).prompt,
    ).toContain("run-project-check.ts");
  });

  it("preserves autoMerge=false safety after deterministic reviewer launch", () => {
    expect(runDriverFixture("fallback-review.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).prompt).toContain(
      "If autoMerge=false, never merge",
    );
  });

  it("does not ask the LLM to run launch-agent", () => {
    expect(runDriverFixture("fallback-review.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).prompt).not.toContain("launch-agent.ts");
  });

  it("routes a merge conflict to one dedicated branch-update worker", () => {
    expect(runDriverFixture("merge-conflict.json").driverAction).toBe("branch_update_monitor_request");
  });

  it("persists branch-update monitor input as a generation-bound handoff", () => {
    expect(runDriverFixture("merge-conflict.json").monitorHandoff.kind).toBe("branch-update");
  });

  it("uses a deterministic retry-key worker name for the exact head/base pair", () => {
    expect(runDriverFixture("merge-conflict.json").launch.updaterName).toBe("demo-pr-31-branch-update-63bdfe090637cf9ff5d4");
  });

  it("preserves both review labels during branch update", () => {
    expect(runDriverFixture("merge-conflict.json").labelsPreserved).toEqual(["agent:review", "agent:reviewing"]);
  });

  it("bounds branch update push through the deterministic finalizer", () => {
    expect(runDriverFixture("merge-conflict.json").prompt).toContain("never launch or select an agent, push a branch, review the PR, or merge it");
  });

  it("returns an updated conflict branch to normal review", () => {
    expect(runDriverFixture("merge-conflict-updated.json").driverAction).toBe("reviewer_monitor_request");
  });

  it("blocks a second attempt for the exact same head/base pair", () => {
    expect(runDriverFixture("merge-conflict-double-attempt.json").driverAction).toBe("branch_update_attempt_exhausted");
  });

  it("reports the deterministic reviewer name", () => {
    expect(runDriverFixture("fallback-review.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).launch.reviewerName).toBe("demo-pr-24-reviewer");
  });
});
