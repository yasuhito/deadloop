import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { runGuardedPush } = require("../extensions/deadloop/automations/guarded-push.ts");
const roots: string[] = [];
const originalConfigDir = process.env.PI_CODING_AGENT_DIR;
const originalPath = process.env.PATH;
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-worker-push-")); roots.push(root);
  const repo = path.join(root, "repo"); const stateDir = path.join(root, "deadloop");
  process.env.PI_CODING_AGENT_DIR = root; const runDir = path.join(stateDir, "runs", "attempt-1");
  const bin = path.join(root, "bin"); mkdirSync(bin);
  const gh = path.join(bin, "gh"); writeFileSync(gh, "#!/bin/sh\nprintf '{\"id\":\"R_repo\"}\\n'\n"); execFileSync("chmod", ["+x", gh]);
  process.env.PATH = `${bin}:${originalPath || ""}`;
  mkdirSync(repo); mkdirSync(runDir, { recursive: true });
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]); execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(path.join(repo, "deadloop.json"), '{"checkCommand":"npm test"}\n');
  execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "base"]);
  const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const trustedRemote = path.join(root, "trusted.git"); execFileSync("git", ["init", "--bare", "--quiet", trustedRemote]);
  execFileSync("git", ["-C", repo, "remote", "add", "trusted", trustedRemote]); execFileSync("git", ["-C", repo, "push", "--quiet", "trusted", "HEAD:main"]);
  execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "agent/issue-1"]);
  writeFileSync(path.join(repo, "change.txt"), "done\n"); execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "feat: change"]);
  const output = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/owner/repo.git"]);
  const contract = { repository: "owner/repo", command: "npm test", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: base };
  const attempt = { attemptId: "attempt-1", launchUuid: "launch-1", project: "demo", repository: "owner/repo", role: "worker", target: { kind: "issue", number: 1 }, inputRevision: { head: base }, requiredVerification: contract, branch: "agent/issue-1", baseBranch: "trusted/main", worktreePath: repo, agentName: "dl-w-1-abcdef123456", workspaceLabel: "worker", promptFile: path.join(runDir, "prompt.md"), promiseFile: path.join(runDir, "promise.json"), phase: "agent_started", lastSuccessfulPhase: "agent_started" };
  const report = { schemaVersion: 1, attemptId: "attempt-1", role: "worker", target: { repository: "owner/repo", kind: "issue", number: 1 }, inputRevision: { head: base }, status: "complete", summary: "Implemented and validated.", result: { outputRevision: output }, evidence: { validations: ["extra check passed"] } };
  writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify(attempt)); writeFileSync(path.join(runDir, "promise.json"), JSON.stringify(report));
  writeFileSync(path.join(runDir, "required-verification.json"), JSON.stringify({ version: 1, binding: { repository: "owner/repo", targetCommit: output, command: "npm test", source: contract.source, baseRevision: base }, outcome: "passed", exitCode: 0, startedAt: "2026-08-06T00:00:00.000Z", durationMs: 1, logPath: path.join(runDir, "check.log") }));
  writeFileSync(path.join(stateDir, "enabled-projects.json"), JSON.stringify({ projects: [{ repoPath: repo, githubRepo: "owner/repo", githubRepositoryId: "R_repo", enabledAt: 1, firstEnableAutoMerge: false, firstStartPending: false, lastObservedAutoMerge: false, autoMergeAcknowledged: false, enabled: true }] }));
  let pushedRef = "";
  const common = path.join(repo, ".git");
  const ops = { run: (argv: string[]) => {
    if (argv.includes("--git-common-dir")) return { status: 0, stdout: `${common}\n`, stderr: "" };
    if (argv.includes("--show-toplevel")) return { status: 0, stdout: `${repo}\n`, stderr: "" };
    if (argv.includes("worktree") && argv.includes("--porcelain")) return { status: 0, stdout: `worktree ${repo}\n`, stderr: "" };
    if (argv.includes("symbolic-ref")) return { status: 0, stdout: "agent/issue-1\n", stderr: "" };
    if (argv.includes("HEAD^{commit}")) return { status: 0, stdout: `${output}\n`, stderr: "" };
    if (argv.includes("get-url")) return { status: 0, stdout: "https://github.com/owner/repo.git\n", stderr: "" };
    if (argv[0] === "gh") return { status: 0, stdout: '{"id":"R_repo"}', stderr: "" };
    if (argv.includes("push")) { pushedRef = argv[6] || ""; return { status: 0, stdout: "", stderr: "" }; }
    return { status: 1, stdout: "", stderr: `unexpected: ${argv.join(" ")}` };
  } };
  const args = { attemptRecord: path.join(runDir, "attempt.json"), projectId: "demo", projectRepo: repo, worktree: repo, githubRepo: "owner/repo", stateDir, enabledAt: 1, remote: "origin", branch: "agent/issue-1" };
  return { args, ops, output, pushedRef: () => pushedRef, verification: path.join(runDir, "required-verification.json") };
}
afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalConfigDir;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("verified Worker push boundary", () => {
  it("pushes the immutable verified revision", () => { const f = fixture(); runGuardedPush(f.args, f.ops); expect(f.pushedRef()).toBe(`${f.output}:refs/heads/agent/issue-1`); });
  it("rejects a missing passed record before push", () => { const f = fixture(); rmSync(f.verification); expect(() => runGuardedPush(f.args, f.ops)).toThrow("record is missing"); });
  it("rejects another project before push", () => { const f = fixture(); expect(() => runGuardedPush({ ...f.args, projectId: "other" }, f.ops)).toThrow("project"); });
  it("rejects another repository before push", () => { const f = fixture(); expect(() => runGuardedPush({ ...f.args, githubRepo: "other/repo" }, f.ops)).toThrow("repository"); });
  it("rejects another branch before push", () => { const f = fixture(); expect(() => runGuardedPush({ ...f.args, branch: "agent/issue-2" }, f.ops)).toThrow("branch"); });
  it("rejects another worktree before push", () => { const f = fixture(); expect(() => runGuardedPush({ ...f.args, worktree: path.dirname(f.args.worktree) }, f.ops)).toThrow("worktree"); });
  it("reauthorizes after the final enablement recheck", () => {
    const f = fixture(); let calls = 0; let error = "";
    try {
      runGuardedPush(f.args, f.ops, () => {
        calls += 1;
        if (calls === 3) throw new Error("stale_policy");
        return f.output;
      });
    } catch (caught) { error = String(caught); }
    expect({ calls, pushed: f.pushedRef(), stale: error.includes("stale_policy") }).toEqual({ calls: 3, pushed: "", stale: true });
  });
});
