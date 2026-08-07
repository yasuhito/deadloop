import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
const { canonicalAttemptRunDir, runMarkerMutationBoundary } = require("../extensions/deadloop/automations/persist-attempt-result.ts");

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-persist-path-")); roots.push(root);
  const stateDir = path.join(root, "state");
  const runDir = path.join(stateDir, "runs", "run-1");
  mkdirSync(runDir, { recursive: true });
  const attemptRecord = path.join(runDir, "attempt.json");
  writeFileSync(attemptRecord, "{}");
  return { root, stateDir, runDir, attemptRecord };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("attempt result persistence path boundary", () => {
  it("accepts exactly one run child beneath the configured state directory", () => {
    const data = fixture();
    expect(canonicalAttemptRunDir(data)).toEqual({ attemptRecord: data.attemptRecord, runDir: data.runDir });
  });
  it("rejects an attempt record outside the configured state directory", () => {
    const data = fixture(); const other = path.join(data.root, "other", "runs", "run-1"); mkdirSync(other, { recursive: true }); writeFileSync(path.join(other, "attempt.json"), "{}");
    expect(() => canonicalAttemptRunDir({ ...data, attemptRecord: path.join(other, "attempt.json") })).toThrow(/canonical runs/);
  });
  it("rejects a nested run descendant", () => {
    const data = fixture(); const nested = path.join(data.runDir, "nested"); mkdirSync(nested); writeFileSync(path.join(nested, "attempt.json"), "{}");
    expect(() => canonicalAttemptRunDir({ ...data, attemptRecord: path.join(nested, "attempt.json") })).toThrow(/canonical runs/);
  });
  it("rejects another filename within a canonical run directory", () => {
    const data = fixture(); const other = path.join(data.runDir, "other.json"); writeFileSync(other, "{}");
    expect(() => canonicalAttemptRunDir({ ...data, attemptRecord: other })).toThrow(/canonical runs/);
  });

  it("does not post a Worker marker when policy changes after the lock recheck", () => {
    let confirmed = false; let mutated = false;
    try {
      runMarkerMutationBoundary(
        () => {},
        () => { throw new Error("required verification blocked: stale_policy"); },
        () => { confirmed = true; },
        () => { mutated = true; },
      );
    } catch {}
    expect({ confirmed, mutated }).toEqual({ confirmed: false, mutated: false });
  });
});
