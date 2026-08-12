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

  it("does not preserve repair re-review provenance from a failed branch-update attempt", () => {
    expect(runSelect("precheck-failed-branch-update-unrelated-head.json", { agents: "agents-empty.json" }).reason).toBe("stale_reclaim");
  });

  it("preserves repair re-review provenance for a successful branch-update output", () => {
    expect(runSelect("precheck-successful-branch-update-output.json", { agents: "agents-empty.json" }).reason).toBe("repair_rereview");
  });

  it("does not preserve repair re-review provenance after another head is pushed", () => {
    expect(runSelect("precheck-head-after-successful-branch-update.json", { agents: "agents-empty.json" }).reason).toBe("stale_reclaim");
  });

  it("does not trust a copied repair result marker", () => {
    const { defaultDecisionConfig, selectPrRequestTarget } = require("../extensions/deadloop/automations/pr-reviewer-decisions.ts");
    const prs = structuredClone(require("./fixtures/pr-reviewer/precheck-repair-rereview.json"));
    prs[0].comments[0].author.login = "attacker";
    expect(selectPrRequestTarget(prs, defaultDecisionConfig({ automationLogin: "deadloop-bot" })).reason).toBe("selectable");
  });

  it("reclaims a reviewer claim after preserved repair re-review provenance is consumed", () => {
    const { claimedReviewerHeads, defaultDecisionConfig, selectPrRequestTarget } = require("../extensions/deadloop/automations/pr-reviewer-decisions.ts");
    const prs = require("./fixtures/pr-reviewer-driver/repaired-merge-conflict-updated.json").prs;
    const attempts = [{
      project: "demo", repository: "owner/repo", role: "reviewer",
      target: { kind: "pull-request", number: 31 }, inputRevision: { head: prs[0].headRefOid },
    }];
    expect(selectPrRequestTarget(
      prs,
      defaultDecisionConfig({ automationLogin: "deadloop-bot" }),
      new Set(),
      claimedReviewerHeads("demo", attempts, "owner/repo"),
    ).reason).toBe("stale_reclaim");
  });

  it("suppresses a queued review while its retained in-progress owner is active", () => {
    const { defaultDecisionConfig, selectPrRequestTarget } = require("../extensions/deadloop/automations/pr-reviewer-decisions.ts");
    const prs = [{
      number: 42,
      headRefOid: "a".repeat(40),
      labels: [{ name: "agent:review" }, { name: "agent:in-progress" }],
    }];
    expect(selectPrRequestTarget(prs, defaultDecisionConfig(), new Set([42])).selected).toBe(false);
  });

  it("does not suppress an ordinary GitHub request from a retained journal alone", () => {
    const { defaultDecisionConfig, selectPrRequestTarget, workingReviewerPrNumbers } = require("../extensions/deadloop/automations/pr-reviewer-decisions.ts");
    const owners = workingReviewerPrNumbers({}, "demo", [{
      project: "demo", repository: "owner/repo", role: "review-repair",
      target: { kind: "pull-request", number: 7 }, phase: "report_received", agentName: "dl-x-7-222222222222",
    }], "owner/repo");
    const prs = require("./fixtures/pr-reviewer/precheck-agent-review.json");
    expect(selectPrRequestTarget(prs, defaultDecisionConfig(), owners).selected).toBe(true);
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
