import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const store = require("../src/ci-fallback-store.cjs");

const stateDirs: string[] = [];

afterEach(() => {
  for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newStateDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "deadloop-ci-fallback-store-"));
  stateDirs.push(dir);
  return dir;
}

function record(overrides: Record<string, unknown> = {}) {
  return store.buildVerificationRecord({
    role: "merge_candidate",
    repository: "owner/repo",
    prNumber: 24,
    headOid: "a".repeat(40),
    baseOid: "b".repeat(40),
    treeOid: "d".repeat(40),
    command: "npm ci && npm run check",
    derivation: "npm_convention",
    policySource: { kind: "npm_convention", location: "package-lock.json+package.json#scripts.check" },
    policyBaseRevision: "b".repeat(40),
    outcome: "passed",
    exitCode: 0,
    startedAt: new Date().toISOString(),
    durationMs: 100,
    logPath: "/state/logs/x.log",
    ...overrides,
  });
}

describe("CI fallback verification records", () => {
  it("persists records outside every worktree under the project's state directory", () => {
    const stateDir = newStateDir();
    const recordPath = store.writeMergeCandidateRecord(stateDir, "demo", record());

    expect({
      storedOutsideWorktree: recordPath.startsWith(path.join(stateDir, "ci-fallback", "demo")),
      persistedPrNumber: store.readMergeCandidateRecord(stateDir, "demo", 24).prNumber,
    }).toEqual({ storedOutsideWorktree: true, persistedPrNumber: 24 });
  });

  it("keeps the diagnosis record separate from the merge-candidate record", () => {
    const stateDir = newStateDir();
    store.writeDiagnosisRecord(stateDir, "demo", record({ role: "base_diagnosis" }));
    const diagnosis = store.readDiagnosisRecord(stateDir, "demo", 24);
    expect(diagnosis.role).toBe("base_diagnosis");
  });

  it("survives a crash between write and rename by never exposing partial files", () => {
    const stateDir = newStateDir();
    store.writeMergeCandidateRecord(stateDir, "demo", record());
    const written = readFileSync(store.mergeCandidateRecordPath(stateDir, "demo", 24), "utf8");
    expect(JSON.parse(written).version).toBe(1);
  });
});

describe("base blocking records", () => {
  it("stays active while the same failed base and contract pair stands", () => {
    const stateDir = newStateDir();
    store.writeBaseBlocking(stateDir, "demo", { baseRevision: "base1", command: "make ci", prNumber: 24, reason: "base_verification_failed" });
    const evaluation = store.evaluateBaseBlocking(stateDir, "demo", { baseRevision: "base1", command: "make ci" });
    expect(evaluation.active).toBe(true);
  });

  it("clears automatically when the base advances", () => {
    const stateDir = newStateDir();
    store.writeBaseBlocking(stateDir, "demo", { baseRevision: "base1", command: "make ci", prNumber: 24 });
    const evaluation = store.evaluateBaseBlocking(stateDir, "demo", { baseRevision: "base2", command: "make ci" });

    expect({
      active: evaluation.active,
      recordExists: existsSync(store.ciFallbackDirectory(stateDir, "demo") + "/base-blocking.json"),
    }).toEqual({ active: false, recordExists: false });
  });

  it("clears automatically when the contract command changes", () => {
    const stateDir = newStateDir();
    store.writeBaseBlocking(stateDir, "demo", { baseRevision: "base1", command: "make ci", prNumber: 24 });
    expect(store.evaluateBaseBlocking(stateDir, "demo", { baseRevision: "base1", command: "bun run verify" }).active).toBe(false);
  });
});

describe("repair episodes", () => {
  it("derives an episode key that ignores changed heads", () => {
    const first = store.episodeKeyFor("owner/repo", 24, "base1", "make ci");
    expect(first).toBe(store.episodeKeyFor("owner/repo", 24, "base1", "make ci"));
  });

  it("changes the episode identity when base or contract changes", () => {
    expect(store.episodeKeyFor("owner/repo", 24, "base1", "make ci"))
      .not.toBe(store.episodeKeyFor("owner/repo", 24, "base2", "make ci"));
  });

  it("round-trips episode bookkeeping", () => {
    const stateDir = newStateDir();
    store.writeRepairEpisode(stateDir, "demo", { repository: "owner/repo", prNumber: 24, episodeKey: "k", repairsUsed: 0 });
    store.writeRepairEpisode(stateDir, "demo", { repository: "owner/repo", prNumber: 24, episodeKey: "k", repairsUsed: 1 });
    expect(store.readRepairEpisode(stateDir, "demo", 24)?.repairsUsed).toBe(1);
  });
});

describe("log identity", () => {
  it("names log files under the persisted logs directory", () => {
    const logPath = store.newLogIdentity("/state", "demo", 24, "a".repeat(40));
    expect(logPath.startsWith(path.join("/state", "ci-fallback", "demo", "logs", "pr-24-"))).toBe(true);
  });
});

void writeFileSync;

describe("project base blocking evaluation", () => {
  const { execFileSync } = require("node:child_process");

  function realRepo(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-base-blocking-"));
    stateDirs.push(root);
    const repoPath = path.join(root, "repo");
    require("node:fs").mkdirSync(repoPath);
    execFileSync("git", ["-C", repoPath, "init", "--quiet", "-b", "main"]);
    execFileSync("git", ["-C", repoPath, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repoPath, "config", "user.name", "T"]);
    writeFileSync(path.join(repoPath, "f.txt"), "x\n");
    execFileSync("git", ["-C", repoPath, "add", "."]);
    execFileSync("git", ["-C", repoPath, "commit", "--quiet", "-m", "c"]);
    return root;
  }

  it("reports the active reason while the same base and command pair stands", () => {
    const { evaluateProjectBaseBlocking } = require("../src/ci-base-blocking.cts");
    const root = realRepo();
    const repoPath = path.join(root, "repo");
    const baseRevision = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    store.writeBaseBlocking(root, "demo", { baseRevision, command: "make ci", prNumber: 24 });

    const evaluation = evaluateProjectBaseBlocking({ stateDir: root, projectId: "demo", repoPath, baseBranch: "main" });

    execFileSync("git", ["-C", repoPath, "commit", "--quiet", "--allow-empty", "-m", "advance"]);
    const cleared = evaluateProjectBaseBlocking({ stateDir: root, projectId: "demo", repoPath, baseBranch: "main" });
    expect({ activeBeforeAdvance: evaluation.active, activeAfterAdvance: cleared.active }).toEqual({
      activeBeforeAdvance: true,
      activeAfterAdvance: false,
    });
  });

  it("observing a stale base/contract pair reports it inactive", () => {
    const { observeProjectBaseBlocking } = require("../src/ci-base-blocking.cts");
    const root = realRepo();
    const repoPath = path.join(root, "repo");
    store.writeBaseBlocking(root, "demo", { baseRevision: "0".repeat(40), command: "make ci", prNumber: 24 });

    expect(observeProjectBaseBlocking({ stateDir: root, projectId: "demo", repoPath, baseBranch: "main" }).active).toBe(false);
  });

  it("observing a stale base/contract pair leaves the record in place", () => {
    const { observeProjectBaseBlocking } = require("../src/ci-base-blocking.cts");
    const root = realRepo();
    const repoPath = path.join(root, "repo");
    store.writeBaseBlocking(root, "demo", { baseRevision: "0".repeat(40), command: "make ci", prNumber: 24 });

    observeProjectBaseBlocking({ stateDir: root, projectId: "demo", repoPath, baseBranch: "main" });

    expect(store.readBaseBlocking(root, "demo")).not.toBeNull();
  });
});
