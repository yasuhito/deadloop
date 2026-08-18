import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { reviewerFixture, workerFixture } from "./fixtures/attempt-workspace";

const { createHerdrRunner } = require("../src/herdr-runner.ts");

const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-doctor-attempt-"));
const stateDir = path.join(root, "deadloop");
let retainedAttemptDoctorFindings: (...args: any[]) => any[];
let retainedAttemptClaimSnapshot: (...args: any[]) => { claims: unknown[]; ownershipAmbiguous: boolean };
let reconcilePersistedAttemptJournals: (...args: any[]) => Promise<boolean>;

beforeAll(async () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.resetModules();
  // @ts-expect-error Vitest transforms this runtime extension import.
  ({ retainedAttemptDoctorFindings, retainedAttemptClaimSnapshot, reconcilePersistedAttemptJournals } = await import("../extensions/deadloop/index"));
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function resetRuns() { rmSync(path.join(stateDir, "runs"), { recursive: true, force: true }); mkdirSync(path.join(stateDir, "runs"), { recursive: true }); }
function writeAttempt(record: any, report?: unknown) {
  resetRuns();
  const runDir = path.join(stateDir, "runs", "one"); mkdirSync(runDir);
  const promiseFile = path.join(runDir, "promise.json");
  writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({ ...record, project: "demo", promiseFile }));
  if (report !== undefined) writeFileSync(promiseFile, typeof report === "string" ? report : JSON.stringify(report));
  return promiseFile;
}
function classify(record: any, report: unknown, workspaces: any[] = [], agents: any[] = []) {
  writeAttempt(record, report);
  return retainedAttemptDoctorFindings({ id: "demo", githubRepo: "octo/demo" }, workspaces, agents)[0]?.title;
}

