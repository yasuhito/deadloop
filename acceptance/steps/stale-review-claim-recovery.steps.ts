import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

const { defaultDecisionConfig, selectPrForReview, workingReviewerPrNumbers } = require("../../extensions/deadloop/automations/pr-reviewer-decisions.ts");

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
  decision?: { selected?: boolean; number?: number; staleReclaim?: boolean; reason?: string };
  reviewerLaunchCounts?: number[];
};

const fixtureDirectory = path.join(process.cwd(), "test/fixtures/pr-reviewer");
const fixedNow = new Date("2026-07-04T00:30:00Z");

function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, name), "utf8"));
}

function setClaim(world: ClaimWorld, prFixture: string, agentsFixture: string): void {
  world.prs = fixture(prFixture) as Record<string, unknown>[];
  world.agents = fixture(agentsFixture);
}

Given("実働担当がいない古いレビュー占有がある", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-empty.json");
});

Given("レビュー担当が稼働中のレビュー占有がある", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-reviewer-working.json");
});

Given("ブランチ更新担当の完了を待つ猶予中のレビュー占有がある", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-branch-update-working.json");
});

Given("終了済みのレビュー担当だけが残るレビュー占有がある", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-reviewer-idle.json");
});

Given("意図的に停止されたレビュー占有がある", function (this: ClaimWorld) {
  setClaim(this, "precheck-blocked.json", "agents-empty.json");
});

Given("まだ占有されていないレビュー待ちの pull request がある", function (this: ClaimWorld) {
  setClaim(this, "precheck-agent-review.json", "agents-empty.json");
});

function runDriver(fixtureData: Record<string, unknown>): DriverResult {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-stale-claim-"));
  const fixturePath = path.join(tempRoot, "review-cycle.json");
  try {
    fs.writeFileSync(fixturePath, JSON.stringify(fixtureData));
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
        DEADLOOP_NOW: fixedNow.toISOString(),
      },
    });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return JSON.parse(result.stdout) as DriverResult;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

When("deadloop が占有を回収して次の選定周期まで処理する", function (this: ClaimWorld) {
  if (!this.prs) throw new Error("review claim is missing");
  const firstCycle = runDriver({ prs: this.prs, agents: this.agents });
  const firstStarts = firstCycle.testAdapterEffects?.herdrStarts ?? [];
  const labels = firstCycle.testAdapterEffects?.labels?.["13"];
  const claimedPrs = this.prs.map((pr) =>
    Number(pr.number) === 13 && labels ? { ...pr, labels: labels.map((name) => ({ name })) } : pr,
  );
  const activeAgents = {
    result: {
      agents: firstStarts.flatMap((start) =>
        start.name ? [{ name: start.name, agent_status: "working" }] : [],
      ),
    },
  };
  const nextCycle = runDriver({ prs: claimedPrs, agents: activeAgents });
  this.reviewerLaunchCounts = [firstStarts.length, nextCycle.testAdapterEffects?.herdrStarts?.length ?? 0];
});

function decide(world: ClaimWorld): void {
  if (!world.prs) throw new Error("review claim is missing");
  const config = defaultDecisionConfig({ now: fixedNow, projectId: "demo" });
  world.decision = selectPrForReview(world.prs, config, workingReviewerPrNumbers(world.agents, config.projectId));
}

When("deadloop が古いレビュー占有の回収対象を探す", function (this: ClaimWorld) {
  decide(this);
});

Then("pull request #{int} のレビューを再開する", function (this: ClaimWorld, number: number) {
  assert.equal(this.decision?.number, number);
});

Then("選んだレビューは中断後の再開として扱われる", function (this: ClaimWorld) {
  assert.equal(this.decision?.staleReclaim, true);
});

Then("レビュー占有は回収されない", function (this: ClaimWorld) {
  assert.equal(this.decision?.selected, false);
});

Then("新しいレビュー担当は一人だけ起動される", function (this: ClaimWorld) {
  assert.deepEqual(this.reviewerLaunchCounts, [1, 0]);
});

Then("選んだレビューは通常の開始として扱われる", function (this: ClaimWorld) {
  assert.equal(this.decision?.staleReclaim, false);
});
