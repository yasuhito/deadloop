import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { assertCurrentHeadVerification } = require("../extensions/deadloop/automations/guarded-reviewer-handoff.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function evidence(role: "reviewer" | "review-repair" | "branch-update") {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-handoff-verification-")); roots.push(root);
  const repo = path.join(root, "repo"); const remote = path.join(root, "remote.git"); const stateDir = path.join(root, "state"); const runDir = path.join(stateDir, "runs", "evidence");
  mkdirSync(repo); mkdirSync(runDir, { recursive: true }); execFileSync("git", ["init", "--bare", "--quiet", remote]); execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(path.join(repo, "deadloop.json"), '{"checkCommand":"npm run check"}\n'); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "base"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]); execFileSync("git", ["-C", repo, "push", "--quiet", "origin", "main"]); const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const contract = { repository: "owner/repo", command: "npm run check", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: head };
  writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({ attemptId: "evidence", launchUuid: "launch", project: "demo", repository: "owner/repo", role, target: { kind: "pull-request", number: 24 }, inputRevision: { head }, requiredVerification: contract, branch: "agent/issue-1", baseBranch: "origin/main", worktreePath: repo, agentName: "dl-r-24-abcdef123456", workspaceLabel: role, promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"), phase: "agent_started", lastSuccessfulPhase: "agent_started" }));
  writeFileSync(path.join(runDir, "required-verification.json"), JSON.stringify({ version: 1, binding: { repository: "owner/repo", targetCommit: head, command: contract.command, source: contract.source, baseRevision: head }, outcome: "passed", exitCode: 0, startedAt: "2026-08-06T00:00:00.000Z", durationMs: 1, logPath: path.join(runDir, "check.log") }));
  return { projectRepo: repo, githubRepo: "owner/repo", stateDir, enabledAt: 1, pr: "24", expectedHead: head, reviewPromise: "unused", reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", blockedLabel: "agent:blocked", humanLabel: "ready-for-human" };
}

describe("role-neutral human-handoff verification", () => {
  it.each([
    ["a repaired head", "review-repair"],
    ["a branch-updated head", "branch-update"],
    ["a pre-existing PR head", "reviewer"],
  ] as const)("authorizes %s from its current-head verification record", (_name, role) => {
    expect(() => assertCurrentHeadVerification(evidence(role))).not.toThrow();
  });
});
