import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const driverScript = "extensions/pi-looper/automations/issue-coordinator-driver.py";

function runDriverFixture(fixtureName: string) {
  const result = spawnSync("python3", [driverScript, "--fixture", path.join("test/fixtures/issue-coordinator", fixtureName)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      PI_LOOPER_PROJECT_ID: "demo",
      PI_LOOPER_REPO_PATH: "/repo path",
      PI_LOOPER_GITHUB_REPO: "owner/repo",
      PI_LOOPER_CHECK_COMMAND: "npm test",
      PI_LOOPER_WORKER_AGENT: "pi",
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
    expect(runDriverFixture("driver-blocked-prd.json").comment).toContain("## 復旧手順");
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

  it("receives worker agent settings from the extension environment", () => {
    expect(readFileSync("extensions/pi-looper/index.ts", "utf8")).toContain("PI_LOOPER_WORKER_AGENT");
  });

  it("receives worker model settings from the extension environment", () => {
    expect(readFileSync("extensions/pi-looper/index.ts", "utf8")).toContain("PI_LOOPER_WORKER_MODEL");
  });
});
