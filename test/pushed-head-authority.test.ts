import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { pushedHeadTransition } = require("../extensions/deadloop/automations/reconcile-pr-work-authority.ts");

const startHead = "a".repeat(40);
const pushedHead = "b".repeat(40);
const baseHead = "c".repeat(40);
const checks = [{ command: "npm run check", result: "passed" }];
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function attemptWithReport(report: Record<string, unknown> | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-pushed-head-"));
  roots.push(root);
  const promiseFile = path.join(root, "promise.json");
  if (report) fs.writeFileSync(promiseFile, JSON.stringify(report));
  return {
    attemptId: "branch-update-31",
    role: "branch-update",
    target: { kind: "pull-request", number: 31 },
    inputRevision: { head: startHead, base: baseHead },
    promiseFile,
  };
}

function pushedReport(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    attemptId: "branch-update-31",
    role: "branch-update",
    status: "complete",
    target: { kind: "pull-request", number: 31, repository: "owner/repo" },
    inputRevision: { head: startHead, base: baseHead },
    summary: "merged the base head into the PR branch",
    result: { outcome: "branch_update_pushed", outputRevision: pushedHead },
    evidence: {
      finalizer: {
        action: "pushed", reason: "branch_update_pushed", originalHeadOid: startHead,
        baseHeadOid: baseHead, headOid: pushedHead, checks,
      },
      validations: checks,
    },
    ...overrides,
  };
}

describe("pushed head authority transition", () => {
  it("reads the transition an attempt proved it produced", () => {
    expect(pushedHeadTransition(attemptWithReport(pushedReport()), { headRefOid: pushedHead })).toEqual({
      originalHeadOid: startHead,
      headOid: pushedHead,
    });
  });

  it("reads no transition when the head belongs to somebody else's push", () => {
    expect(pushedHeadTransition(attemptWithReport(pushedReport()), { headRefOid: "d".repeat(40) })).toBeNull();
  });

  it("reads no transition from an attempt with no completion report", () => {
    expect(pushedHeadTransition(attemptWithReport(null), { headRefOid: pushedHead })).toBeNull();
  });

  it("reads no transition from a stale-head report", () => {
    const report = pushedReport({
      result: { outcome: "stale_head", outputRevision: pushedHead },
      evidence: {
        finalizer: {
          action: "stale_head", reason: "stale_head", originalHeadOid: startHead,
          baseHeadOid: baseHead, currentRemoteHeadOid: pushedHead, checks,
        },
        validations: checks,
      },
    });

    expect(pushedHeadTransition(attemptWithReport(report), { headRefOid: pushedHead })).toBeNull();
  });

  it("reads no transition from a report bound to another attempt", () => {
    expect(pushedHeadTransition(
      attemptWithReport(pushedReport({ attemptId: "someone-else" })),
      { headRefOid: pushedHead },
    )).toBeNull();
  });

  it("reads no transition from a blocked report", () => {
    const report = pushedReport({
      status: "blocked",
      result: { reason: "merge_conflict", explanation: "unresolved", recovery: "resolve by hand" },
    });

    expect(pushedHeadTransition(attemptWithReport(report), { headRefOid: pushedHead })).toBeNull();
  });
});
