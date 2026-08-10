import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

type DriverStart = { name?: string };
type DriverResult = {
  testAdapterEffects?: {
    herdrStarts?: DriverStart[];
    labels?: Record<string, string[]>;
  };
};

type ClaimWorld = {
  prs?: Record<string, unknown>[];
  agents?: unknown;
  attempts?: Record<string, unknown>[];
  driverResult?: DriverResult;
};

const fixtureDirectory = path.join(process.cwd(), "test/fixtures/pr-reviewer");
const fixedNow = new Date("2026-07-04T00:30:00Z");

function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), "utf8"));
}

function ownershipAttempt(role: string, agentName: string): Record<string, unknown> {
  return {
    attemptId: `${role}-13`, launchUuid: `${role}-launch-13`, project: "demo", repository: "owner/repo", role,
    target: { kind: "pull-request", number: 13 }, inputRevision: { head: "a".repeat(40) }, branch: "agent/issue-13",
    worktreePath: "/worktrees/issue-13", agentName, workspaceLabel: `${role}-13`, promptFile: "/runs/prompt.md",
    promiseFile: "/runs/promise.json", phase: "agent_started", lastSuccessfulPhase: "agent_started",
    workspaceId: `${role}-workspace`, tabId: `${role}-tab`, rootPaneId: `${role}-pane`,
  };
}

function setClaim(world: ClaimWorld, prFixture: string, agentsFixture: string): void {
  world.prs = fixture(prFixture) as Record<string, unknown>[];
  const source = fixture(agentsFixture) as { result?: { agents?: Record<string, unknown>[] } };
  const role = agentsFixture.includes("branch-update") ? "branch-update" : "reviewer";
  const prefix = role === "branch-update" ? "dl-u" : "dl-r";
  const agents = (source.result?.agents || []).map((agent) => ({ ...agent, name: `${prefix}-13-111111111111` }));
  world.agents = { result: { agents } };
  world.attempts = agents.map((agent) => ownershipAttempt(role, String(agent.name)));
}

Given("A stale review claim has no active agent", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-empty.json");
});

Given("A review claim has an active Reviewer", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-reviewer-working.json");
});

Given("A review claim is in the grace period while a branch-update agent completes", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-branch-update-working.json");
});

Given("A review claim has only a completed Reviewer and its attempt record remains", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-reviewer-idle.json");
});

Given("A review claim is intentionally blocked", function (this: ClaimWorld) {
  setClaim(this, "precheck-blocked.json", "agents-empty.json");
});

Given("A reclaimed claim now has an active Reviewer", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-empty.json");
  const firstCycle = runDriver({ prs: this.prs, agents: this.agents });
  const starts = firstCycle.testAdapterEffects?.herdrStarts ?? [];
  const labels = firstCycle.testAdapterEffects?.labels?.["13"];
  this.prs = this.prs?.map((pr) =>
    Number(pr.number) === 13 && labels ? { ...pr, labels: labels.map((name) => ({ name })) } : pr,
  );
  this.agents = {
    result: {
      agents: starts.flatMap((start) =>
        start.name ? [{ name: start.name, agent_status: "working" }] : [],
      ),
    },
  };
  this.attempts = starts.flatMap((start) => start.name ? [ownershipAttempt("reviewer", start.name)] : []);
});

function runDriver(fixtureData: Record<string, unknown>): DriverResult {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-stale-claim-"));
  const fixturePath = path.join(tempRoot, "review-cycle.json");
  try {
    fs.writeFileSync(fixturePath, JSON.stringify(fixtureData));
    const stateDir = path.join(tempRoot, "state");
    for (const [index, attempt] of ((fixtureData.attempts as Record<string, unknown>[]) || []).entries()) {
      const runDir = path.join(stateDir, "runs", String(index));
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify(attempt));
    }
    const result = spawnSync("node", ["extensions/deadloop/automations/pr-reviewer-driver.ts", "--fixture", fixturePath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DEADLOOP_PROJECT_ID: "demo",
        DEADLOOP_REPO_PATH: "/repo",
        DEADLOOP_GITHUB_REPO: "owner/repo",
        DEADLOOP_REVIEWER_AGENT: "pi",
        DEADLOOP_AUTO_MERGE: "0",
        DEADLOOP_AUTHORIZED_AUTOMATION_LOGINS: "deadloop-bot",
        DEADLOOP_NOW: fixedNow.toISOString(),
        DEADLOOP_STATE_DIR: stateDir,
      },
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout) as DriverResult;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

When("deadloop runs the next selection cycle", function (this: ClaimWorld) {
  runCycle(this);
});

When("deadloop searches for stale review claims to reclaim", function (this: ClaimWorld) {
  runCycle(this);
});

Then("Review of pull request #{int} resumes", function (this: ClaimWorld, number: number) {
  assert.equal(countReviewerStarts(this, [number]), 1);
});

Then("The review claim is not reclaimed", function (this: ClaimWorld) {
  assert.equal(countReviewerStarts(this), 0);
});

Then("The next selection cycle does not start another Reviewer", function (this: ClaimWorld) {
  assert.equal(countReviewerStarts(this), 0);
});

function runCycle(world: ClaimWorld): void {
  if (!world.prs) throw new Error("review claim is missing");
  world.driverResult = runDriver({ prs: world.prs, agents: world.agents, attempts: world.attempts });
}

function countReviewerStarts(
  world: ClaimWorld,
  pullRequestNumbers = world.prs?.map((pr) => Number(pr.number)) ?? [],
): number {
  return (
    world.driverResult?.testAdapterEffects?.herdrStarts?.filter((start) =>
      pullRequestNumbers.some((number) => start.name === `demo-pr-${number}-reviewer`
        || new RegExp(`^dl-r-${number}-[0-9a-f]{12}$`).test(start.name ?? "")),
    ).length ?? 0
  );
}
