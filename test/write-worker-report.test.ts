import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const helperPath = "extensions/deadloop/automations/write-worker-report.cts";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return String(result.stdout).trim();
}

type AttemptFixture = {
  root: string;
  repoPath: string;
  worktreePath: string;
  runDir: string;
  attemptRecord: string;
  promiseFile: string;
  record: Record<string, unknown>;
  inputHead: string;
};

function commitFixtureRepository(repoPath: string, file: string, contents: string): string {
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "--initial-branch", "main"]);
  git(repoPath, ["config", "user.email", "fixture@example.com"]);
  git(repoPath, ["config", "user.name", "Fixture"]);
  writeFileSync(path.join(repoPath, file), contents);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "fixture commit"]);
  return git(repoPath, ["rev-parse", "HEAD^{commit}"]);
}

function buildWorkerAttemptFixture(
  options: { recordedWorktreePath?: string; phase?: string; role?: string; branch?: string } = {},
): AttemptFixture {
  const root = mkdtempSync(path.join(tmpdir(), "deadloop-writeworker-"));
  const repoPath = path.join(root, "repo");
  const inputHead = commitFixtureRepository(repoPath, "README.md", "base\n");
  const branch = options.branch || "agent/issue-12-fixture";
  const worktreePath = path.join(root, "worktrees", branch.replace(/\//g, "-"));
  git(repoPath, ["worktree", "add", worktreePath, "-b", branch]);
  const runDir = path.join(root, "state", "runs", "attempt-fixture-1");
  fs.mkdirSync(runDir, { recursive: true });
  const phase = options.phase || "agent_started";
  const terminalPhase = ["launch_failed", "abandoned", "authority_released", "workspace_closed"].includes(phase);
  const record: Record<string, unknown> = {
    attemptId: "attempt-fixture-1",
    launchUuid: "launch-fixture-1",
    project: "demo",
    repository: "octo/demo",
    role: options.role || "worker",
    target: { kind: "issue", number: 12 },
    inputRevision: { head: inputHead },
    branch,
    worktreePath: options.recordedWorktreePath || worktreePath,
    agentName: "demo-issue-12-worker",
    workspaceLabel: "demo-issue-12-worker",
    promptFile: path.join(runDir, "worker-prompt.md"),
    promiseFile: path.join(runDir, "promise.json"),
    phase,
    lastSuccessfulPhase: terminalPhase ? "agent_started" : phase,
  };
  fs.writeFileSync(path.join(runDir, "attempt.json"), `${JSON.stringify(record)}\n`);
  return {
    root,
    repoPath,
    worktreePath,
    runDir,
    attemptRecord: path.join(runDir, "attempt.json"),
    promiseFile: path.join(runDir, "promise.json"),
    record,
    inputHead,
  };
}

function cleanupFixture(fixture: AttemptFixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

function completePayload(): string {
  return JSON.stringify({
    status: "complete",
    summary: "Implemented the feature and validated it.",
    evidence: { validations: ["npm test passed"] },
  });
}

function blockedPayload(): string {
  return JSON.stringify({
    status: "blocked",
    summary: "The environment cannot run the check command.",
    result: { reason: "fix_environment", explanation: "node is missing", recovery: "install node 22" },
  });
}

function runWriter(
  attemptRecord: string,
  payload: string,
  options: { payloadFile?: boolean } = {},
): { code: number | null; stdout: string; stderr: string } {
  const args = [helperPath, "--attempt-record", attemptRecord];
  const spawnOptions: Parameters<typeof spawnSync>[2] & { input?: string } = { encoding: "utf8" };
  if (options.payloadFile) {
    const payloadFile = path.join(mkdtempSync(path.join(tmpdir(), "deadloop-writeworker-payload-")), "payload.json");
    writeFileSync(payloadFile, payload);
    args.push("--payload", payloadFile);
  } else {
    spawnOptions.input = payload;
  }
  const result = spawnSync("node", args, spawnOptions);
  return { code: result.status, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

function commitInWorktree(fixture: AttemptFixture, message: string): string {
  writeFileSync(path.join(fixture.worktreePath, "feature.txt"), `${message}\n`);
  git(fixture.worktreePath, ["add", "."]);
  git(fixture.worktreePath, ["commit", "-m", message]);
  return git(fixture.worktreePath, ["rev-parse", "HEAD^{commit}"]);
}

describe("write worker report", () => {
  it("injects the attempt identity into a complete report built from an identity-free payload", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      runWriter(fixture.attemptRecord, completePayload());
      const written = JSON.parse(fs.readFileSync(fixture.promiseFile, "utf8"));
      expect(written.attemptId).toBe("attempt-fixture-1");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("records the worktree HEAD as the complete report outputRevision", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const head = commitInWorktree(fixture, "implement the feature");
      runWriter(fixture.attemptRecord, completePayload());
      const written = JSON.parse(fs.readFileSync(fixture.promiseFile, "utf8"));
      expect(written.result.outputRevision).toBe(head);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("produces a complete report the existing binding validator accepts as strong", () => {
    const { validateCompletionReportBinding } = require("../src/attempt-lifecycle-runtime.cjs");
    const fixture = buildWorkerAttemptFixture();
    try {
      commitInWorktree(fixture, "implement the feature");
      runWriter(fixture.attemptRecord, completePayload());
      const written = JSON.parse(fs.readFileSync(fixture.promiseFile, "utf8"));
      expect(validateCompletionReportBinding(JSON.parse(fs.readFileSync(fixture.attemptRecord, "utf8")), written).strength).toBe("strong");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("produces a blocked report the existing binding validator accepts as strong", () => {
    const { validateCompletionReportBinding } = require("../src/attempt-lifecycle-runtime.cjs");
    const fixture = buildWorkerAttemptFixture();
    try {
      runWriter(fixture.attemptRecord, blockedPayload());
      const written = JSON.parse(fs.readFileSync(fixture.promiseFile, "utf8"));
      expect(validateCompletionReportBinding(JSON.parse(fs.readFileSync(fixture.attemptRecord, "utf8")), written).strength).toBe("strong");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it.each([
    "attemptId",
    "role",
    "target",
    "repository",
    "inputRevision",
    "outputRevision",
    "worktree",
    "worktreePath",
    "promiseFile",
  ])("refuses a blocked payload that specifies %s at the top level", (field) => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const decorated = { ...JSON.parse(blockedPayload()), result: { reason: "add_request", explanation: "e", recovery: "r" }, [field]: "injected" };
      const run = runWriter(fixture.attemptRecord, JSON.stringify(decorated));
      expect(run.code).toBe(1);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it.each([
    ["repository inside the blocked result", (payload: Record<string, unknown>) => ({
      ...payload,
      result: { ...(payload.result as Record<string, unknown>), repository: "octo/demo" },
    })],
    ["outputRevision inside a complete result", (_payload: Record<string, unknown>) => ({
      status: "complete",
      summary: "done",
      result: { outputRevision: "b".repeat(40) },
      evidence: { validations: ["npm test passed"] },
    })],
  ])("refuses a payload that nests %s", (_field, decorate: (payload: Record<string, unknown>) => unknown) => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const run = runWriter(fixture.attemptRecord, JSON.stringify(decorate(JSON.parse(blockedPayload()))));
      expect(run.code).toBe(1);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("identifies the injected attemptId field in the refusal", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const decorated = { ...JSON.parse(blockedPayload()), attemptId: "attempt-fixture-1" };
      const run = runWriter(fixture.attemptRecord, JSON.stringify(decorated));
      expect(JSON.parse(run.stdout)).toMatchObject({ status: "refused", error: "forbidden_payload_fields", fields: ["attemptId"] });
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("leaves the canonical promise unwritten when the payload names an injected field", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const decorated = { ...JSON.parse(blockedPayload()), attemptId: "attempt-fixture-1" };
      runWriter(fixture.attemptRecord, JSON.stringify(decorated));
      expect(fs.existsSync(fixture.promiseFile)).toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("names the missing summary field in the refusal", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const payload = { status: "complete", evidence: { validations: ["npm test passed"] } };
      const run = runWriter(fixture.attemptRecord, JSON.stringify(payload));
      expect(JSON.parse(run.stdout)).toMatchObject({ error: "missing_payload_field", fields: ["summary"] });
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("names the missing complete validation evidence in the refusal", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const payload = { status: "complete", summary: "done", evidence: {} };
      const run = runWriter(fixture.attemptRecord, JSON.stringify(payload));
      expect(JSON.parse(run.stdout)).toMatchObject({ error: "missing_payload_field", fields: ["evidence.validations"] });
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("names the missing blocked explanation in the refusal", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const payload = { status: "blocked", summary: "stuck", result: { reason: "add_request", recovery: "split the issue" } };
      const run = runWriter(fixture.attemptRecord, JSON.stringify(payload));
      expect(JSON.parse(run.stdout)).toMatchObject({ error: "missing_payload_field", fields: ["result.explanation"] });
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("names the missing blocked guidance when neither recovery nor informationRequest is given", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const payload = { status: "blocked", summary: "stuck", result: { reason: "add_request", explanation: "no split possible" } };
      const run = runWriter(fixture.attemptRecord, JSON.stringify(payload));
      expect(JSON.parse(run.stdout)).toMatchObject({ error: "missing_payload_field", fields: ["result.recovery"] });
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("names a blocked reason outside the stop codes in the refusal", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const payload = { status: "blocked", summary: "stuck", result: { reason: "model_was_confused", explanation: "e", recovery: "r" } };
      const run = runWriter(fixture.attemptRecord, JSON.stringify(payload));
      expect(JSON.parse(run.stdout)).toMatchObject({ error: "invalid_blocked_reason", fields: ["result.reason"] });
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("names a non-string blocked guidance field in the refusal", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const payload = { status: "blocked", summary: "stuck", result: { reason: "add_request", explanation: "e", recovery: { steps: 1 }, informationRequest: "which split?" } };
      const run = runWriter(fixture.attemptRecord, JSON.stringify(payload));
      expect(JSON.parse(run.stdout)).toMatchObject({ error: "invalid_payload_field", fields: ["result.recovery"] });
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("refuses to write when the recorded worktree does not exist", () => {
    const fixture = buildWorkerAttemptFixture({ recordedWorktreePath: path.join("/nonexistent", "worktree") });
    try {
      const run = runWriter(fixture.attemptRecord, completePayload());
      expect(JSON.parse(run.stdout).error).toBe("worktree_missing");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("refuses to write when the recorded worktree points to another repository", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const other = mkdtempSync(path.join(tmpdir(), "deadloop-writeworker-other-"));
      const otherRepo = path.join(other, "elsewhere");
      commitFixtureRepository(otherRepo, "unrelated.txt", "other\n");
      const decorated = { ...fixture.record, worktreePath: otherRepo };
      fs.writeFileSync(fixture.attemptRecord, `${JSON.stringify(decorated)}\n`);
      const run = runWriter(fixture.attemptRecord, completePayload());
      expect(JSON.parse(run.stdout).error).toBe("worktree_branch_not_checked_out");
      rmSync(other, { recursive: true, force: true });
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("refuses to write when another repository holds the branch but not the input revision", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const other = mkdtempSync(path.join(tmpdir(), "deadloop-writeworker-colliding-"));
      const otherRepo = path.join(other, "elsewhere");
      const otherHead = commitFixtureRepository(otherRepo, "unrelated.txt", "other\n");
      git(otherRepo, ["worktree", "add", path.join(other, "wt"), "-b", String(fixture.record.branch), otherHead]);
      const decorated = { ...fixture.record, worktreePath: path.join(other, "wt") };
      fs.writeFileSync(fixture.attemptRecord, `${JSON.stringify(decorated)}\n`);
      const run = runWriter(fixture.attemptRecord, completePayload());
      expect(JSON.parse(run.stdout).error).toBe("worktree_missing_input_revision");
      rmSync(other, { recursive: true, force: true });
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("refuses to write when the worktree HEAD does not resolve to one commit", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      git(fixture.repoPath, ["update-ref", "-d", `refs/heads/${fixture.record.branch}`]);
      const run = runWriter(fixture.attemptRecord, completePayload());
      expect(JSON.parse(run.stdout).error).toBe("head_not_resolvable");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("leaves the canonical promise unwritten when the worktree observation fails", () => {
    const fixture = buildWorkerAttemptFixture({ recordedWorktreePath: path.join("/nonexistent", "worktree") });
    try {
      runWriter(fixture.attemptRecord, completePayload());
      expect(fs.existsSync(fixture.promiseFile)).toBe(false);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("keeps an existing valid promise intact when a refusal fires before the atomic replacement", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      commitInWorktree(fixture, "implement the feature");
      runWriter(fixture.attemptRecord, completePayload());
      const before = fs.readFileSync(fixture.promiseFile, "utf8");
      runWriter(fixture.attemptRecord, JSON.stringify({ status: "complete", summary: "no evidence" }));
      expect(fs.readFileSync(fixture.promiseFile, "utf8")).toBe(before);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("rejects an output destination flag so the promiseFile stays the record's own", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const result = spawnSync("node", [helperPath, "--attempt-record", fixture.attemptRecord, "--out", "/tmp/elsewhere.json"], { encoding: "utf8", input: completePayload() });
      expect(result.status).not.toBe(0);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("still writes a complete report when the worktree HEAD equals the input revision", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      runWriter(fixture.attemptRecord, completePayload());
      const written = JSON.parse(fs.readFileSync(fixture.promiseFile, "utf8"));
      expect(written.result.outputRevision).toBe(fixture.inputHead);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("refuses to write for an attempt whose role is not worker", () => {
    const fixture = buildWorkerAttemptFixture({ role: "explorer" });
    try {
      const run = runWriter(fixture.attemptRecord, completePayload());
      expect(JSON.parse(run.stdout).error).toBe("attempt_role_not_worker");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("refuses to write once the attempt has already handed its report over", () => {
    const fixture = buildWorkerAttemptFixture({ phase: "report_received" });
    try {
      const run = runWriter(fixture.attemptRecord, completePayload());
      expect(JSON.parse(run.stdout).error).toBe("attempt_phase_not_accepting_report");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("changes nothing but the promise file when the writer succeeds", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const recordBefore = fs.readFileSync(fixture.attemptRecord, "utf8");
      runWriter(fixture.attemptRecord, completePayload());
      expect(fs.readFileSync(fixture.attemptRecord, "utf8")).toBe(recordBefore);
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("writes a report the existing promise reader accepts as a strong complete report", () => {
    const { validatePromise } = require("../extensions/deadloop/automations/extract-worker-promise.cts");
    const fixture = buildWorkerAttemptFixture();
    try {
      commitInWorktree(fixture, "implement the feature");
      runWriter(fixture.attemptRecord, completePayload());
      const read = validatePromise(fixture.promiseFile, fixture.attemptRecord);
      expect(read.evidenceStrength).toBe("strong");
    } finally {
      cleanupFixture(fixture);
    }
  });

  it("accepts the payload from --payload file like from stdin", () => {
    const fixture = buildWorkerAttemptFixture();
    try {
      const run = runWriter(fixture.attemptRecord, completePayload(), { payloadFile: true });
      expect(run.code).toBe(0);
    } finally {
      cleanupFixture(fixture);
    }
  });
});
