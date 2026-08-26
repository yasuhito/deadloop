import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const runner = require("../extensions/deadloop/automations/run-ci-equivalent-verification.cts");
const store = require("../src/ci-fallback-store.cjs");

const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commit(repo: string, file: string, text: string): string {
  writeFileSync(path.join(repo, file), `${text}\n`);
  git(repo, ["add", file]);
  git(repo, ["commit", "--quiet", "-m", text]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/**
 * A trusted base with an npm lockfile plus scripts.check so the convention contract resolves, and a
 * PR branch with one commit on top of it.
 */
function fixtureRepo(): { repoPath: string; stateDir: string; baseOid: string; headOid: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-cifb-runner-"));
  sandboxes.push(root);
  const repoPath = path.join(root, "repo");
  const stateDir = path.join(root, "state");
  mkdirSync(repoPath);
  mkdirSync(stateDir);
  git(repoPath, ["init", "--quiet", "-b", "main"]);
  git(repoPath, ["config", "user.email", "test@example.com"]);
  git(repoPath, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repoPath, "package.json"), `${JSON.stringify({ name: "x", scripts: { check: "node verify.js" } })}\n`);
  writeFileSync(path.join(repoPath, "package-lock.json"), "{}\n");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "--quiet", "-m", "base"]);
  const baseOid = git(repoPath, ["rev-parse", "HEAD"]);
  git(repoPath, ["checkout", "--quiet", "-b", "pr-24"]);
  const headOid = commit(repoPath, "pr.txt", "change");
  return { repoPath, stateDir, baseOid, headOid };
}

function runVerification(input: Record<string, unknown>): Record<string, any> {
  return runner.runVerification({
    mode: "merge",
    projectRepo: "",
    projectId: "demo",
    githubRepo: "owner/repo",
    prNumber: 24,
    headOid: "",
    baseOid: "",
    policyBaseRevision: "",
    stateDir: "",
    timeoutSeconds: 60,
    ...input,
  }, {
    runGit: (args: string[], options?: { cwd?: string }) => {
      const { execFileSync } = require("node:child_process");
      try {
        return {
          status: 0,
          stdout: execFileSync("git", ["-C", options?.cwd || String(input.projectRepo), ...args], { encoding: "utf8" }),
          stderr: "",
        };
      } catch (error) {
        return { status: 1, stdout: "", stderr: String((error as Error).message) };
      }
    },
    runCommand: (command: string, cwd: string) => {
      try {
        return { status: 0, stdout: execFileSync("bash", ["-lc", command], { cwd, encoding: "utf8" }), stderr: "" };
      } catch (error) {
        const failure = error as { status?: number; stdout?: string; stderr?: string };
        return { status: failure.status ?? 1, stdout: failure.stdout || "", stderr: failure.stderr || "" };
      }
    },
    now: () => new Date(),
  });
}