describe("attempt workspace doctor classifications", () => {
  it("classifies an active attempt", () => {
    const record = { ...workerFixture().record, phase: "agent_started", lastSuccessfulPhase: "agent_started", outputRevision: undefined };
    writeAttempt(record, undefined);
    expect(retainedAttemptDoctorFindings({ id: "demo", githubRepo: "octo/demo" }, [{ workspaceId: record.workspaceId, worktreePath: record.worktreePath }], [{ name: record.agentName, status: "working" }])[0].title).toContain("active");
  });
  it("proves doctor ownership from a normalized 0.8.0 nested WorkspaceInfo worktree", () => {
    const payload = JSON.parse(readFileSync("test/fixtures/herdr-workspace-list.json", "utf8"));
    const workspaces = createHerdrRunner({ runJson: () => payload, runText: () => "" }).listWorkspaces();
    const fixture = workerFixture();
    const record = {
      ...fixture.record,
      workspaceId: "w-issue-12",
      worktreePath: "/worktrees/issue-12",
      phase: "agent_started",
      lastSuccessfulPhase: "agent_started",
      outputRevision: undefined,
    };
    expect(classify(record, fixture.report, workspaces)).toContain("persistence_unconfirmed");
  });
  it("classifies a missing report", () => {
    const record = workerFixture().record; record.phase = "agent_started"; record.lastSuccessfulPhase = "agent_started"; delete record.outputRevision;
    expect(classify(record, undefined, [{ workspaceId: record.workspaceId, worktreePath: record.worktreePath }])).toContain("missing_report");
  });
  it("classifies blocked evidence", () => {
    const fixture = workerFixture(); const report = { ...fixture.report, status: "blocked", result: { reason: "unsafe", explanation: "stopped", recovery: "inspect" }, evidence: {} };
    expect(classify(fixture.record, report, [{ workspaceId: fixture.record.workspaceId, worktreePath: fixture.record.worktreePath }])).toContain("blocked");
  });
  it("classifies a human-required review as awaiting its handoff, not as intentionally retained", () => {
    const fixture = reviewerFixture("approved"); const report = { ...fixture.report, result: { ...fixture.report.result, outcome: "human_required" } };
    const record = { ...fixture.record, phase: "agent_started", lastSuccessfulPhase: "agent_started" };
    expect(classify(record, report, [{ workspaceId: record.workspaceId, worktreePath: record.worktreePath }])).toContain("persistence_unconfirmed");
  });
  it("classifies malformed report JSON", () => {
    const fixture = workerFixture();
    expect(classify(fixture.record, "malformed", [{ workspaceId: fixture.record.workspaceId, worktreePath: fixture.record.worktreePath }])).toContain("malformed_report");
  });
  it("classifies unconfirmed GitHub persistence", () => {
    const fixture = workerFixture();
    expect(classify(fixture.record, fixture.report, [{ workspaceId: fixture.record.workspaceId, worktreePath: fixture.record.worktreePath }])).toContain("persistence_unconfirmed");
  });
  it("classifies a valid terminal V1 report at agent_started as persistence unconfirmed", () => {
    const fixture = workerFixture();
    const record = { ...fixture.record, phase: "agent_started", lastSuccessfulPhase: "agent_started", outputRevision: undefined };
    expect(classify(record, fixture.report, [{ workspaceId: record.workspaceId, worktreePath: record.worktreePath }])).toContain("persistence_unconfirmed");
  });
  it("classifies launch failure", () => {
    const fixture = workerFixture(); const record = { ...fixture.record, phase: "launch_failed", lastSuccessfulPhase: "agent_started", launchError: "failed", outputRevision: undefined };
    expect(classify(record, undefined)).toContain("launch_failed");
  });
  it("offers the supported abandonment command when launch-failure recovery is proven safe", () => {
    const fixture = reviewerFixture("approved");
    const record = { ...fixture.record, phase: "launch_failed", lastSuccessfulPhase: "workspace_opened", launchError: "failed", outputRevision: undefined };
    writeAttempt(record, undefined);
    const findings = retainedAttemptDoctorFindings(
      { id: "demo", githubRepo: "octo/demo", labels: { ready: "ready-for-agent", implement: "agent:implement", inProgress: "agent:in-progress", review: "agent:review", blocked: "agent:blocked", human: "ready-for-human" } },
      [{ workspaceId: record.workspaceId, worktreePath: record.worktreePath, tabCount: 1, paneCount: 1 }],
      [],
      {
        worktrees: [{ branch: record.branch, path: record.worktreePath, workspaceId: record.workspaceId }],
        gitStatuses: { [record.worktreePath]: "" },
        gitHeads: { [record.worktreePath]: record.inputRevision.head },
        openPrs: [{ number: record.target.number, headRefName: record.branch, headRefOid: record.inputRevision.head, labels: ["agent:review", "agent:in-progress"] }],
      },
    );
    expect(findings[0].commands).toEqual([`/deadloop-abandon-attempt ${record.attemptId}`]);
  });
  it("requires manual review instead of a partial recovery command when an agent owns the pane", () => {
    const fixture = reviewerFixture("approved");
    const record = { ...fixture.record, phase: "launch_failed", lastSuccessfulPhase: "workspace_opened", launchError: "failed", outputRevision: undefined };
    writeAttempt(record, undefined);
    const findings = retainedAttemptDoctorFindings(
      { id: "demo", githubRepo: "octo/demo", labels: { ready: "ready-for-agent", implement: "agent:implement", inProgress: "agent:in-progress", review: "agent:review", blocked: "agent:blocked", human: "ready-for-human" } },
      [{ workspaceId: record.workspaceId, worktreePath: record.worktreePath, tabCount: 1, paneCount: 1 }],
      [{ name: record.agentName, paneId: record.rootPaneId, status: "working" }],
      {},
    );
    expect({ commands: findings[0].commands, summary: findings[0].summary }).toEqual({ commands: [], summary: expect.stringContaining("manual review required") });
  });
  it("classifies cleanup pending", () => {
    const fixture = workerFixture(); const record = { ...fixture.record, phase: "github_persisted", lastSuccessfulPhase: "github_persisted" };
    expect(classify(record, undefined)).toContain("cleanup_pending");
  });
  it("classifies workspace ownership mismatch", () => {
    const fixture = workerFixture();
    expect(classify(fixture.record, fixture.report, [])).toContain("ownership_mismatch");
  });
  it("surfaces a malformed journal", () => {
    resetRuns(); const runDir = path.join(stateDir, "runs", "one"); mkdirSync(runDir); writeFileSync(path.join(runDir, "attempt.json"), "malformed");
    expect(retainedAttemptDoctorFindings({ id: "demo", githubRepo: "octo/demo" }, [], [])[0].title).toContain("malformed_journal");
  });
  it("marks retained claim ownership ambiguous for a malformed journal", () => {
    resetRuns(); const runDir = path.join(stateDir, "runs", "one"); mkdirSync(runDir); writeFileSync(path.join(runDir, "attempt.json"), "malformed");
    expect(retainedAttemptClaimSnapshot({ id: "demo", githubRepo: "octo/demo" }).ownershipAmbiguous).toBe(true);
  });
  it("fails startup reconciliation closed for a malformed journal", async () => {
    resetRuns(); const runDir = path.join(stateDir, "runs", "one"); mkdirSync(runDir); writeFileSync(path.join(runDir, "attempt.json"), "malformed");
    expect(await reconcilePersistedAttemptJournals({}, { id: "demo", githubRepo: "octo/demo" })).toBe(false);
  });
  it("passes the complete configured managed reviewer label set separately during restart cleanup", async () => {
    const fixture = reviewerFixture("approved");
    writeAttempt({ ...fixture.record, autoMergePolicy: false, phase: "github_persisted", lastSuccessfulPhase: "github_persisted" }, undefined);
    let commandArgs: string[] = [];
    await reconcilePersistedAttemptJournals({ exec: async (_command: string, args: string[]) => { commandArgs = args; return { code: 0, stdout: '{"action":"done"}' }; } }, {
      id: "demo", githubRepo: "octo/demo", repoPath: "/repo", enabledAt: 1, autoMerge: true,
      labels: { ready: "ready", implement: "implement", inProgress: "progress", review: "review", blocked: "blocked", human: "human" },
    });
    expect(commandArgs.flatMap((value, index) => value === "--managed-label" ? [commandArgs[index + 1]] : [])).toEqual([
      "review", "progress", "blocked", "human",
    ]);
  });

  it("uses the selected reviewer's recorded automatic-merge policy during restart cleanup", async () => {
    const fixture = reviewerFixture("approved");
    writeAttempt({ ...fixture.record, autoMergePolicy: false, phase: "github_persisted", lastSuccessfulPhase: "github_persisted" }, undefined);
    let commandArgs: string[] = [];
    await reconcilePersistedAttemptJournals({ exec: async (_command: string, args: string[]) => { commandArgs = args; return { code: 0, stdout: '{"action":"done"}' }; } }, {
      id: "demo", githubRepo: "octo/demo", repoPath: "/repo", enabledAt: 1, autoMerge: true,
      labels: { ready: "ready", implement: "implement", inProgress: "progress", review: "review", blocked: "blocked", human: "human" },
    });
    expect(commandArgs.slice(commandArgs.indexOf("--auto-merge"), commandArgs.indexOf("--auto-merge") + 2)).toEqual(["--auto-merge", "false"]);
  });
});
