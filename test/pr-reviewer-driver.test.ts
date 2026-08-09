import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const driverScript = "extensions/deadloop/automations/pr-reviewer-driver.ts";
const { assertTrustedReviewIdentity, blockUnverifiableClaim, claimReviewRequest, resolveAuthorizedAutomationLogins } = require("../extensions/deadloop/automations/pr-reviewer-driver.ts");

function runDriverFixture(fixtureName: string, extraEnv: Record<string, string> = {}) {
  const result = spawnSync("node", [driverScript, "--fixture", path.join("test/fixtures/pr-reviewer-driver", fixtureName)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      DEADLOOP_PROJECT_ID: "demo",
      DEADLOOP_STATE_DIR: path.join(process.cwd(), "test/fixtures/pr-reviewer-driver/state"),
      DEADLOOP_REPO_PATH: "/repo",
      DEADLOOP_GITHUB_REPO: "owner/repo",
      DEADLOOP_REVIEWER_AGENT: "pi",
      DEADLOOP_REVIEWER_MODEL: "",
      DEADLOOP_AUTO_MERGE: "0",
      DEADLOOP_AUTHORIZED_AUTOMATION_LOGINS: "deadloop-bot",
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
  it("authorizes no login when automationLogins is not configured", () => {
    expect(resolveAuthorizedAutomationLogins([])).toEqual([]);
  });

  it("fails closed when automationLogins is not configured", () => {
    expect(runDriverFixture("external-review-request.json", {
      DEADLOOP_AUTHORIZED_AUTOMATION_LOGINS: "",
    }).driverAction).toBe("configuration_error");
  });

  it("rejects an authenticated identity that changed from current enablement", () => {
    const env = { automationLogin: "deadloop-bot", authorizedAutomationLogins: ["deadloop-bot"] };

    expect(() => assertTrustedReviewIdentity("other-bot", env, "deadloop-bot")).toThrow("does not match");
  });

  it("does not replace labels when identity changes after the claim comment", () => {
    const head = "a".repeat(40);
    const pr = { number: 24, state: "OPEN", headRefName: "feature", headRefOid: head, labels: [{ name: "agent:review" }] };
    const request = { id: "22", event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } };
    const comments: Record<string, unknown>[] = [];
    let labelMutations = 0;
    const github = {
      listPrTimelineEvents: () => [request],
      createPrComment: (_repo: string, _number: number, body: string) => {
        const comment = { id: 101, created_at: "2026-07-20T10:01:00Z", updated_at: "2026-07-20T10:01:00Z", user: { login: "deadloop-bot" }, body };
        comments.push(comment);
        return comment;
      },
      getPr: () => pr,
      listPrComments: () => comments,
      readRestResponseHeaders: () => "date: Mon, 20 Jul 2026 10:03:00 GMT",
      replacePrLabels: () => { labelMutations += 1; },
    };
    try {
      claimReviewRequest(github, pr, {
        githubRepositoryId: "R_repo", githubRepo: "owner/repo", claimOwner: "host-a",
        reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", implementLabel: "agent:implement",
        inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked", automationLogin: "deadloop-bot",
        authorizedAutomationLogins: ["deadloop-bot"], reviewerMaxRuntimeSeconds: 3500, claimCleanupGraceSeconds: 100,
      }, () => "other-bot");
    } catch {}

    expect(labelMutations).toBe(0);
  });

  it("does not consume a newer review generation added after the server-time block comment", () => {
    const head = "a".repeat(40);
    const pr = { number: 24, state: "OPEN", headRefName: "feature", headRefOid: head, labels: [{ name: "agent:review" }, { name: "customer:keep" }] };
    let commented = false;
    let labelMutations = 0;
    const github = {
      getPr: () => pr,
      listPrTimelineEvents: () => [{ id: commented ? "new" : "old", event: "labeled", created_at: commented ? "2026-01-01T00:01:00Z" : "2026-01-01T00:00:00Z", label: { name: "agent:review" } }],
      commentPr: () => { commented = true; },
      replacePrLabels: () => { labelMutations += 1; },
    };

    blockUnverifiableClaim(github, pr, {
      githubRepo: "owner/repo", reviewLabel: "agent:review", reviewingLabel: "agent:reviewing",
      implementLabel: "agent:implement", inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    }, "server time unavailable", "old");

    expect(labelMutations).toBe(0);
  });

  it("persists reviewer monitor input as a generation-bound handoff", () => {
    expect(runDriverFixture("external-review-request.json").monitorHandoff.kind).toBe("reviewer");
  });

  it("consumes the review request and enters in-progress in one label replacement", () => {
    expect(runDriverFixture("external-review-request.json").testAdapterEffects.labelReplacements).toHaveLength(1);
  });

  it("preserves labels outside the managed workflow set", () => {
    expect(runDriverFixture("external-review-request.json").launch.claim.labels).toContain("documentation");
  });

  it("removes the one-shot review request when the claim wins", () => {
    expect(runDriverFixture("external-review-request.json").launch.claim.labels).not.toContain("agent:review");
  });

  it("does not write the retired reviewing label", () => {
    expect(runDriverFixture("external-review-request.json").launch.claim.labels).not.toContain("agent:reviewing");
  });

  it("launches no reviewer when another host has the earlier valid claim", () => {
    expect(runDriverFixture("review-claim-loser.json").driverAction).toBe("reviewer_launch_stale");
  });

  it("launches no reviewer after the atomic label result mismatches", () => {
    expect(runDriverFixture("review-claim-post-mismatch.json").driverAction).toBe("reviewer_launch_stale");
  });

  it("reports the deterministic reviewer promise path outside the worktree", () => {
    expect(
      runDriverFixture("fallback-review.json", {
        DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1",
        DEADLOOP_STATE_DIR: "/state/deadloop",
      }).launch.promiseFile,
    ).toBe("/state/deadloop/runs/fixture-reviewer-uuid/promise.json");
  });

  it("isolates runtime artifacts during reviewer monitor validation", () => {
    expect(
      runDriverFixture("fallback-review.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).prompt,
    ).toContain("run-project-check.ts");
  });

  it("passes the raw configured check command to the repair dispatcher", () => {
    expect(
      runDriverFixture("fallback-review.json", {
        DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1",
        DEADLOOP_CHECK_COMMAND: "npm run check -- --repair",
      }).prompt,
    ).toContain("--check-command 'npm run check -- --repair'");
  });

  it("preserves autoMerge=false safety after deterministic reviewer launch", () => {
    expect(runDriverFixture("fallback-review.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).prompt).toContain(
      "If autoMerge=false, never merge",
    );
  });

  it("does not ask the LLM to run launch-agent", () => {
    expect(runDriverFixture("fallback-review.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).prompt).not.toContain("launch-agent.ts");
  });

  it("gives human_required reviewers an exact valid V1 result and evidence shape", () => {
    expect(readFileSync(driverScript, "utf8")).toContain(
      'result={outcome:"human_required",reviewedHead:"${String(pr.headRefOid || "")}",findings:[]}, and evidence={reviewed:["decision boundary and supporting evidence"]}',
    );
  });

  it("fails closed on a merge conflict before branch-update side effects", () => {
    expect(runDriverFixture("merge-conflict.json").driverAction).toBe("branch_update_claim_required");
  });

  it("does not launch a reviewer for a conflicting head", () => {
    expect(runDriverFixture("merge-conflict.json").launch).toBeUndefined();
  });

  it("creates no branch-update workspace before a migrated claim exists", () => {
    expect(runDriverFixture("merge-conflict.json").testAdapterEffects.herdrStarts).toHaveLength(0);
  });

  it("creates no branch-update journal handoff before a migrated claim exists", () => {
    expect(runDriverFixture("merge-conflict.json").monitorHandoff).toBeUndefined();
  });

  it("does not mutate GitHub while branch update lacks a claim protocol", () => {
    expect(runDriverFixture("merge-conflict.json").testAdapterEffects.githubComments).toHaveLength(0);
  });

  it("returns an updated conflict branch to normal review", () => {
    expect(runDriverFixture("merge-conflict-updated.json").driverAction).toBe("reviewer_monitor_request");
  });

  it("does not inspect an old branch-update attempt before claim migration", () => {
    expect(runDriverFixture("merge-conflict-double-attempt.json").driverAction).toBe("branch_update_claim_required");
  });

  it("reports the deterministic reviewer name", () => {
    expect(runDriverFixture("fallback-review.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).launch.reviewerName).toBe("demo-pr-24-reviewer");
  });

  it("stops an external review request before pre-claim GitHub mutation", () => {
    expect(runDriverFixture("external-review-request.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).driverAction).toBe("external_review_unclaimed");
  });

  it("stops a draft gate before pre-claim GitHub mutation", () => {
    expect(runDriverFixture("draft-pr.json").testAdapterEffects.githubComments).toHaveLength(0);
  });

  it("reports the selection decision while waiting for external review", () => {
    expect(runDriverFixture("external-review-wait.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).decision.reason).toBe("selectable");
  });

  it("keeps the repair rereview launch reason separate from the fallback gate", () => {
    expect(runDriverFixture("repair-rereview-fallback.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).launch.reason).toBe("repair_rereview");
  });

  it("reports the repair rereview selection decision after fallback", () => {
    expect(runDriverFixture("repair-rereview-fallback.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).decision.reason).toBe("repair_rereview");
  });

  it("keeps the stale claim launch reason separate from the fallback gate", () => {
    expect(runDriverFixture("stale-claim-fallback.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).launch.reason).toBe("stale_reclaim");
  });

  it("reports the stale claim selection decision after fallback", () => {
    expect(runDriverFixture("stale-claim-fallback.json", { DEADLOOP_EXTERNAL_REVIEW_ENABLED: "1" }).decision.reason).toBe("stale_reclaim");
  });
});
