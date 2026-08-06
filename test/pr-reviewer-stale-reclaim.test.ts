import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const script = "extensions/deadloop/automations/pr-reviewer-decisions.ts";

function runSelect(
  prsFixture: string,
  options: { agents?: string; projectId?: string; now?: string } = {},
): { selected: boolean; staleReclaim?: boolean; reason?: string } {
  const args = [
    script,
    "--mode",
    "select",
    "--input",
    path.join("test/fixtures/pr-reviewer", prsFixture),
    "--project-id",
    options.projectId ?? "demo",
    "--automation-login",
    "deadloop-bot",
    "--now",
    options.now ?? "2026-07-04T00:30:00Z",
  ];
  if (options.agents) {
    args.push("--agents", path.join("test/fixtures/pr-reviewer", options.agents));
  }
  const result = spawnSync("node", args, { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

describe("PR reviewer stale reviewing reclaim", () => {
  it("reclaims a reviewing PR when no reviewer agent is running", () => {
    expect(runSelect("precheck-reviewing.json", { agents: "agents-empty.json" }).selected).toBe(true);
  });

  it("marks the reclaimed reviewing PR as a stale reclaim", () => {
    expect(runSelect("precheck-reviewing.json", { agents: "agents-empty.json" }).staleReclaim).toBe(true);
  });

  it("identifies a repaired head as a repair re-review", () => {
    expect(runSelect("precheck-repair-rereview.json", { agents: "agents-empty.json" }).reason).toBe("repair_rereview");
  });

  it("does not classify a repaired head as a stale reclaim", () => {
    expect(runSelect("precheck-repair-rereview.json", { agents: "agents-empty.json" }).staleReclaim).toBe(false);
  });

  it("does not trust a copied repair result marker", () => {
    const { defaultDecisionConfig, selectPrForReview } = require("../extensions/deadloop/automations/pr-reviewer-decisions.ts");
    const prs = structuredClone(require("./fixtures/pr-reviewer/precheck-repair-rereview.json"));
    prs[0].comments[0].author.login = "attacker";
    expect(selectPrForReview(prs, defaultDecisionConfig({ automationLogin: "deadloop-bot" })).reason).toBe("selectable");
  });

  it("reclaims a reviewer claim after preserved repair re-review provenance is consumed", () => {
    const { claimedReviewerHeads, defaultDecisionConfig, selectPrForReview } = require("../extensions/deadloop/automations/pr-reviewer-decisions.ts");
    const prs = require("./fixtures/pr-reviewer-driver/repaired-merge-conflict-updated.json").prs;
    const attempts = [{
      project: "demo", repository: "owner/repo", role: "reviewer",
      target: { kind: "pull-request", number: 31 }, inputRevision: { head: prs[0].headRefOid },
    }];
    expect(selectPrForReview(
      prs,
      defaultDecisionConfig({ automationLogin: "deadloop-bot" }),
      new Set(),
      claimedReviewerHeads("demo", attempts, "owner/repo"),
    ).reason).toBe("stale_reclaim");
  });

  it("does not infer ownership from a legacy reviewer agent name", () => {
    expect(runSelect("precheck-reviewing.json", { agents: "agents-reviewer-working.json" }).selected).toBe(true);
  });

  it("does not infer ownership from a legacy branch-update agent name", () => {
    expect(runSelect("precheck-reviewing.json", { agents: "agents-branch-update-working.json" }).selected).toBe(true);
  });

  it.each([
    ["reviewer", "working", "dl-r-13-111111111111"],
    ["reviewer", "idle", "dl-r-13-111111111111"],
    ["reviewer", "done", "dl-r-13-111111111111"],
    ["review-repair", "working", "dl-x-13-222222222222"],
    ["review-repair", "idle", "dl-x-13-222222222222"],
    ["review-repair", "done", "dl-x-13-222222222222"],
    ["branch-update", "working", "dl-u-13-333333333333"],
    ["branch-update", "idle", "dl-u-13-333333333333"],
    ["branch-update", "done", "dl-u-13-333333333333"],
  ])("suppresses reselection for a retained %s journal when its agent is %s", (role, agentStatus, agentName) => {
    const { defaultDecisionConfig, selectPrForReview, workingReviewerPrNumbers } = require("../extensions/deadloop/automations/pr-reviewer-decisions.ts");
    const attempts = [{
      project: "demo", repository: "owner/repo", role,
      target: { kind: "pull-request", number: 13 }, phase: "agent_started", agentName,
    }];
    const owners = workingReviewerPrNumbers(
      { result: { agents: [{ name: agentName, agent_status: agentStatus }] } }, "demo", attempts, "owner/repo",
    );
    const prs = require("./fixtures/pr-reviewer/precheck-reviewing.json");
    expect(selectPrForReview(prs, defaultDecisionConfig(), owners).selected).toBe(false);
  });

  it("suppresses an ordinary review candidate when an exact retained journal owns it", () => {
    const { defaultDecisionConfig, selectPrForReview, workingReviewerPrNumbers } = require("../extensions/deadloop/automations/pr-reviewer-decisions.ts");
    const owners = workingReviewerPrNumbers({}, "demo", [{
      project: "demo", repository: "owner/repo", role: "review-repair",
      target: { kind: "pull-request", number: 7 }, phase: "report_received", agentName: "dl-x-7-222222222222",
    }], "owner/repo");
    const prs = require("./fixtures/pr-reviewer/precheck-agent-review.json");
    expect(selectPrForReview(prs, defaultDecisionConfig(), owners).selected).toBe(false);
  });

  it("allows reselection only after the project-bound attempt journal reaches workspace_closed", () => {
    const { workingReviewerPrNumbers } = require("../extensions/deadloop/automations/pr-reviewer-decisions.ts");
    expect(workingReviewerPrNumbers({}, "demo", [{
      project: "demo", repository: "owner/repo", role: "reviewer",
      target: { kind: "pull-request", number: 13 }, phase: "workspace_closed", agentName: "dl-r-13-111111111111",
    }], "owner/repo").has(13)).toBe(false);
  });

  it("does not let another project's journal suppress selection", () => {
    const { workingReviewerPrNumbers } = require("../extensions/deadloop/automations/pr-reviewer-decisions.ts");
    expect(workingReviewerPrNumbers({}, "demo", [{
      project: "other", repository: "owner/repo", role: "reviewer",
      target: { kind: "pull-request", number: 13 }, phase: "agent_started", agentName: "dl-r-13-111111111111",
    }], "owner/repo").has(13)).toBe(false);
  });

  it("does not infer retained ownership from an idle agent without a journal", () => {
    expect(runSelect("precheck-reviewing.json", { agents: "agents-reviewer-idle.json" }).selected).toBe(true);
  });

  it("does not infer retained ownership from a done agent without a journal", () => {
    expect(runSelect("precheck-reviewing.json", { agents: "agents-reviewer-done.json" }).selected).toBe(true);
  });

  it("keeps skipping blocked PRs regardless of reviewer agents", () => {
    expect(runSelect("precheck-blocked.json", { agents: "agents-empty.json" }).selected).toBe(false);
  });

  it("does not flag an ordinary review PR as a stale reclaim", () => {
    expect(runSelect("precheck-agent-review.json", { agents: "agents-empty.json" }).staleReclaim).toBe(false);
  });
});
