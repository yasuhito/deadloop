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
  decision?: { selected?: boolean; number?: number; reason?: string };
  firstCycleStartCount?: number;
  driverResult?: DriverResult;
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

Given("回収済みで新しいレビュー担当が稼働中の占有がある", function (this: ClaimWorld) {
  setClaim(this, "precheck-reviewing.json", "agents-empty.json");
  const firstCycle = runDriver({ prs: this.prs, agents: this.agents });
  const starts = firstCycle.testAdapterEffects?.herdrStarts ?? [];
  this.firstCycleStartCount = starts.length;
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

When("deadloop が次の選定周期を実行する", function (this: ClaimWorld) {
  if (!this.prs) throw new Error("review claim is missing");
  this.driverResult = runDriver({ prs: this.prs, agents: this.agents });
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

Then("レビュー占有は回収されない", function (this: ClaimWorld) {
  assert.equal(this.decision?.selected, false);
});

Then("二周期を通じてレビュー担当は一件だけ起動される", function (this: ClaimWorld) {
  const nextCycleStartCount = this.driverResult?.testAdapterEffects?.herdrStarts?.length ?? 0;
  assert.deepEqual([this.firstCycleStartCount ?? 0, nextCycleStartCount], [1, 0]);
});
