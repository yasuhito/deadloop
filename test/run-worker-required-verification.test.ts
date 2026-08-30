import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { applyCompletionRequiredVerificationStop, assertCleanOutput, completionStopDiagnosis, run, runWorkerProjectCheck } = require("../extensions/deadloop/automations/run-worker-required-verification.cts");
const { inspectUnresolvedProjectCheckFailures } = require("../src/project-check.cts");
const { persistHostVerificationEvidence, writeWorkerContractSnapshot } = require("../src/worker-required-verification-runtime.cjs");
const { planVerificationFailureNotice, readLogTail } = require("../src/issue-required-verification-failure-notice.cts");
const roots: string[] = [];
function verificationAttempt(source: "repo_policy" | "default" = "repo_policy") {
  const fixture = repository();
  const stateDir = `${fixture.root}-state`; roots.push(stateDir);
  const runDir = path.join(stateDir, "runs", "attempt-1"); mkdirSync(runDir, { recursive: true });
  const trusted = `${fixture.root}-trusted.git`; roots.push(trusted); execFileSync("git", ["init", "--bare", "--quiet", trusted]);
  if (source === "repo_policy") {
    writeFileSync(path.join(fixture.root, "deadloop.json"), '{"checkCommand":"true"}\n');
    execFileSync("git", ["-C", fixture.root, "add", "."]);
    execFileSync("git", ["-C", fixture.root, "commit", "--quiet", "-m", "policy"]);
  }
  execFileSync("git", ["-C", fixture.root, "remote", "add", "trusted", trusted]); execFileSync("git", ["-C", fixture.root, "push", "--quiet", "trusted", "HEAD:main"]);
  const head = execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const promiseFile = path.join(runDir, "promise.json");
  const command = source === "default" ? "npm run check" : "true";
  const attempt = { attemptId: "attempt-1", launchUuid: "launch-1", project: "demo", repository: "owner/repo", role: "worker", target: { kind: "issue", number: 1 }, inputRevision: { head }, requiredVerification: { repository: "owner/repo", command, source: { kind: source, location: source === "default" ? "deadloop" : "deadloop.json" }, baseRevision: head }, branch: "agent/issue-1", baseBranch: "trusted/main", worktreePath: fixture.root, agentName: "dl-w-1-abcdef123456", workspaceLabel: "worker", promptFile: path.join(runDir, "prompt.md"), promiseFile, phase: "agent_started", lastSuccessfulPhase: "agent_started" };
  writeWorkerContractSnapshot(runDir, attempt);
  writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify(attempt));
  writeFileSync(promiseFile, JSON.stringify({ schemaVersion: 1, attemptId: "attempt-1", role: "worker", target: { repository: "owner/repo", kind: "issue", number: 1 }, inputRevision: { head }, status: "complete", summary: "done", result: { outputRevision: head }, evidence: { validations: ["additional check"] } }));
  return { args: { attemptRecord: path.join(runDir, "attempt.json"), projectId: "demo", projectRepo: fixture.root, githubRepo: "owner/repo", stateDir, enabledAt: 1, worktree: fixture.root, quarantineRoot: path.join(stateDir, "check-quarantine") }, record: path.join(runDir, "required-verification.json"), log: path.join(runDir, "required-verification.log"), promiseFile, root: fixture.root, head };
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

function failedRecord(fixture?: { head: string; log: string }) {
  const head = fixture?.head ?? "b".repeat(40);
  return {
    version: 1 as const,
    binding: { repository: "owner/repo", targetCommit: head, command: "true", source: { kind: "repo_policy", location: "deadloop.json" }, baseRevision: head },
    outcome: "failed" as const,
    exitCode: 2,
    startedAt: "2026-08-29T00:00:00.000Z",
    durationMs: 94000,
    logPath: fixture?.log ?? "/state/runs/attempt-1/required-verification.log",
  };
}

