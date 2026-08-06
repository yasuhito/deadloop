import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { assertCurrentHeadVerification } = require("../extensions/deadloop/automations/guarded-reviewer-handoff.ts");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function evidence(role: "worker" | "reviewer" | "review-repair" | "branch-update") {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-handoff-verification-")); roots.push(root);
  const repo = path.join(root, "repo"); const remote = path.join(root, "remote.git"); const stateDir = path.join(root, "state"); const runDir = path.join(stateDir, "runs", "evidence");
  mkdirSync(repo); mkdirSync(runDir, { recursive: true }); execFileSync("git", ["init", "--bare", "--quiet", remote]); execFileSync("git", ["init", "--quiet", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(path.join(repo, "deadloop.json"), '{"checkCommand":"npm run check"}\n'); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "base"]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", remote]); execFileSync("git", ["-C", repo, "push", "--quiet", "origin", "main"]); const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const contract = { repository: "owner/repo", command: "npm run check", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: head };
  writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({ attemptId: "evidence", launchUuid: "launch", project: "demo", repository: "owner/repo", role, target: { kind: "pull-request", number: 24 }, inputRevision: { head }, requiredVerification: contract, branch: "agent/issue-1", baseBranch: "origin/main", worktreePath: repo, agentName: "dl-r-24-abcdef123456", workspaceLabel: role, promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"), phase: "agent_started", lastSuccessfulPhase: "agent_started", outputRevision: head }));
  writeFileSync(path.join(runDir, "promise.json"), JSON.stringify({ schemaVersion: 1, attemptId: "evidence", role, target: { repository: "owner/repo", kind: "pull-request", number: 24 }, inputRevision: { head }, status: "complete", summary: "done", result: { outputRevision: head }, evidence: { validations: ["check"] } }));
  writeFileSync(path.join(runDir, "required-verification.json"), JSON.stringify({ version: 1, binding: { repository: "owner/repo", targetCommit: head, command: contract.command, source: contract.source, baseRevision: head }, outcome: "passed", exitCode: 0, startedAt: "2026-08-06T00:00:00.000Z", durationMs: 1, logPath: path.join(runDir, "check.log") }));
  return { projectRepo: repo, githubRepo: "owner/repo", stateDir, enabledAt: 1, pr: "24", expectedHead: head, reviewPromise: "unused", reviewLabel: "agent:review", reviewingLabel: "agent:reviewing", blockedLabel: "agent:blocked", humanLabel: "ready-for-human" };
}

function transformedEvidence(role: "review-repair" | "branch-update") {
  const fixture = evidence("worker"); const inputHead = fixture.expectedHead; const outputHead = role === "review-repair" ? "b".repeat(40) : "c".repeat(40);
  const runDir = path.join(fixture.stateDir, "runs", role); mkdirSync(runDir);
  const attempt = JSON.parse(readFileSync(path.join(fixture.stateDir, "runs", "evidence", "attempt.json"), "utf8"));
  Object.assign(attempt, { attemptId: role, launchUuid: role, role, target: { kind: "pull-request", number: 24 }, inputRevision: { head: inputHead, ...(role === "branch-update" ? { base: inputHead } : {}) }, agentName: `dl-${role}`, workspaceLabel: role, promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"), phase: "report_received", lastSuccessfulPhase: "report_received", outputRevision: outputHead });
  delete attempt.requiredVerification; writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify(attempt));
  const outcome = role === "review-repair" ? "repair_pushed" : "branch_update_pushed";
  const finalizer = { action: "pushed", reason: outcome, originalHeadOid: inputHead, ...(role === "branch-update" ? { baseHeadOid: inputHead } : {}), headOid: outputHead, checks: [{ command: "npm run check", result: "passed" }] };
  writeFileSync(attempt.promiseFile, JSON.stringify({ schemaVersion: 1, attemptId: role, role, target: { repository: "owner/repo", kind: "pull-request", number: 24 }, inputRevision: attempt.inputRevision, status: "complete", summary: "verified", result: { outcome, outputRevision: outputHead, ...(role === "review-repair" ? { repairs: [{ title: "finding", summary: "fixed", paths: ["src/a.ts"] }] } : {}) }, evidence: { finalizer, validations: finalizer.checks } }));
  fixture.expectedHead = outputHead; return fixture;
}

describe("human-handoff verification provenance", () => {
  it("authorizes a Worker-produced head from its current-head verification record", () => {
    expect(() => assertCurrentHeadVerification(evidence("worker"))).not.toThrow();
  });

  it("rejects incomplete Worker verification metadata", () => {
    const fixture = evidence("worker");
    const recordFile = path.join(fixture.stateDir, "runs", "evidence", "required-verification.json");
    const record = JSON.parse(readFileSync(recordFile, "utf8"));
    delete record.startedAt; writeFileSync(recordFile, JSON.stringify(record));

    expect(() => assertCurrentHeadVerification(fixture)).toThrow("record is invalid");
  });

  it("rejects a Worker-produced head without its verification record", () => {
    const fixture = evidence("worker");
    rmSync(path.join(fixture.stateDir, "runs", "evidence", "required-verification.json"));

    expect(() => assertCurrentHeadVerification(fixture)).toThrow("required verification passed record is missing");
  });

  it.each(["review-repair", "branch-update"] as const)("authorizes a %s head through its bound passed check and Worker provenance", (role) => {
    expect(() => assertCurrentHeadVerification(transformedEvidence(role))).not.toThrow();
  });

  it.each([
    ["a repaired head", "review-repair"],
    ["a branch-updated head", "branch-update"],
    ["a pre-existing PR head", "reviewer"],
  ] as const)("rejects %s without authoritative current-head evidence", (_name, role) => {
    const fixture = evidence(role);
    rmSync(path.join(fixture.stateDir, "runs", "evidence", "required-verification.json"));

    expect(() => assertCurrentHeadVerification(fixture)).toThrow("human handoff stopped");
  });

  it("fails closed when the evidence store is missing", () => {
    const fixture = evidence("worker");
    rmSync(path.join(fixture.stateDir, "runs"), { recursive: true });

    expect(() => assertCurrentHeadVerification(fixture)).toThrow("evidence store is missing or unreadable");
  });

  it("fails closed when an attempt record is malformed", () => {
    const fixture = evidence("worker");
    const malformed = path.join(fixture.stateDir, "runs", "malformed");
    mkdirSync(malformed); writeFileSync(path.join(malformed, "attempt.json"), "not-json\n");

    expect(() => assertCurrentHeadVerification(fixture)).toThrow("contains a malformed attempt");
  });

  it("fails closed when current-head provenance is ambiguous", () => {
    const fixture = evidence("worker");
    const duplicate = path.join(fixture.stateDir, "runs", "duplicate");
    cpSync(path.join(fixture.stateDir, "runs", "evidence"), duplicate, { recursive: true });
    const file = path.join(duplicate, "attempt.json"); const attempt = JSON.parse(readFileSync(file, "utf8"));
    attempt.attemptId = "duplicate"; attempt.launchUuid = "duplicate"; writeFileSync(file, JSON.stringify(attempt));

    expect(() => assertCurrentHeadVerification(fixture)).toThrow("provenance is ambiguous");
  });
});