describe("CI-equivalent verification runner on real repositories", () => {
  it("passes when the contract succeeds on the prospective merge tree", () => {
    const fx = fixtureRepo();
    writeFileSync(path.join(fx.repoPath, "verify.js"), "process.exit(0)");
    commit(fx.repoPath, "verify.js", "process.exit(0)");
    const verifiedHead = git(fx.repoPath, ["rev-parse", "HEAD"]);
    const result = runVerification({ projectRepo: fx.repoPath, stateDir: fx.stateDir, headOid: verifiedHead, baseOid: fx.baseOid, policyBaseRevision: fx.baseOid });
    expect(result.outcome).toBe("passed");
  });

  it("fails when the contract fails only after integrating head and base", () => {
    const fx = fixtureRepo();
    // The PR adds a failing flag; the base itself stays green without it.
    writeFileSync(path.join(fx.repoPath, "verify.js"), "process.exit(require('fs').existsSync('should-fail.flag') ? 1 : 0)");
    commit(fx.repoPath, "verify.js", "flag-aware verify");
    const brokenHead = git(fx.repoPath, ["rev-parse", "HEAD"]);
    git(fx.repoPath, ["checkout", "--quiet", "main"]);
    writeFileSync(path.join(fx.repoPath, "verify.js"), "process.exit(0)");
    commit(fx.repoPath, "verify.js", "healthy base");
    const newBase = git(fx.repoPath, ["rev-parse", "HEAD"]);

    const result = runVerification({ projectRepo: fx.repoPath, stateDir: fx.stateDir, headOid: brokenHead, baseOid: newBase, policyBaseRevision: newBase });
    expect(result.outcome).toBe("failed");
  });

  it("records a typed conflict instead of running the command when head and base cannot integrate", () => {
    const fx = fixtureRepo();
    git(fx.repoPath, ["checkout", "--quiet", "main"]);
    writeFileSync(path.join(fx.repoPath, "shared.txt"), "base side\n");
    commit(fx.repoPath, "shared.txt", "base side");
    const conflictedBase = git(fx.repoPath, ["rev-parse", "HEAD"]);
    git(fx.repoPath, ["checkout", "--quiet", "pr-24"]);
    writeFileSync(path.join(fx.repoPath, "shared.txt"), "head side\n");
    commit(fx.repoPath, "shared.txt", "head side");
    const conflictedHead = git(fx.repoPath, ["rev-parse", "HEAD"]);

    const result = runVerification({ projectRepo: fx.repoPath, stateDir: fx.stateDir, headOid: conflictedHead, baseOid: conflictedBase, policyBaseRevision: conflictedBase });
    expect(result.reason).toBe("integration_conflict");
  });

  it("binds every record to repository, head, base, tree, command, derivation, and policy revision", () => {
    const fx = fixtureRepo();
    writeFileSync(path.join(fx.repoPath, "verify.js"), "process.exit(0)");
    commit(fx.repoPath, "verify.js", "process.exit(0)");
    const verifiedHead = git(fx.repoPath, ["rev-parse", "HEAD"]);
    runVerification({ projectRepo: fx.repoPath, stateDir: fx.stateDir, headOid: verifiedHead, baseOid: fx.baseOid, policyBaseRevision: fx.baseOid });
    const persisted = store.readMergeCandidateRecord(fx.stateDir, "demo", 24);
    expect(persisted.headOid).toBe(verifiedHead);
    expect(persisted.baseOid).toBe(fx.baseOid);
    expect(persisted.treeOid).toMatch(/^[0-9a-f]{40}$/);
    expect(persisted.command).toBe("npm ci && npm run check");
    expect(persisted.derivation).toBe("npm_convention");
    expect(persisted.policyBaseRevision).toBe(fx.baseOid);
  });

  it("keeps execution logs outside the worktree and removes the temporary worktree afterwards", () => {
    const fx = fixtureRepo();
    writeFileSync(path.join(fx.repoPath, "verify.js"), "console.log('ran'); process.exit(0)");
    commit(fx.repoPath, "verify.js", "console.log('ran'); process.exit(0)");
    const loggedHead = git(fx.repoPath, ["rev-parse", "HEAD"]);
    runVerification({ projectRepo: fx.repoPath, stateDir: fx.stateDir, headOid: loggedHead, baseOid: fx.baseOid, policyBaseRevision: fx.baseOid });
    const persisted = store.readMergeCandidateRecord(fx.stateDir, "demo", 24);
    expect(existsSync(persisted.logPath)).toBe(true);
    expect(readFileSync(persisted.logPath, "utf8")).toContain("ran");

    const worktrees = git(fx.repoPath, ["worktree", "list", "--porcelain"]);
    expect(worktrees).not.toContain("merge-trees");
  });

  it("reports the contract unavailable without guessing another ecosystem's command", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-cifb-nolock-"));
    sandboxes.push(root);
    const repoPath = path.join(root, "repo");
    const stateDir = path.join(root, "state");
    mkdirSync(repoPath);
    mkdirSync(stateDir);
    git(repoPath, ["init", "--quiet", "-b", "main"]);
    git(repoPath, ["config", "user.email", "test@example.com"]);
    git(repoPath, ["config", "user.name", "Test"]);
    commit(repoPath, "README.md", "no npm here");
    const baseOid = git(repoPath, ["rev-parse", "HEAD"]);

    const result = runVerification({ projectRepo: repoPath, stateDir, headOid: baseOid, baseOid, policyBaseRevision: baseOid });
    expect(result.action).toBe("contract_unavailable");
  });

  it("diagnoses the fixed trusted base itself in base mode", () => {
    const fx = fixtureRepo();
    // A healthy script on the trusted base itself; the PR branch may carry anything.
    git(fx.repoPath, ["checkout", "--quiet", "main"]);
    writeFileSync(path.join(fx.repoPath, "verify.js"), "process.exit(0)");
    commit(fx.repoPath, "verify.js", "process.exit(0)");
    const healthyBase = git(fx.repoPath, ["rev-parse", "HEAD"]);
    const result = runVerification({
      mode: "base",
      projectRepo: fx.repoPath,
      stateDir: fx.stateDir,
      headOid: healthyBase,
      baseOid: healthyBase,
      policyBaseRevision: healthyBase,
    });
    expect(result.outcome).toBe("passed");
    expect(store.readDiagnosisRecord(fx.stateDir, "demo", 24).role).toBe("base_diagnosis");
  });

  it("replaces the record when the head advances so the newest evidence wins", () => {
    const fx = fixtureRepo();
    writeFileSync(path.join(fx.repoPath, "verify.js"), "process.exit(require('fs').existsSync('should-fail.flag') ? 1 : 0)");
    writeFileSync(path.join(fx.repoPath, "should-fail.flag"), "defect\n");
    git(fx.repoPath, ["add", "-A"]);
    git(fx.repoPath, ["commit", "--quiet", "-m", "introduce the defect"]);
    runVerification({ projectRepo: fx.repoPath, stateDir: fx.stateDir, headOid: git(fx.repoPath, ["rev-parse", "HEAD"]), baseOid: fx.baseOid, policyBaseRevision: fx.baseOid });
    const failedOutcome = store.readMergeCandidateRecord(fx.stateDir, "demo", 24);
    expect(failedOutcome.outcome).toBe("failed");

    // A repair pushes a head that removes the defect; the same record file now carries the new proof.
    rmSync(path.join(fx.repoPath, "should-fail.flag"));
    git(fx.repoPath, ["add", "-A"]);
    git(fx.repoPath, ["commit", "--quiet", "-m", "repair removes the defect"]);
    const repairedHead = git(fx.repoPath, ["rev-parse", "HEAD"]);
    runVerification({ projectRepo: fx.repoPath, stateDir: fx.stateDir, headOid: repairedHead, baseOid: fx.baseOid, policyBaseRevision: fx.baseOid });
    const latest = store.readMergeCandidateRecord(fx.stateDir, "demo", 24);
    expect(latest.outcome).toBe("passed");
    expect(latest.headOid).toBe(repairedHead);
  });

  it("binds the failed record to its exact head so an advanced head invalidates it", () => {
    const fx = fixtureRepo();
    writeFileSync(path.join(fx.repoPath, "verify.js"), "process.exit(require('fs').existsSync('should-fail.flag') ? 1 : 0)");
    commit(fx.repoPath, "verify.js", "flag-aware verify");
    writeFileSync(path.join(fx.repoPath, "should-fail.flag"), "defect\n");
    git(fx.repoPath, ["add", "-A"]);
    git(fx.repoPath, ["commit", "--quiet", "-m", "introduce the defect"]);
    const failedHead = git(fx.repoPath, ["rev-parse", "HEAD"]);
    runVerification({ projectRepo: fx.repoPath, stateDir: fx.stateDir, headOid: failedHead, baseOid: fx.baseOid, policyBaseRevision: fx.baseOid });

    const { decideCiFallbackMergeGate } = require("../src/ci-review-policy.cts");
    const record = store.readMergeCandidateRecord(fx.stateDir, "demo", 24);
    rmSync(path.join(fx.repoPath, "should-fail.flag"));
    git(fx.repoPath, ["add", "-A"]);
    git(fx.repoPath, ["commit", "--quiet", "-m", "repair removes the defect"]);
    const advancedHead = git(fx.repoPath, ["rev-parse", "HEAD"]);
    const directive = decideCiFallbackMergeGate({
      checks: [{ status: "COMPLETED", conclusion: "FAILURE" }],
      repository: "owner/repo",
      prNumber: 24,
      headOid: advancedHead,
      baseOid: record.baseOid,
      treeOid: record.treeOid,
      contract: { command: record.command, derivation: record.derivation, policySource: record.policySource },
      policyBaseRevision: record.policyBaseRevision,
      fallbackRecord: record,
    });
    expect(directive.reason).toBe("ci_fallback_stale");
  });
});
