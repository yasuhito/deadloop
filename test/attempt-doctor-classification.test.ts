import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { branchUpdateFixture, reviewerFixture, workerFixture } from "./fixtures/attempt-workspace";

const { createHerdrRunner } = require("../src/herdr-runner.cts");

const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-doctor-attempt-"));
const stateDir = path.join(root, "deadloop");
let observeMonitorHandoffDisposition: (record: unknown, kind: unknown, deps: unknown) => { action: string };
let retainedAttemptDoctorFindings: (...args: any[]) => any[];
let retainedAttemptTargetsSnapshot: (...args: any[]) => { targets: unknown[]; targetsAmbiguous: boolean };
let reconcilePersistedAttemptJournals: (...args: any[]) => Promise<boolean>;

beforeAll(async () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.resetModules();
  // @ts-expect-error Vitest transforms this runtime extension import.
  ({ retainedAttemptDoctorFindings, retainedAttemptTargetsSnapshot, reconcilePersistedAttemptJournals } = await import("../extensions/deadloop/index"));
  ({ observeMonitorHandoffDisposition } = require("../src/monitor-handoff-observation.cts"));
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
    expect(retainedAttemptDoctorFindings({ id: "demo", githubRepo: "octo/demo" }, [{ workspaceId: record.workspaceId, worktreePath: record.worktreePath }], [{ name: record.agentName, paneId: record.rootPaneId, cwd: record.worktreePath, status: "working" }])[0].title).toContain("active");
  });
  it("classifies an attempt whose agent awaits input as active", () => {
    const record = { ...workerFixture().record, phase: "agent_started", lastSuccessfulPhase: "agent_started", outputRevision: undefined };
    writeAttempt(record, undefined);
    expect(retainedAttemptDoctorFindings({ id: "demo", githubRepo: "octo/demo" }, [{ workspaceId: record.workspaceId, worktreePath: record.worktreePath }], [{ name: record.agentName, paneId: record.rootPaneId, cwd: record.worktreePath, status: "idle" }])[0].title).toContain("active");
  });
  it("settles a branch-update monitor after a bound blocked report", () => {
    const fixture = branchUpdateFixture();
    const promiseFile = writeAttempt(
      {
        ...fixture.record,
        phase: "agent_started",
        lastSuccessfulPhase: "agent_started",
        outputRevision: undefined,
      },
      {
        ...fixture.report,
        status: "blocked",
        summary: "Required verification failed",
        result: {
          reason: "required_verification_failed",
          explanation: "npm test failed",
          recovery: "fix the failing tests and request a new attempt",
        },
        evidence: {},
      },
    );

    const record = JSON.parse(readFileSync(path.join(path.dirname(promiseFile), "attempt.json"), "utf8"));
    expect(observeMonitorHandoffDisposition(record, "branch-update", {
      runner: { listAgents: () => [], listWorkspaces: () => [], listWorktrees: () => [] },
      readTerminalEvidence: () => "",
    }).action).toBe("settled");
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
  it("shows the deterministic recovery command for an unmonitored completed report at agent_started", () => {
    const fixture = workerFixture();
    const record = { ...fixture.record, phase: "agent_started", lastSuccessfulPhase: "agent_started", outputRevision: undefined };
    writeAttempt(record, fixture.report);
    const findings = retainedAttemptDoctorFindings(
      { id: "demo", githubRepo: "octo/demo", labels: { ready: "ready-for-agent", implement: "agent:implement", inProgress: "agent:in-progress", review: "agent:review", blocked: "agent:blocked", human: "ready-for-human" } },
      [{ workspaceId: record.workspaceId, worktreePath: record.worktreePath, tabCount: 1, paneCount: 1 }],
      [],
      {},
    );
    expect(findings[0].commands[0]).toContain("reconcile-report-received-attempt.cts");
  });
  it("requires manual review but still names an observation command when an agent owns the pane", () => {
    const fixture = reviewerFixture("approved");
    const record = { ...fixture.record, phase: "launch_failed", lastSuccessfulPhase: "workspace_opened", launchError: "failed", outputRevision: undefined };
    writeAttempt(record, undefined);
    const findings = retainedAttemptDoctorFindings(
      { id: "demo", githubRepo: "octo/demo", labels: { ready: "ready-for-agent", implement: "agent:implement", inProgress: "agent:in-progress", review: "agent:review", blocked: "agent:blocked", human: "ready-for-human" } },
      [{ workspaceId: record.workspaceId, worktreePath: record.worktreePath, tabCount: 1, paneCount: 1 }],
      [{ name: record.agentName, paneId: record.rootPaneId, status: "working" }],
      {},
    );
    expect(findings[0].summary).toContain("manual review required");
    expect(findings[0].commands).toEqual(["herdr agent list"]);
  });

  it("names the retreat commands for a launch failure that left its workspace and checkout", () => {
    const fixture = workerFixture();
    const record = { ...fixture.record, phase: "launch_failed", lastSuccessfulPhase: "workspace_opened", launchError: "failed", outputRevision: undefined };
    writeAttempt(record, undefined);
    const findings = retainedAttemptDoctorFindings(
      { id: "demo", githubRepo: "octo/demo", labels: { ready: "ready-for-agent", implement: "agent:implement", inProgress: "agent:in-progress", review: "agent:review", blocked: "agent:blocked", human: "ready-for-human" } },
      [{ workspaceId: record.workspaceId, worktreePath: record.worktreePath, tabCount: 1, paneCount: 1 }],
      [],
      {
        worktrees: [{ branch: record.branch, path: record.worktreePath }],
        gitStatuses: { [record.worktreePath]: "" },
      },
    );
    expect(findings[0].commands).toEqual([
      `herdr workspace close '${record.workspaceId}'`,
      `git worktree remove '${record.worktreePath}'`,
      `git branch -D '${record.branch}'`,
    ]);
  });

  it("falls back to the fresh-request command when a launch failure left nothing behind", () => {
    const fixture = workerFixture();
    const record = { ...fixture.record, phase: "launch_failed", lastSuccessfulPhase: "workspace_opened", launchError: "failed", outputRevision: undefined };
    writeAttempt(record, undefined);
    const findings = retainedAttemptDoctorFindings(
      { id: "demo", githubRepo: "octo/demo", labels: { ready: "ready-for-agent", implement: "agent:implement", inProgress: "agent:in-progress", review: "agent:review", blocked: "agent:blocked", human: "ready-for-human" } },
      [],
      [],
      {},
    );
    expect(findings[0].commands).toEqual([`gh issue edit ${record.target.number} --add-label 'agent:implement'`]);
  });

  it("observes the remnants of a released never-launched attempt", () => {
    const fixture = workerFixture();
    const record = {
      ...fixture.record,
      phase: "authority_released",
      lastSuccessfulPhase: "workspace_opened",
      launchError: "worktree agent/issue-42 already exists before create",
      outputRevision: undefined,
      authorityRelease: { reason: "never_launched", releasedAt: "2026-08-30T00:00:00Z" },
    };
    writeAttempt(record, undefined);
    const findings = retainedAttemptDoctorFindings(
      { id: "demo", githubRepo: "octo/demo", labels: { ready: "ready-for-agent", implement: "agent:implement", inProgress: "agent:in-progress", review: "agent:review", blocked: "agent:blocked", human: "ready-for-human" } },
      [],
      [],
      { worktrees: [{ branch: record.branch, path: record.worktreePath }], gitStatuses: { [record.worktreePath]: "" } },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain("launch_failed");
    expect(findings[0].summary).toContain("never_launched");
    expect(findings[0].summary).toContain("linked worktree");
    expect(findings[0].commands).toContain(`git worktree remove '${record.worktreePath}'`);
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
  it("marks retained targets ambiguous for a malformed journal", () => {
    resetRuns(); const runDir = path.join(stateDir, "runs", "one"); mkdirSync(runDir); writeFileSync(path.join(runDir, "attempt.json"), "malformed");
    expect(retainedAttemptTargetsSnapshot({ id: "demo", githubRepo: "octo/demo" }).targetsAmbiguous).toBe(true);
  });
  it("fails startup reconciliation closed for a malformed journal", async () => {
    resetRuns(); const runDir = path.join(stateDir, "runs", "one"); mkdirSync(runDir); writeFileSync(path.join(runDir, "attempt.json"), "malformed");
    expect(await reconcilePersistedAttemptJournals({}, { id: "demo", githubRepo: "octo/demo" })).toBe(false);
  });
  it("routes retained explorer cleanup through deterministic Issue completion", async () => {
    const fixture = workerFixture();
    const record = {
      ...fixture.record,
      role: "explorer",
      phase: "github_persisted",
      lastSuccessfulPhase: "github_persisted",
      outputRevision: undefined,
      requiredVerification: undefined,
      agentRequest: { role: "explorer", label: "explore", eventId: "request-1" },
    };
    writeAttempt(record, undefined);
    let commandArgs: string[] = [];
    await reconcilePersistedAttemptJournals({ exec: async (_command: string, args: string[]) => { commandArgs = args; return { code: 0, stdout: '{"action":"done"}' }; } }, {
      id: "demo", githubRepo: "octo/demo", repoPath: "/repo", enabledAt: 1,
      labels: { ready: "ready", explore: "explore", implement: "implement", inProgress: "progress", review: "review", blocked: "blocked", human: "human" },
    });
    expect(commandArgs[0]).toMatch(/complete-issue-exploration\.cts$/);
  });

  it("reports successful explorer worktree cleanup pending after workspace closure", () => {
    const fixture = workerFixture();
    const record = {
      ...fixture.record,
      role: "explorer",
      phase: "workspace_closed",
      lastSuccessfulPhase: "workspace_closed",
      outputRevision: undefined,
      requiredVerification: undefined,
      agentRequest: { role: "explorer", label: "explore", eventId: "request-1" },
    };
    const promiseFile = writeAttempt(record, undefined);
    writeFileSync(path.join(path.dirname(promiseFile), "exploration-outcome.json"), JSON.stringify({
      schemaVersion: 1,
      attemptId: record.attemptId,
      requestEventId: "request-1",
      outcome: "persisted",
    }));
    expect(retainedAttemptDoctorFindings({ id: "demo", githubRepo: "octo/demo" }, [], [])[0]?.title)
      .toContain("cleanup_pending");
  });

  it("retries successful explorer worktree cleanup after workspace closure", async () => {
    const fixture = workerFixture();
    const record = {
      ...fixture.record,
      role: "explorer",
      phase: "workspace_closed",
      lastSuccessfulPhase: "workspace_closed",
      outputRevision: undefined,
      requiredVerification: undefined,
      agentRequest: { role: "explorer", label: "explore", eventId: "request-1" },
    };
    const promiseFile = writeAttempt(record, undefined);
    writeFileSync(path.join(path.dirname(promiseFile), "exploration-outcome.json"), JSON.stringify({
      schemaVersion: 1,
      attemptId: record.attemptId,
      requestEventId: "request-1",
      outcome: "persisted",
    }));
    let commandArgs: string[] = [];
    await reconcilePersistedAttemptJournals({ exec: async (_command: string, args: string[]) => { commandArgs = args; return { code: 0, stdout: '{"action":"done"}' }; } }, {
      id: "demo", githubRepo: "octo/demo", repoPath: "/repo", enabledAt: 1,
      labels: { ready: "ready", explore: "explore", implement: "implement", inProgress: "progress", review: "review", blocked: "blocked", human: "human" },
    });
    expect(commandArgs[0]).toMatch(/complete-issue-exploration\.cts$/);
  });

  it("stops routing explorer cleanup after a bound cleanup receipt is persisted", async () => {
    const fixture = workerFixture();
    const record = {
      ...fixture.record,
      role: "explorer",
      phase: "workspace_closed",
      lastSuccessfulPhase: "workspace_closed",
      outputRevision: undefined,
      requiredVerification: undefined,
      agentRequest: { role: "explorer", label: "explore", eventId: "request-1" },
    };
    const promiseFile = writeAttempt(record, undefined);
    const runDir = path.dirname(promiseFile);
    writeFileSync(path.join(runDir, "exploration-outcome.json"), JSON.stringify({
      schemaVersion: 1,
      attemptId: record.attemptId,
      requestEventId: "request-1",
      outcome: "persisted",
    }));
    let dispatches = 0;
    const pi = { exec: async () => {
      dispatches += 1;
      writeFileSync(path.join(runDir, "exploration-worktree-cleaned.json"), JSON.stringify({
        schemaVersion: 1,
        attemptId: record.attemptId,
        requestEventId: "request-1",
        branch: record.branch,
        worktreePath: record.worktreePath,
      }));
      return { code: 0, stdout: '{"action":"done"}' };
    } };
    const project = {
      id: "demo", githubRepo: "octo/demo", repoPath: "/repo", enabledAt: 1,
      labels: { ready: "ready", explore: "explore", implement: "implement", inProgress: "progress", review: "review", blocked: "blocked", human: "human" },
    };
    await reconcilePersistedAttemptJournals(pi, project);
    await reconcilePersistedAttemptJournals(pi, project);
    expect(dispatches).toBe(1);
  });

  it("routes a blocked explorer report through deterministic Issue completion", async () => {
    const fixture = workerFixture();
    const record = {
      ...fixture.record,
      role: "explorer",
      phase: "agent_started",
      lastSuccessfulPhase: "agent_started",
      outputRevision: undefined,
      requiredVerification: undefined,
      agentRequest: { role: "explorer", label: "explore", eventId: "request-1" },
    };
    const report = {
      schemaVersion: 1,
      role: "explorer",
      status: "blocked",
      attemptId: record.attemptId,
      target: { ...record.target, repository: record.repository },
      inputRevision: record.inputRevision,
      summary: "blocked",
      result: { reason: "blocked", explanation: "blocked", recovery: "retry" },
      evidence: {},
    };
    writeAttempt(record, report);
    let commandArgs: string[] = [];
    await reconcilePersistedAttemptJournals({ exec: async (_command: string, args: string[]) => { commandArgs = args; return { code: 0, stdout: '{"action":"done"}' }; } }, {
      id: "demo", githubRepo: "octo/demo", repoPath: "/repo", enabledAt: 1,
      labels: { ready: "ready", explore: "explore", implement: "implement", inProgress: "progress", review: "review", blocked: "blocked", human: "human" },
    });
    expect(commandArgs[0]).toMatch(/complete-issue-exploration\.cts$/);
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
