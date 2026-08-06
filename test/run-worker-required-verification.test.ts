import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { assertCleanOutput, run, runWorkerProjectCheck } = require("../extensions/deadloop/automations/run-worker-required-verification.ts");
const { inspectUnresolvedProjectCheckFailures } = require("../src/project-check.ts");
const roots: string[] = [];
function verificationAttempt() {
  const fixture = repository();
  const stateDir = `${fixture.root}-state`; roots.push(stateDir);
  const runDir = path.join(stateDir, "runs", "attempt-1"); mkdirSync(runDir, { recursive: true });
  const trusted = `${fixture.root}-trusted.git`; roots.push(trusted); execFileSync("git", ["init", "--bare", "--quiet", trusted]);
  writeFileSync(path.join(fixture.root, "deadloop.json"), '{"checkCommand":"true"}\n'); execFileSync("git", ["-C", fixture.root, "add", "."]); execFileSync("git", ["-C", fixture.root, "commit", "--quiet", "-m", "policy"]);
  execFileSync("git", ["-C", fixture.root, "remote", "add", "trusted", trusted]); execFileSync("git", ["-C", fixture.root, "push", "--quiet", "trusted", "HEAD:main"]);
  const head = execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const promiseFile = path.join(runDir, "promise.json");
  writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({ attemptId: "attempt-1", launchUuid: "launch-1", project: "demo", repository: "owner/repo", role: "worker", target: { kind: "issue", number: 1 }, inputRevision: { head }, requiredVerification: { repository: "owner/repo", command: "true", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: head }, branch: "agent/issue-1", baseBranch: "trusted/main", worktreePath: fixture.root, agentName: "dl-w-1-abcdef123456", workspaceLabel: "worker", promptFile: path.join(runDir, "prompt.md"), promiseFile, phase: "agent_started", lastSuccessfulPhase: "agent_started" }));
  writeFileSync(promiseFile, JSON.stringify({ schemaVersion: 1, attemptId: "attempt-1", role: "worker", target: { repository: "owner/repo", kind: "issue", number: 1 }, inputRevision: { head }, status: "complete", summary: "done", result: { outputRevision: head }, evidence: { validations: ["additional check"] } }));
  return { args: { attemptRecord: path.join(runDir, "attempt.json"), projectId: "demo", projectRepo: fixture.root, githubRepo: "owner/repo", stateDir, enabledAt: 1, worktree: fixture.root, quarantineRoot: path.join(stateDir, "check-quarantine") }, record: path.join(runDir, "required-verification.json"), log: path.join(runDir, "required-verification.log"), root: fixture.root, head };
}
function repository() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-worker-verification-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  writeFileSync(path.join(root, "file.txt"), "checked\n");
  execFileSync("git", ["-C", root, "add", "file.txt"]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "test"]);
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { root, head };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Worker required-verification checkout binding", () => {
  it("accepts a clean checkout at the reported output commit", () => {
    const fixture = repository();
    expect(() => assertCleanOutput(fixture.root, fixture.head)).not.toThrow();
  });

  it("rejects dirty content before it can become commit-bound evidence", () => {
    const fixture = repository();
    writeFileSync(path.join(fixture.root, "file.txt"), "dirty\n");
    expect(() => assertCleanOutput(fixture.root, fixture.head)).toThrow("must be clean");
  });

  it.each(["--assume-unchanged", "--skip-worktree"])("rejects tracked bytes hidden with %s", (flag) => {
    const fixture = repository();
    execFileSync("git", ["-C", fixture.root, "update-index", flag, "file.txt"]);
    writeFileSync(path.join(fixture.root, "file.txt"), "different bytes\n");
    expect(() => assertCleanOutput(fixture.root, fixture.head)).toThrow("index flags");
  });

  it("allows only quarantinable runtime artifacts in an otherwise clean checkout", () => {
    const fixture = repository();
    mkdirSync(path.join(fixture.root, ".deadloop"));
    writeFileSync(path.join(fixture.root, ".deadloop", "state.json"), "{}\n");
    mkdirSync(path.join(fixture.root, ".pi-subagents"));
    writeFileSync(path.join(fixture.root, ".pi-subagents", "log"), "runtime\n");
    expect(() => assertCleanOutput(fixture.root, fixture.head)).not.toThrow();
  });

  it("rejects a normal untracked file", () => {
    const fixture = repository();
    writeFileSync(path.join(fixture.root, "unexpected.txt"), "output\n");
    expect(() => assertCleanOutput(fixture.root, fixture.head)).toThrow("must be clean");
  });

  it("rejects a checkout at another commit", () => {
    const fixture = repository();
    expect(() => assertCleanOutput(fixture.root, "a".repeat(40))).toThrow("does not match");
  });

  it("passes the shared interruption signal to the detached check runner", async () => {
    const fixture = repository();
    const controller = new AbortController();
    controller.abort();
    const result = await runWorkerProjectCheck(
      { cwd: fixture.root, command: "sleep 30", quarantineRoot: path.join(path.dirname(fixture.root), "quarantine"), timeoutMs: 1000 },
      controller.signal,
      async (input: { signal?: AbortSignal }) => ({ code: 130, stdout: "", stderr: "", timedOut: false, interrupted: input.signal?.aborted, signal: "SIGTERM" }),
    );
    expect(result.check.interrupted).toBe(true);
  });

  it("reruns verification when a passed attempt-local record already exists", async () => {
    const fixture = verificationAttempt();
    writeFileSync(fixture.record, JSON.stringify({ version: 1, binding: { repository: "owner/repo", targetCommit: fixture.head, command: "true", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: fixture.head }, outcome: "passed", exitCode: 0, startedAt: "2026-08-06T00:00:00.000Z", durationMs: 1, logPath: fixture.log }));
    let invocations = 0;

    await run(fixture.args, undefined, async () => {
      invocations += 1;
      return { check: { code: 0, stdout: "fresh verification\n", stderr: "", timedOut: false, interrupted: false, signal: null } };
    }, () => ({}));

    expect(invocations).toBe(1);
  });

  it("rejects policy changes made while required verification is running", async () => {
    const fixture = verificationAttempt();
    let rejected = false;
    try {
      await run(fixture.args, undefined, async () => {
        writeFileSync(path.join(fixture.args.stateDir, "projects.json"), JSON.stringify({ projects: [{ id: "demo", githubRepo: "owner/repo", checkCommand: "false" }] }));
        return { check: { code: 0, stdout: "", stderr: "", timedOut: false, interrupted: false, signal: null } };
      }, () => ({}));
    } catch { rejected = true; }

    expect(rejected).toBe(true);
  });

  it("does not follow a pre-existing verification-log symlink", async () => {
    const fixture = verificationAttempt();
    const target = path.join(path.dirname(fixture.log), "operator-file");
    writeFileSync(target, "keep\n");
    symlinkSync(target, fixture.log);

    let rejected = false;
    try { await run(fixture.args, undefined, async () => ({ check: { code: 0, stdout: "replace\n", stderr: "", timedOut: false, interrupted: false, signal: null } }), () => ({})); }
    catch { rejected = true; }

    expect({ rejected, target: readFileSync(target, "utf8") }).toEqual({ rejected: true, target: "keep\n" });
  });

  it("persists typed failed evidence when the check process cannot start", async () => {
    const fixture = verificationAttempt(); let rejected = false;
    try { await run(fixture.args, undefined, async () => { throw new Error("spawn rejected"); }, () => ({})); }
    catch { rejected = true; }
    const record = JSON.parse(require("node:fs").readFileSync(fixture.record, "utf8"));
    expect({ rejected, outcome: record.outcome, exitCode: record.exitCode, reason: record.terminationReason }).toEqual({ rejected: true, outcome: "failed", exitCode: null, reason: "runner_failure" });
  });

  it("persists a failed record when the check creates output", async () => {
    const fixture = verificationAttempt(); let rejected = false;
    try {
      await run(fixture.args, undefined, async () => {
        writeFileSync(path.join(fixture.root, "generated.txt"), "output\n");
        return { check: { code: 0, stdout: "", stderr: "", timedOut: false, interrupted: false, signal: null } };
      }, () => ({}));
    } catch { rejected = true; }
    const record = JSON.parse(require("node:fs").readFileSync(fixture.record, "utf8"));
    expect({ rejected, outcome: record.outcome, reason: record.terminationReason }).toEqual({ rejected: true, outcome: "failed", reason: "output_not_clean" });
  });

  it("records a restoration conflict for doctor inspection", async () => {
    const fixture = repository();
    const stateDir = `${fixture.root}-state`;
    roots.push(stateDir);
    const quarantinePath = path.join(stateDir, "check-quarantine", "retained");
    mkdirSync(quarantinePath, { recursive: true });
    await runWorkerProjectCheck(
      { cwd: fixture.root, command: "true", quarantineRoot: path.join(stateDir, "check-quarantine"), timeoutMs: 1000 },
      undefined,
      async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, interrupted: false, signal: null, restorationFailure: { message: "restore conflict", quarantinePath } }),
    );
    expect(inspectUnresolvedProjectCheckFailures(stateDir)).toHaveLength(1);
  });
});
