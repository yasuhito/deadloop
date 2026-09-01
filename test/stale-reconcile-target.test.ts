import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { attemptRecord } from "./fixtures/attempt-workspace";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-stale-reconcile-"));
const stateDir = path.join(root, "deadloop");
let retainedAttemptDoctorFindings: (...args: any[]) => any[];
let reconcilePersistedAttemptJournals: (...args: any[]) => Promise<boolean>;

beforeAll(async () => {
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.resetModules();
  // @ts-expect-error Vitest transforms this runtime extension import.
  ({ retainedAttemptDoctorFindings, reconcilePersistedAttemptJournals } = await import("../extensions/deadloop/index"));
});
afterAll(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

const project = {
  id: "demo", githubRepo: "octo/demo", repoPath: root, enabledAt: 1,
  labels: { ready: "ready-for-agent", explore: "agent:explore", implement: "agent:implement", review: "agent:review", inProgress: "agent:in-progress", blocked: "agent:blocked", human: "ready-for-human" },
};

function writeAttemptFixture(overrides: Record<string, unknown> = {}) {
  const runDir = path.join(stateDir, "runs", "one");
  fs.rmSync(path.join(stateDir, "runs"), { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const worktreePath = fs.mkdtempSync(path.join(root, "worktree-"));
  const record = { ...attemptRecord("worker"), worktreePath, ...overrides };
  const promiseFile = path.join(runDir, "promise.json");
  record.promiseFile = promiseFile;
  fs.writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify(record));
  return { runDir, record, promiseFile };
}

/** GitHub double: answers target state queries and counts reconcile script dispatches. */
function makePi(targetState: string) {
  const dispatches: string[] = [];
  const pi = {
    exec: async (command: string, args: string[]) => {
      const joined = args.join(" ");
      if (command === "gh" && joined.includes("view")) return { code: 0, stdout: JSON.stringify({ state: targetState }) };
      if (joined.includes("reconcile-report-received-attempt.cts")) {
        dispatches.push(joined);
        return { code: 0, stdout: '{"action":"done","driverAction":"report_received_persisted"}' };
      }
      return { code: 0, stdout: "{}" };
    },
  };
  return { pi, dispatches };
}

function readHostLog(): any[] {
  return fs.readFileSync(path.join(stateDir, "host-log.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
}

describe("stale report_received reconcile targets", () => {
  it("never relaunches reconciliation across three ticks for a closed Issue target", async () => {
    writeAttemptFixture();
    const { pi, dispatches } = makePi("CLOSED");
    for (let tick = 0; tick < 3; tick += 1) await reconcilePersistedAttemptJournals(pi, project);
    expect(dispatches.length).toBeLessThanOrEqual(1);
  });

  it("queries the target state only once before recording the retirement", async () => {
    writeAttemptFixture();
    const stateQueries: string[] = [];
    const pi = {
      exec: async (command: string, args: string[]) => {
        const joined = args.join(" ");
        if (command === "gh" && joined.includes("view")) {
          stateQueries.push(joined);
          return { code: 0, stdout: JSON.stringify({ state: "CLOSED" }) };
        }
        return { code: 0, stdout: "{}" };
      },
    };
    await reconcilePersistedAttemptJournals(pi, project);
    await reconcilePersistedAttemptJournals(pi, project);
    expect(stateQueries).toHaveLength(1);
  });

  it("records the terminal retirement reason inside the attempt journal", async () => {
    const { runDir, record } = writeAttemptFixture();
    const { pi } = makePi("CLOSED");
    await reconcilePersistedAttemptJournals(pi, project);
    const retirement = JSON.parse(fs.readFileSync(path.join(runDir, "reconcile-retired.json"), "utf8"));
    expect(retirement).toMatchObject({ schemaVersion: 1, attemptId: record.attemptId, reason: expect.stringContaining("closed") });
  });

  it("retires a report_received record whose worktree no longer exists without any reconcile dispatch", async () => {
    writeAttemptFixture({ worktreePath: path.join(root, "gone-worktree") });
    const { pi, dispatches } = makePi("OPEN");
    await reconcilePersistedAttemptJournals(pi, project);
    expect(dispatches).toHaveLength(0);
  });

  it("offers one manual-review-archive command for a retired record", async () => {
    const { runDir } = writeAttemptFixture();
    const { pi } = makePi("CLOSED");
    await reconcilePersistedAttemptJournals(pi, project);
    const findings = retainedAttemptDoctorFindings(project, [], []);
    expect(findings.map((finding: any) => finding.commands.map((command: string) => command.replaceAll("'", "")))).toEqual([
      [`mv ${runDir} ${path.join(stateDir, "manual-review-archive")}/`],
    ]);
  });

  it("records reconcile start, finish, and duration in the host log", async () => {
    fs.rmSync(path.join(stateDir, "host-log.jsonl"), { force: true });
    writeAttemptFixture();
    const { pi } = makePi("OPEN");
    await reconcilePersistedAttemptJournals(pi, project);
    const events = readHostLog().filter((event) => ["reconcile_started", "reconcile_finished"].includes(event.kind));
    const finished = events.find((event) => event.kind === "reconcile_finished");
    expect({ kinds: events.map((event) => event.kind), attemptId: finished?.attemptId, durationMs: typeof finished?.durationMs })
      .toEqual({ kinds: ["reconcile_started", "reconcile_finished"], attemptId: "attempt-1", durationMs: "number" });
  });

  it("leaves an open-target record with a live worktree on the ordinary reconcile path", async () => {
    writeAttemptFixture();
    const { pi, dispatches } = makePi("OPEN");
    await reconcilePersistedAttemptJournals(pi, project);
    await reconcilePersistedAttemptJournals(pi, project);
    expect(dispatches).toHaveLength(2);
  });
});
