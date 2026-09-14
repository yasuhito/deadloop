import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const helperPath = "extensions/deadloop/automations/write-explorer-report.cts";

type Fixture = {
  root: string;
  runDir: string;
  attemptRecord: string;
  promiseFile: string;
  record: Record<string, unknown>;
};

function buildFixture(overrides: Record<string, unknown> = {}): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-writeexplorer-"));
  const runDir = path.join(root, "state", "runs", "attempt-explorer-1");
  fs.mkdirSync(runDir, { recursive: true });
  const record = {
    attemptId: "attempt-explorer-1",
    launchUuid: "attempt-explorer-1",
    project: "demo",
    repository: "octo/demo",
    role: "explorer",
    target: { kind: "issue", number: 12 },
    inputRevision: { head: "a".repeat(40) },
    branch: "agent/explore-12-fixture",
    worktreePath: path.join(root, "worktree"),
    agentName: "demo-issue-12-explorer",
    workspaceLabel: "demo-issue-12-explorer",
    promptFile: path.join(runDir, "explorer-prompt.md"),
    promiseFile: path.join(runDir, "promise.json"),
    phase: "agent_started",
    lastSuccessfulPhase: "agent_started",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    rootPaneId: "pane-1",
    agentRequest: { role: "explorer", label: "agent:explore", eventId: "request-1" },
    ...overrides,
  };
  const attemptRecord = path.join(runDir, "attempt.json");
  fs.writeFileSync(attemptRecord, `${JSON.stringify(record)}\n`);
  return { root, runDir, attemptRecord, promiseFile: String(record.promiseFile), record };
}

function completePayload(): Record<string, unknown> {
  return {
    status: "complete",
    summary: "The requested change is localized. The existing seam can be extended. No design decision remains open.",
    result: {
      difficulty: "low",
      relevantFiles: ["src/example.ts"],
      verifiedClaims: ["The seam exists."],
      disprovedClaims: [],
      openQuestions: [],
      approach: "Extend the existing seam.",
    },
    evidence: { commands: ["rg seam src: found src/example.ts"] },
  };
}

function blockedPayload(): Record<string, unknown> {
  return {
    status: "blocked",
    summary: "The issue lacks required information. A safe approach cannot be selected. The author must clarify the contract.",
    result: { reason: "add_request", explanation: "The expected behavior is unspecified.", informationRequest: "Which behavior is intended?" },
  };
}

