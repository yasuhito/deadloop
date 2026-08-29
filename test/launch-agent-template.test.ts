import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AGENT_KINDS } from "../src/agent-profiles.cjs";

const automationDir = path.join(process.cwd(), "extensions/deadloop/automations");
const driverScript = path.join(automationDir, "issue-coordinator-driver.cts");

function issueCoordinatorWorkerResult(): Record<string, any> {
  const result = spawnSync("node", [driverScript, "--fixture", "test/fixtures/issue-coordinator/driver-ready-worker.json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DEADLOOP_PROJECT_ID: "demo", DEADLOOP_REPO_PATH: "/repo", DEADLOOP_GITHUB_REPO: "owner/repo", DEADLOOP_STATE_DIR: deadloopTestStateDir() },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}


// A raw agent-launch branch is a `herdr agent start ... -- <agent binary>` command that names the
// agent binary directly, which the launcher replaced. The alternation is derived from the profile
// table so a newly profiled kind is guarded without editing this regex.
const rawLaunchBranch = new RegExp(`agent start[^\\n]*--\\s+(${AGENT_KINDS.join("|")})\\b`);


// The dispatch lock writes under the state directory, so a fixture run needs one of its own rather
// than the operator's live deadloop state.
const testStateDirs: string[] = [];

afterEach(() => {
  for (const stateDir of testStateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

function deadloopTestStateDir(): string {
  const stateDir = mkdtempSync(path.join(tmpdir(), "deadloop-fixture-state-"));
  testStateDirs.push(stateDir);
  return stateDir;
}

describe("agent launch template", () => {
  it("launches workers deterministically before issue coordinator monitoring", () => {
    expect(issueCoordinatorWorkerResult().driverAction).toBe("worker_monitor_request");
  });

  it("keeps no raw agent-start launch branch in the issue coordinator", () => {
    const result = issueCoordinatorWorkerResult();

    expect(JSON.stringify(result.monitorHandoff)).not.toMatch(rawLaunchBranch);
  });
});