describe("Worker required-verification checkout binding", () => {
  it("binds completion-stop enablement to the configured project repository path", () => {
    let lockedProject: Record<string, unknown> | undefined;
    applyCompletionRequiredVerificationStop(
      { attemptRecord: "/state/runs/attempt/attempt.json", projectId: "demo", projectRepo: "/repo", githubRepo: "owner/repo", stateDir: "/state", enabledAt: 1, worktree: "/worktree", quarantineRoot: "/quarantine" },
      { target: { kind: "issue", number: 42 } },
      new Error("required verification blocked: stale_policy"),
      (project: Record<string, unknown>) => { lockedProject = project; },
    );

    expect(lockedProject?.repoPath).toBe("/repo");
  });

  it("reports both fixed-contract sources when a local override becomes stale", () => {
    const attempt = {
      repository: "owner/repo",
      inputRevision: { head: "a".repeat(40) },
      requiredVerification: {
        command: "npm run local-check",
        source: { kind: "local", location: "projects.json#project=demo" },
        baseRevision: "a".repeat(40),
        override: { source: { kind: "repo_policy", location: "deadloop.json" }, command: "npm run check" },
      },
    };
    expect(completionStopDiagnosis(attempt, new Error("required verification blocked: stale_policy")).sources).toHaveLength(2);
  });

  it("reports current inspected sources when stale-policy diagnosis provides them", () => {
    const error = Object.assign(new Error("required verification blocked: stale_policy"), {
      requiredVerificationSources: [{ kind: "repo_policy", location: "deadloop.json", command: "npm run changed-check" }],
    });
    const diagnosis = completionStopDiagnosis({ repository: "owner/repo", inputRevision: { head: "a".repeat(40) }, requiredVerification: {} }, error);
    expect(diagnosis.sources[0].command).toBe("npm run changed-check");
  });

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

  it("allows an agent scratch area in an otherwise clean checkout", () => {
    const fixture = repository();
    mkdirSync(path.join(fixture.root, ".pi", "subagents"), { recursive: true });
    writeFileSync(path.join(fixture.root, ".pi", "subagents", "log"), "runtime\n");
    expect(() => assertCleanOutput(fixture.root, fixture.head)).not.toThrow();
  });

  it("rejects a tracked change under an agent scratch area", () => {
    const fixture = repository();
    mkdirSync(path.join(fixture.root, ".pi", "subagents"), { recursive: true });
    writeFileSync(path.join(fixture.root, ".pi", "subagents", "report.md"), "first\n");
    execFileSync("git", ["-C", fixture.root, "add", ".pi/subagents/report.md"]);
    execFileSync("git", ["-C", fixture.root, "commit", "-qm", "track scratch report"]);
    const head = execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(fixture.root, ".pi", "subagents", "report.md"), "edited\n");
    expect(() => assertCleanOutput(fixture.root, head)).toThrow("must be clean");
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

  it("accepts the built-in default when current policy has no override", async () => {
    const fixture = verificationAttempt("default");
    let command = "";

    await run(fixture.args, undefined, async (input: { command: string }) => {
      command = input.command;
      return { check: { code: 0, stdout: "", stderr: "", timedOut: false, interrupted: false, signal: null } };
    }, () => ({}));

    expect(command).toBe("npm run check");
  });

  it("stops the Issue when a local override is added after a default-backed launch", async () => {
    const fixture = verificationAttempt("default");
    writeFileSync(path.join(fixture.args.stateDir, "projects.json"), JSON.stringify({ projects: [{ id: "demo", githubRepo: "owner/repo", checkCommand: "true" }] }));
    let stopped = false;

    const result = await run(
      fixture.args,
      undefined,
      async () => ({ check: { code: 0, stdout: "", stderr: "", timedOut: false, interrupted: false, signal: null } }),
      () => ({}),
      () => { stopped = true; },
    );

    expect({ status: result.status, stopped }).toEqual({ status: "blocked", stopped: true });
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

  it("does not rerun when an authenticated failed record has the same binding", async () => {
    const fixture = verificationAttempt();
    writeFileSync(fixture.log, "npm ERR! exited 2\nlast log line\n");
    persistHostVerificationEvidence(fixture.record, failedRecord(fixture));
    let invocations = 0;

    await expect(run(fixture.args, undefined, async () => {
      invocations += 1;
      return { check: { code: 0, stdout: "", stderr: "", timedOut: false, interrupted: false, signal: null } };
    }, () => ({}), undefined, () => {})).rejects.toThrow("required verification failed");

    expect(invocations).toBe(0);
  });

  it("reruns when the target commit moves past an authenticated failed record", async () => {
    const fixture = verificationAttempt();
    persistHostVerificationEvidence(fixture.record, failedRecord(fixture));
    writeFileSync(path.join(fixture.root, "next.txt"), "next\n");
    execFileSync("git", ["-C", fixture.root, "add", "next.txt"]);
    execFileSync("git", ["-C", fixture.root, "commit", "--quiet", "-m", "next"]);
    const nextHead = execFileSync("git", ["-C", fixture.root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeFileSync(fixture.promiseFile, JSON.stringify({ schemaVersion: 1, attemptId: "attempt-1", role: "worker", target: { repository: "owner/repo", kind: "issue", number: 1 }, inputRevision: { head: fixture.head }, status: "complete", summary: "done", result: { outputRevision: nextHead }, evidence: { validations: ["additional check"] } }));
    let invocations = 0;

    await run(fixture.args, undefined, async () => {
      invocations += 1;
      return { check: { code: 0, stdout: "", stderr: "", timedOut: false, interrupted: false, signal: null } };
    }, () => ({}));

    expect(invocations).toBe(1);
  });

  it("reruns when an attempt-local failed record has no host evidence", async () => {
    const fixture = verificationAttempt();
    writeFileSync(fixture.record, JSON.stringify(failedRecord(fixture)));
    let invocations = 0;

    await run(fixture.args, undefined, async () => {
      invocations += 1;
      return { check: { code: 0, stdout: "", stderr: "", timedOut: false, interrupted: false, signal: null } };
    }, () => ({}));

    expect(invocations).toBe(1);
  });

  it("comments about a same-binding failure once across repeated ticks", async () => {
    const fixture = verificationAttempt();
    writeFileSync(fixture.log, "npm ERR! exited 2\nlast log line\n");
    persistHostVerificationEvidence(fixture.record, failedRecord(fixture));
    const issue = { number: 1, state: "OPEN", labels: ["agent:in-progress"], comments: [] as Array<{ body: string }> };
    const comments: string[] = [];
    const noticeOnce = () => {
      const plan = planVerificationFailureNotice({ issue, record: failedRecord(fixture), logTail: readLogTail(fixture.log) });
      if (plan.comment) { comments.push(plan.comment); issue.comments.push({ body: plan.comment }); }
    };

    await expect(run(fixture.args, undefined, async () => { throw new Error("must not run"); }, () => ({}), undefined, noticeOnce)).rejects.toThrow("required verification failed");
    await expect(run(fixture.args, undefined, async () => { throw new Error("must not run"); }, () => ({}), undefined, noticeOnce)).rejects.toThrow("required verification failed");

    expect(comments).toHaveLength(1);
  });

  it("includes the exit code in the failure notice", () => {
    const plan = planVerificationFailureNotice({ issue: { number: 7, comments: [] }, record: failedRecord(), logTail: "" });
    expect(plan.comment).toContain("exit code: 2");
  });

  it("includes the log tail in the failure notice", () => {
    const plan = planVerificationFailureNotice({ issue: { number: 7, comments: [] }, record: failedRecord(), logTail: "npm ERR! exited 2\nlast log line\n" });
    expect(plan.comment).toContain("last log line");
  });

  it("does not comment again when the same failure marker already exists", () => {
    const first = planVerificationFailureNotice({ issue: { number: 7, comments: [] }, record: failedRecord(), logTail: "" });
    const second = planVerificationFailureNotice({ issue: { number: 7, comments: [{ body: first.comment || "" }] }, record: failedRecord(), logTail: "" });
    expect(second.comment).toBeUndefined();
  });

  it("persists evidence that a later host process can authorize", async () => {
    const fixture = verificationAttempt();
    await run(fixture.args, undefined, async () => ({ check: { code: 0, stdout: "", stderr: "", timedOut: false, interrupted: false, signal: null } }), () => ({}));
    const script = `const fs=require("node:fs");const runtime=require(${JSON.stringify(path.resolve("src/worker-required-verification-runtime.cjs"))});const attempt=JSON.parse(fs.readFileSync(${JSON.stringify(fixture.args.attemptRecord)},"utf8"));const report=JSON.parse(fs.readFileSync(attempt.promiseFile,"utf8"));const record=runtime.readRequiredVerificationRecord(${JSON.stringify(fixture.record)});runtime.assertWorkerCompletionAuthorized(attempt,report,record,attempt.requiredVerification);`;

    expect(() => execFileSync(process.execPath, ["-e", script])).not.toThrow();
  });

  it("rejects direct replacement of the attempt-local contract after launch", async () => {
    const fixture = verificationAttempt();
    const attemptFile = fixture.args.attemptRecord;
    const replaced = JSON.parse(readFileSync(attemptFile, "utf8"));
    replaced.requiredVerification.command = "false";
    writeFileSync(attemptFile, JSON.stringify(replaced));

    await expect(run(fixture.args, undefined, async () => ({ check: { code: 0, stdout: "", stderr: "", timedOut: false, interrupted: false, signal: null } }), () => ({})))
      .rejects.toThrow("host-persisted launch snapshot");
  });

  it("stops the Issue when policy changes while required verification is running", async () => {
    const fixture = verificationAttempt();
    let stopped = false;
    const result = await run(fixture.args, undefined, async () => {
      writeFileSync(path.join(fixture.args.stateDir, "projects.json"), JSON.stringify({ projects: [{ id: "demo", githubRepo: "owner/repo", checkCommand: "false" }] }));
      return { check: { code: 0, stdout: "", stderr: "", timedOut: false, interrupted: false, signal: null } };
    }, () => ({}), () => { stopped = true; });

    expect({ status: result.status, stopped }).toEqual({ status: "blocked", stopped: true });
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
