import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { parseArgs, pushedRevision } = require("../extensions/deadloop/automations/pr-branch-update-complete.ts");

const originalHead = "a".repeat(40);
const baseHead = "c".repeat(40);
const updatedHead = "b".repeat(40);
const checks = [{ command: "npm run check", result: "passed" }];
const roots: string[] = [];

function promiseFile(promise: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-branch-update-complete-"));
  roots.push(root);
  const file = path.join(root, "promise.json");
  fs.writeFileSync(file, JSON.stringify(promise));
  return file;
}

const pushedPromise = {
  schemaVersion: 1,
  attemptId: "branch-update-31",
  role: "branch-update",
  status: "complete",
  target: { kind: "pull-request", number: 31, repository: "owner/repo" },
  inputRevision: { head: originalHead, base: baseHead },
  summary: "merged the base head into the PR branch",
  result: { outcome: "branch_update_pushed", outputRevision: updatedHead },
  evidence: {
    finalizer: {
      action: "pushed", reason: "branch_update_pushed", originalHeadOid: originalHead,
      baseHeadOid: baseHead, headOid: updatedHead, checks,
    },
    validations: checks,
  },
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("branch update completion", () => {
  it("reads the pushed head from a complete branch-update report", () => {
    expect(pushedRevision(promiseFile(pushedPromise))).toBe(updatedHead);
  });

  it("reads no pushed head from a blocked report", () => {
    expect(pushedRevision(promiseFile({
      ...pushedPromise,
      status: "blocked",
      result: { reason: "merge_conflict", explanation: "unresolved", recovery: "resolve by hand" },
    }))).toBe("");
  });

  it("reads no pushed head from a stale-head report", () => {
    expect(pushedRevision(promiseFile({
      ...pushedPromise,
      result: { outcome: "stale_head", outputRevision: updatedHead },
      evidence: {
        finalizer: {
          action: "stale_head", reason: "stale_head", originalHeadOid: originalHead,
          baseHeadOid: baseHead, currentRemoteHeadOid: updatedHead, checks,
        },
        validations: checks,
      },
    }))).toBe("");
  });

  it("reads no pushed head from a report whose output revision is not a commit", () => {
    expect(pushedRevision(promiseFile({
      ...pushedPromise,
      result: { outcome: "branch_update_pushed", outputRevision: "HEAD" },
    }))).toBe("");
  });

  it("requires the review claim argument", () => {
    expect(() => parseArgs([
      "--promise", "/p", "--attempt-record", "/a", "--project-id", "demo", "--project-repo", "/repo",
      "--github-repo", "owner/repo", "--state-dir", "/state", "--enabled-at", "1", "--pr", "31",
      "--expected-head", originalHead, "--review-label", "agent:review",
      "--in-progress-label", "agent:in-progress", "--blocked-label", "agent:blocked",
    ])).toThrow("--review-claim is required");
  });
});
