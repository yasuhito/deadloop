import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { workerFixture } from "./fixtures/attempt-workspace";
const { loadAttempts } = require("../extensions/deadloop/automations/reconcile-pr-work-authority.cts");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-unreadable-"));
  roots.push(root);
  return path.join(root, "deadloop");
}

/** A terminal journal whose authorityRelease.reason was removed from the contract. */
function persistUnreadableTerminalJournal(root: string, runName = "old"): string {
  const runDir = path.join(root, "runs", runName);
  mkdirSync(runDir, { recursive: true });
  const record = {
    ...workerFixture().record,
    phase: "authority_released",
    authorityRelease: { reason: "github_authority_lost", releasedAt: "2026-08-20T00:00:00.000Z" },
  };
  writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify(record));
  return runDir;
}

function unreadableHostLogEvents(root: string): Record<string, unknown>[] {
  return readFileSync(path.join(root, "host-log.jsonl"), "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.kind === "unreadable_attempt_record");
}

describe("reconciliation of unreadable terminal journals", () => {
  it("skips an unreadable terminal journal instead of making its pull request unobservable", () => {
    const root = stateDir();
    persistUnreadableTerminalJournal(root);

    expect(loadAttempts(root, "demo", "octo/demo")).toEqual({ valid: [], released: [], malformed: [] });
  });

  it("reports an unreadable terminal journal to the host log once per record", () => {
    const root = stateDir();
    persistUnreadableTerminalJournal(root);

    loadAttempts(root, "demo", "octo/demo");
    loadAttempts(root, "demo", "octo/demo");

    const events = unreadableHostLogEvents(root);
    expect({ events: events.length, namesField: String(events[0].reason).includes('authorityRelease.reason = "github_authority_lost"') })
      .toEqual({ events: 1, namesField: true });
  });

  it("still treats a living-phase contract violation as malformed evidence", () => {
    const root = stateDir();
    const runDir = persistUnreadableTerminalJournal(root, "living");
    const record = JSON.parse(readFileSync(path.join(runDir, "attempt.json"), "utf8"));
    record.phase = "agent_started";
    record.lastSuccessfulPhase = "agent_started";
    record.authorityRelease = undefined;
    record.target = { kind: "pull-request", number: 42 };
    record.inputRevision.head = "not-a-commit";
    writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify(record));

    expect(loadAttempts(root, "demo", "octo/demo").malformed).toHaveLength(1);
  });
});