function runWriter(fixture: Fixture, payload: unknown) {
  const result = spawnSync("node", [helperPath, "--attempt-record", fixture.attemptRecord], {
    encoding: "utf8",
    input: JSON.stringify(payload),
  });
  return { code: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

function cleanup(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

describe("write explorer report", () => {
  it("injects the fixed attempt identity into a complete semantic payload", () => {
    const fixture = buildFixture();
    try {
      runWriter(fixture, completePayload());
      expect(JSON.parse(fs.readFileSync(fixture.promiseFile, "utf8"))).toMatchObject({
        schemaVersion: 1,
        attemptId: "attempt-explorer-1",
        role: "explorer",
        target: { repository: "octo/demo", kind: "issue", number: 12 },
        inputRevision: { head: "a".repeat(40) },
      });
    } finally { cleanup(fixture); }
  });

  it("preserves the complete exploration result and command evidence", () => {
    const fixture = buildFixture();
    const payload = completePayload();
    try {
      runWriter(fixture, payload);
      const report = JSON.parse(fs.readFileSync(fixture.promiseFile, "utf8"));
      expect({ result: report.result, evidence: report.evidence }).toEqual({ result: payload.result, evidence: payload.evidence });
    } finally { cleanup(fixture); }
  });

  it("writes a complete report accepted as strongly bound", () => {
    const { validateCompletionReportBinding } = require("../src/attempt-lifecycle-runtime.cjs");
    const fixture = buildFixture();
    try {
      runWriter(fixture, completePayload());
      const report = JSON.parse(fs.readFileSync(fixture.promiseFile, "utf8"));
      expect(validateCompletionReportBinding(fixture.record, report).strength).toBe("strong");
    } finally { cleanup(fixture); }
  });

  it("writes a complete report accepted by the runtime promise validator", () => {
    const { validatePromise } = require("../extensions/deadloop/automations/extract-worker-promise.cts");
    const fixture = buildFixture();
    try {
      runWriter(fixture, completePayload());
      expect(validatePromise(fixture.promiseFile, fixture.attemptRecord).evidenceStrength).toBe("strong");
    } finally { cleanup(fixture); }
  });

  it("injects identity into a blocked semantic payload", () => {
    const fixture = buildFixture();
    try {
      runWriter(fixture, blockedPayload());
      expect(JSON.parse(fs.readFileSync(fixture.promiseFile, "utf8"))).toMatchObject({ attemptId: "attempt-explorer-1", role: "explorer", status: "blocked", evidence: {} });
    } finally { cleanup(fixture); }
  });

  it.each(["schemaVersion", "attemptId", "role", "target", "repository", "inputRevision", "worktree", "workspace", "runDirectory", "outputPath"])(
    "refuses payload-supplied fixed or delivery field %s",
    (field) => {
      const fixture = buildFixture();
      try {
        const run = runWriter(fixture, { ...completePayload(), [field]: "injected" });
        expect(JSON.parse(run.stdout)).toMatchObject({ error: "forbidden_payload_fields", fields: [field] });
      } finally { cleanup(fixture); }
    },
  );

  it.each([
    ["summary", { ...completePayload(), summary: "Only one sentence." }],
    ["result.difficulty", { ...completePayload(), result: { ...(completePayload().result as object), difficulty: "huge" } }],
    ["result.relevantFiles", { ...completePayload(), result: { ...(completePayload().result as object), relevantFiles: [""] } }],
    ["result.verifiedClaims", { ...completePayload(), result: { ...(completePayload().result as object), verifiedClaims: "claim" } }],
    ["result.disprovedClaims", { ...completePayload(), result: { ...(completePayload().result as object), disprovedClaims: [1] } }],
    ["result.openQuestions", { ...completePayload(), result: { ...(completePayload().result as object), openQuestions: null } }],
    ["evidence.commands", { ...completePayload(), evidence: { commands: [false] } }],
  ])("identifies invalid complete field %s", (field, payload) => {
    const fixture = buildFixture();
    try {
      const run = runWriter(fixture, payload);
      expect(JSON.parse(run.stdout).fields).toEqual([field]);
    } finally { cleanup(fixture); }
  });

  const incompleteBlockedPayloads: [string, Record<string, unknown>][] = [
    ["result.reason", { status: "blocked", summary: "One. Two. Three.", result: { explanation: "why", recovery: "retry" } }],
    ["result.explanation", { status: "blocked", summary: "One. Two. Three.", result: { reason: "add_request", recovery: "retry" } }],
    ["result.recovery", { status: "blocked", summary: "One. Two. Three.", result: { reason: "add_request", explanation: "why" } }],
  ];

  it.each(incompleteBlockedPayloads)("identifies missing blocked field %s", (field, payload) => {
    const fixture = buildFixture();
    try {
      expect(JSON.parse(runWriter(fixture, payload).stdout).fields).toEqual([field]);
    } finally { cleanup(fixture); }
  });

  it.each(incompleteBlockedPayloads)("does not write when blocked field %s is missing", (_field, payload) => {
    const fixture = buildFixture();
    try {
      runWriter(fixture, payload);
      expect(fs.existsSync(fixture.promiseFile)).toBe(false);
    } finally { cleanup(fixture); }
  });

  it.each([
    ["attempt_role_not_explorer", { role: "worker" }],
    ["attempt_target_not_issue", { target: { kind: "pull-request", number: 12 } }],
    ["attempt_request_not_explorer", { agentRequest: { role: "worker", label: "agent:implement", eventId: "request-1" } }],
    ["attempt_phase_not_accepting_report", { phase: "report_received", lastSuccessfulPhase: "report_received" }],
  ])("refuses an invalid attempt with %s", (error, overrides) => {
    const fixture = buildFixture(overrides);
    try {
      expect(JSON.parse(runWriter(fixture, completePayload()).stdout).error).toBe(error);
    } finally { cleanup(fixture); }
  });

  it("refuses a promise path belonging to another attempt", () => {
    const fixture = buildFixture({ promiseFile: path.join(os.tmpdir(), "another-attempt", "promise.json") });
    try {
      expect(JSON.parse(runWriter(fixture, completePayload()).stdout).error).toBe("promise_path_not_canonical");
    } finally { cleanup(fixture); }
  });

  it("refuses a lexically ambiguous promise path", () => {
    const fixture = buildFixture();
    try {
      const record = { ...fixture.record, promiseFile: `${fixture.runDir}/child/../promise.json` };
      fs.writeFileSync(fixture.attemptRecord, `${JSON.stringify(record)}\n`);
      expect(JSON.parse(runWriter(fixture, completePayload()).stdout).error).toBe("promise_path_not_canonical");
    } finally { cleanup(fixture); }
  });

  it("refuses a symlinked attempt record path", () => {
    const fixture = buildFixture();
    try {
      const symlink = path.join(fixture.runDir, "linked-attempt.json");
      fs.symlinkSync(fixture.attemptRecord, symlink);
      const result = spawnSync("node", [helperPath, "--attempt-record", symlink], { encoding: "utf8", input: JSON.stringify(completePayload()) });
      expect(JSON.parse(String(result.stdout)).error).toBe("attempt_record_not_canonical");
    } finally { cleanup(fixture); }
  });

  it("refuses a symlink canonical promise", () => {
    const fixture = buildFixture();
    try {
      const destination = path.join(fixture.runDir, "elsewhere.json");
      fs.writeFileSync(destination, "untouched\n");
      fs.symlinkSync(destination, fixture.promiseFile);
      expect(JSON.parse(runWriter(fixture, completePayload()).stdout).error).toBe("promise_path_symlink");
    } finally { cleanup(fixture); }
  });

  it("preserves an existing valid promise when atomic replacement fails", () => {
    const { writeExplorerReport } = require("../src/explorer-report-writer.cts");
    const fixture = buildFixture();
    try {
      writeExplorerReport({ attemptRecordFile: fixture.attemptRecord, payload: completePayload() });
      const existing = fs.readFileSync(fixture.promiseFile, "utf8");
      const replacement = { ...completePayload(), summary: "A later result exists. It remains unpublished. Replacement now fails." };
      try { writeExplorerReport({ attemptRecordFile: fixture.attemptRecord, payload: replacement }, { renameSync: () => { throw new Error("injected rename failure"); } }); } catch { /* expected */ }
      expect(fs.readFileSync(fixture.promiseFile, "utf8")).toBe(existing);
    } finally { cleanup(fixture); }
  });

  it("leaves no temporary report after atomic replacement fails", () => {
    const { writeExplorerReport } = require("../src/explorer-report-writer.cts");
    const fixture = buildFixture();
    try {
      try { writeExplorerReport({ attemptRecordFile: fixture.attemptRecord, payload: completePayload() }, { renameSync: () => { throw new Error("injected rename failure"); } }); } catch { /* expected */ }
      expect(fs.readdirSync(fixture.runDir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    } finally { cleanup(fixture); }
  });

  it("changes no journal state when writing succeeds", () => {
    const fixture = buildFixture();
    try {
      const before = fs.readFileSync(fixture.attemptRecord, "utf8");
      runWriter(fixture, completePayload());
      expect(fs.readFileSync(fixture.attemptRecord, "utf8")).toBe(before);
    } finally { cleanup(fixture); }
  });

  it("does not create or change the recorded worktree when writing succeeds", () => {
    const fixture = buildFixture();
    try {
      runWriter(fixture, completePayload());
      expect(fs.existsSync(String(fixture.record.worktreePath))).toBe(false);
    } finally { cleanup(fixture); }
  });
});
