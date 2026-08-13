import { describe, expect, it } from "vitest";

const { releasableRetainedAttempts } = require("../src/pr-work-authority-reconciliation.ts");

const currentHead = "a".repeat(40);
const olderHead = "b".repeat(40);
const currentRequest = "req-2";

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: "attempt-1",
    stopped: true,
    revision: currentHead,
    claimRequestEventId: currentRequest,
    ...overrides,
  };
}

function releasable(attempts: Record<string, unknown>[]) {
  return releasableRetainedAttempts({ attempts, currentHead, currentRequestEventId: currentRequest });
}

describe("retained attempt work authority", () => {
  it("releases a stopped attempt bound to a superseded head", () => {
    expect(releasable([attempt({ revision: olderHead })])).toEqual(["attempt-1"]);
  });

  it("releases a stopped attempt whose claim names a superseded request", () => {
    expect(releasable([attempt({ claimRequestEventId: "req-1" })])).toEqual(["attempt-1"]);
  });

  it("releases a stopped attempt that saved no claim and is bound to a superseded head", () => {
    expect(releasable([attempt({ revision: olderHead, claimRequestEventId: undefined })])).toEqual(["attempt-1"]);
  });

  it("keeps a stopped attempt bound to the current head with the current claim", () => {
    expect(releasable([attempt()])).toEqual([]);
  });

  it("keeps a live attempt bound to a superseded head", () => {
    expect(releasable([attempt({ stopped: false, revision: olderHead })])).toEqual([]);
  });

  it("keeps a live attempt whose claim names a superseded request", () => {
    expect(releasable([attempt({ stopped: false, claimRequestEventId: "req-1" })])).toEqual([]);
  });

  it("releases every retained attempt that lost its authority", () => {
    const attempts = [
      attempt({ attemptId: "old-head", revision: olderHead }),
      attempt({ attemptId: "old-request", claimRequestEventId: "req-1" }),
      attempt({ attemptId: "current" }),
    ];

    expect(releasable(attempts)).toEqual(["old-head", "old-request"]);
  });

  it("keeps a stopped attempt with no claim that is bound to the current head", () => {
    expect(releasable([attempt({ claimRequestEventId: undefined })])).toEqual([]);
  });
});
