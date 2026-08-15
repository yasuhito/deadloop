import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const {
  consumeRequestEvent,
  resolveAuthorizedAutomationLogins,
} = require("../extensions/deadloop/automations/pr-reviewer-driver.ts");

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function scenario(extraComments: Record<string, unknown>[] = []) {
  const head = "a".repeat(40);
  const request = { id: "request-22", event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } };
  const pr: any = {
    number: 24, state: "OPEN", headRefName: "feature", headRefOid: head,
    labels: [{ name: "agent:review" }, { name: "customer:keep" }], comments: extraComments,
  };
  let commentsWritten = 0;
  const github = {
    getRepositoryIdentity: () => ({ id: "R_repo", nameWithOwner: "owner/repo" }),
    getPr: () => pr,
    listPrTimelineEvents: () => [request],
    listPrLabels: () => pr.labels,
    replacePrLabels: (_repo: string, _number: number, next: string[]) => { pr.labels = next.map((name) => ({ name })); },
    movePrLabels: () => {},
    commentPr: () => { commentsWritten += 1; },
  };
  const env = {
    githubRepo: "owner/repo", githubRepositoryId: "R_repo", automationLogin: "deadloop-bot",
    authorizedAutomationLogins: ["deadloop-bot"], reviewLabel: "agent:review",
    implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch",
    inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    stateDir: path.join(tmpdir(), "missing-deadloop-state"), projectId: "demo",
  };
  const consumed = consumeRequestEvent(github, pr, env, "reviewer", () => "deadloop-bot");
  return { consumed, pr, commentsWritten };
}

describe("PR request consumption", () => {
  it("authorizes no login when automationLogins is empty", () => {
    expect(resolveAuthorizedAutomationLogins([])).toEqual([]);
  });

  it("binds consumption to the latest request event id", () => {
    expect(scenario().consumed.requestEventId).toBe("request-22");
  });

  it("does not publish a machine-readable claim comment", () => {
    expect(scenario().commentsWritten).toBe(0);
  });

  it("preserves unrelated labels while consuming the request", () => {
    expect(scenario().pr.labels.map((label: { name: string }) => label.name)).toContain("customer:keep");
  });

  it("ignores an old claim comment left on the pull request", () => {
    expect(scenario([{ id: 101, body: "<!-- deadloop:review-claim v1=obsolete -->" }]).consumed.requestEventId).toBe("request-22");
  });

  it("reviewer fixture output contains no claim marker", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "deadloop-reviewer-driver-"));
    roots.push(stateDir);
    const result = spawnSync("node", [
      "extensions/deadloop/automations/pr-reviewer-driver.ts", "--fixture",
      "test/fixtures/pr-reviewer-driver/fallback-review.json",
    ], {
      cwd: process.cwd(), encoding: "utf8",
      env: {
        ...process.env, DEADLOOP_PROJECT_ID: "demo", DEADLOOP_STATE_DIR: stateDir,
        DEADLOOP_REPO_PATH: "/repo", DEADLOOP_GITHUB_REPO: "owner/repo",
        DEADLOOP_AUTHORIZED_AUTOMATION_LOGINS: "deadloop-bot",
      },
    });
    expect(result.stdout).not.toContain("deadloop:review-claim");
  });
});
