import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const { planPrRequestAction } = require("../extensions/deadloop/automations/pr-reviewer-flow.ts");

const fixtureDir = path.join(process.cwd(), "test/fixtures/pr-reviewer-driver");

function fixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8"));
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "demo",
    automationLogin: "deadloop-bot",
    reviewLabel: "agent:review",

    humanLabel: "ready-for-human",
    blockedLabel: "agent:blocked",
    autoMerge: false,
    externalReviewEnabled: false,
    externalReviewWaitSeconds: "1800",
    now: "2026-07-08T00:00:00Z",
    ...overrides,
  };
}

describe("PR reviewer use-case flow", () => {
  it("plans no-candidate when no PR is selectable", () => {
    const data = fixture("no-candidate.json");

    expect(planPrRequestAction(data.prs, data.agents, env()).kind).toBe("skip_no_candidate");
  });

  it("plans waiting when checks are pending", () => {
    const data = fixture("pending-ci.json");

    expect(planPrRequestAction(data.prs, data.agents, env()).kind).toBe("skip_wait");
  });

  it("plans a review for a draft pull request carrying a review request", () => {
    const data = fixture("draft-pr.json");

    expect(planPrRequestAction(data.prs, data.agents, env()).kind).toBe("review_required");
  });

  it("plans reviewer launch by default without external review", () => {
    const data = fixture("external-review-request.json");

    expect(planPrRequestAction(data.prs, data.agents, env()).kind).toBe("review_required");
  });

  it("does not let a retained local journal suppress a GitHub review request", () => {
    const data = fixture("external-review-request.json");

    expect(planPrRequestAction(data.prs, { result: { agents: [{ name: "demo-pr-22-reviewer", status: "working" }] } }, env({ stateDir: path.join(fixtureDir, "state") })).kind).toBe("review_required");
  });

  it("plans external review request when external review is enabled", () => {
    const data = fixture("external-review-request.json");

    expect(planPrRequestAction(data.prs, data.agents, env({ externalReviewEnabled: true })).kind).toBe("external_review_request");
  });

  it("plans reviewer launch after stale external review", () => {
    const data = fixture("fallback-review.json");

    expect(planPrRequestAction(data.prs, data.agents, env({ externalReviewEnabled: true })).kind).toBe("review_required");
  });

  it("preserves the repair rereview reason through external review fallback", () => {
    const data = fixture("repair-rereview-fallback.json");

    expect(planPrRequestAction(data.prs, data.agents, env({ externalReviewEnabled: true })).reason).toBe("repair_rereview");
  });

  it("preserves the stale claim reason through external review fallback", () => {
    const data = fixture("stale-claim-fallback.json");

    expect(planPrRequestAction(data.prs, data.agents, env({ externalReviewEnabled: true })).reason).toBe("stale_reclaim");
  });
});
