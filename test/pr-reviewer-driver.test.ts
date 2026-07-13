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

  it("reports the deterministic reviewer promise path", () => {
    expect(runDriverFixture("fallback-review.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).launch.promiseFile).toContain(
      ".deadloop/promise-",
    );
  });

  it("preserves autoMerge=false safety after deterministic reviewer launch", () => {
    expect(runDriverFixture("fallback-review.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).prompt).toContain(
      "If autoMerge=false, never merge",
    );
  });

  it("does not ask the LLM to run launch-agent", () => {
    expect(runDriverFixture("fallback-review.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).prompt).not.toContain("launch-agent.ts");
  });

  it("identifies the dedicated reviewer tab in cleanup instructions", () => {
    expect(runDriverFixture("fallback-review.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).prompt).toContain(
      "herdr tab close fixture-tab",
    );
  });

  it("reports the deterministic reviewer name", () => {
    expect(runDriverFixture("fallback-review.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).launch.reviewerName).toBe("demo-pr-24-reviewer");
  });

  it("replaces one matching done reviewer tab before re-review", () => {
    expect(runDriverFixture("done-reviewer-reclaim.json").launch.replacedReviewerTabId).toBe("w9:t3");
  });

  it("refuses ambiguous replacement when multiple done reviewers have the same name", () => {
    expect(runDriverFixture("ambiguous-done-reviewers.json").action).toBe("error");
  });
});
