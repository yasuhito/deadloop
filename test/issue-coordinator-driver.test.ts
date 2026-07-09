import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const driverScript = "extensions/deadloop/automations/issue-coordinator-driver.ts";

function runDriverFixture(fixtureName: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("node", [driverScript, "--fixture", path.join("test/fixtures/issue-coordinator", fixtureName)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEADLOOP_PROJECT_ID: "demo",
      DEADLOOP_REPO_PATH: "/repo path",
      DEADLOOP_GITHUB_REPO: "owner/repo",
      DEADLOOP_CHECK_COMMAND: "npm test",
      DEADLOOP_WORKER_AGENT: "pi",
      ...extraEnv,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return JSON.parse(result.stdout);
}

describe("issue coordinator deterministic driver", () => {
  it("skips candidate-free runs", () => {
    expect(runDriverFixture("driver-no-candidate.json").action).toBe("skip");
  });

  it("completes cleanup-only runs deterministically", () => {
    expect(runDriverFixture("driver-cleanup-candidate.json").driverAction).toBe("cleanup_applied");
  });

  it("handles contract-missing issues without an LLM prompt", () => {
    expect(runDriverFixture("driver-contract-missing.json").driverAction).toBe("contract_missing");
  });

  it("renders contract-missing guidance", () => {
    expect(runDriverFixture("driver-contract-missing.json").comment).toContain("Acceptance criteria");
  });

  it("renders blocked comments for planning issues", () => {
    expect(runDriverFixture("driver-blocked-prd.json").comment).toContain("## Recovery steps");
  });

  it("does not block implementable issues that only reference a PRD document path", () => {
    expect(runDriverFixture("driver-prd-doc-reference.json").driverAction).toBe("worker_launch_request");
  });

  it("requests a bounded LLM worker-launch prompt for ready issues", () => {
    expect(runDriverFixture("driver-ready-worker.json").driverAction).toBe("worker_launch_request");
  });

  it("keeps worker launch requests on launch-agent", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain("launch-agent.ts");
  });

  it("keeps worker launch requests off the default agent name", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain("demo-issue-12-worker");
  });

  it("keeps promise files as the worker completion authority", () => {
    expect(runDriverFixture("driver-ready-worker.json").prompt).toContain("only completion authority");
  });

  it("can launch workers deterministically before asking for monitoring", () => {
    expect(runDriverFixture("driver-ready-worker.json", { DEADLOOP_SIMULATE_LAUNCH: "1" }).driverAction).toBe(
      "worker_monitor_request",
    );
  });

  it("reports the deterministic worker promise path", () => {
    expect(runDriverFixture("driver-ready-worker.json", { DEADLOOP_SIMULATE_LAUNCH: "1" }).launch.promiseFile).toContain(
      ".deadloop/promise-",
    );
  });

  it("preserves validation before PR creation after deterministic worker launch", () => {
    expect(runDriverFixture("driver-ready-worker.json", { DEADLOOP_SIMULATE_LAUNCH: "1" }).prompt).toContain(
      "Run validation including `npm test` before creating any PR",
    );
  });

  it("receives worker agent settings from the shared automation environment", () => {
    expect(readFileSync("src/core.ts", "utf8")).toContain("DEADLOOP_WORKER_AGENT");
  });

  it("receives worker model settings from the shared automation environment", () => {
    expect(readFileSync("src/core.ts", "utf8")).toContain("DEADLOOP_WORKER_MODEL");
  });

  it("uses the TypeScript renderer for blocked comments", () => {
    expect(readFileSync(driverScript, "utf8")).toContain("renderIssueBlockedComment");
  });
});
