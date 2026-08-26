import { describe, expect, it } from "vitest";

const {
  classifyCheckObservations,
  decideCiFallbackMergeGate,
  decideCiFallbackRepair,
  fallbackRecordMatchesCandidate,
} = require("../src/ci-review-policy.cts");

const headOid = "a".repeat(40);
const baseOid = "b".repeat(40);
const treeOid = "d".repeat(40);
const contract = {
  command: "npm ci && npm run check",
  derivation: "npm_convention",
  policySource: { kind: "npm_convention", location: "package-lock.json+package.json#scripts.check" },
};

function boundRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    role: "merge_candidate",
    repository: "owner/repo",
    prNumber: 24,
    headOid,
    baseOid,
    treeOid,
    command: contract.command,
    derivation: contract.derivation,
    policySource: contract.policySource,
    policyBaseRevision: baseOid,
    outcome: "passed",
    exitCode: 0,
    logPath: "/state/ci-fallback/logs/verification.log",
    ...overrides,
  };
}

function gateInput(overrides: Record<string, unknown> = {}) {
  return {
    checks: [{ status: "COMPLETED", conclusion: "FAILURE" }],
    repository: "owner/repo",
    prNumber: 24,
    headOid,
    baseOid,
    treeOid,
    contract,
    policyBaseRevision: baseOid,
    fallbackRecord: null,
    ...overrides,
  };
}

describe("CI check observation classification", () => {
  it("classifies an empty rollup as absent", () => {
    expect(classifyCheckObservations([])).toBe("absent");
  });

  it("classifies a rollup with any pending check as pending", () => {
    expect(classifyCheckObservations([
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { status: "IN_PROGRESS" },
    ])).toBe("pending");
  });

  it("classifies a fully successful rollup as all_success", () => {
    expect(classifyCheckObservations([{ status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("all_success");
  });

  it("classifies a mixed terminal rollup by its failure", () => {
    expect(classifyCheckObservations([
      { state: "SUCCESS" },
      { state: "FAILURE" },
    ])).toBe("terminal_failure");
  });

  it("stops on a check whose terminal state is unrecognizable", () => {
    expect(classifyCheckObservations([{ status: "COMPLETED", conclusion: "MYSTERY" }])).toBe("unknown");
  });
});

describe("CI fallback merge gate directive", () => {
  it("proceeds without CI when no checks exist, because absence is non-failure", () => {
    expect(decideCiFallbackMergeGate(gateInput({ checks: [] }))).toMatchObject({ action: "proceed", basis: "no_checks" });
  });

  it("waits while any check is pending", () => {
    expect(decideCiFallbackMergeGate(gateInput({ checks: [{ status: "QUEUED" }] }))).toMatchObject({ action: "wait", reason: "checks_pending" });
  });

  it("stops on unknown check state", () => {
    expect(decideCiFallbackMergeGate(gateInput({ checks: [{}] }))).toMatchObject({ action: "stop", reason: "unknown_check_state" });
  });

  it("authorizes by CI success without any fallback record", () => {
    expect(decideCiFallbackMergeGate(gateInput({ checks: [{ conclusion: "SUCCESS" }] }))).toMatchObject({ action: "proceed", basis: "ci_success" });
  });

  it("requires fallback verification for a terminal failure without a record", () => {
    expect(decideCiFallbackMergeGate(gateInput())).toMatchObject({ action: "stop", reason: "ci_fallback_required" });
  });

  it("proceeds on fresh fallback evidence bound to the exact candidate", () => {
    const directive = decideCiFallbackMergeGate(gateInput({ fallbackRecord: boundRecord() }));
    expect(directive).toMatchObject({ action: "proceed", basis: "ci_fallback" });
  });

  it("stops with a typed failure when fresh fallback evidence records a failed run", () => {
    const directive = decideCiFallbackMergeGate(gateInput({ fallbackRecord: boundRecord({ outcome: "failed", exitCode: 1 }) }));
    expect(directive).toMatchObject({ action: "stop", reason: "ci_fallback_failed" });
  });

  it("invalidates fallback evidence after the head advances", () => {
    const directive = decideCiFallbackMergeGate(gateInput({ headOid: "f".repeat(40), fallbackRecord: boundRecord() }));
    expect(directive).toMatchObject({ action: "stop", reason: "ci_fallback_stale" });
  });

  it("invalidates fallback evidence after the base advances", () => {
    const directive = decideCiFallbackMergeGate(gateInput({ baseOid: "9".repeat(40), fallbackRecord: boundRecord() }));
    expect(directive).toMatchObject({ action: "stop", reason: "ci_fallback_stale" });
  });

  it("invalidates fallback evidence when the resolved command changed", () => {
    const directive = decideCiFallbackMergeGate(gateInput({
      contract: { ...contract, command: "make ci" },
      fallbackRecord: boundRecord(),
    }));
    expect(directive).toMatchObject({ action: "stop", reason: "ci_fallback_stale" });
  });

  it("never reports CI fallback as CI success", () => {
    const directive = decideCiFallbackMergeGate(gateInput({ fallbackRecord: boundRecord() })) as Record<string, unknown>;
    expect(String((directive as { basis?: string }).basis)).not.toBe("ci_success");
  });
});

describe("fallback record binding", () => {
  it("matches case-insensitively on exact object identities", () => {
    const record = boundRecord();
    expect(fallbackRecordMatchesCandidate(record, {
      repository: "owner/repo",
      prNumber: 24,
      headOid: headOid.toUpperCase(),
      baseOid: baseOid.toUpperCase(),
      treeOid: treeOid.toUpperCase(),
      contract,
      policyBaseRevision: baseOid.toUpperCase(),
    })).toBe(true);
  });

  it("rejects a record from another pull request of the same repository", () => {
    const record = boundRecord({ prNumber: 25 });
    expect(fallbackRecordMatchesCandidate(record, {
      repository: "owner/repo",
      prNumber: 24,
      headOid: headOid,
      baseOid: baseOid,
      treeOid: treeOid,
      contract,
      policyBaseRevision: baseOid,
    })).toBe(false);
  });
});

describe("CI fallback repair episode directive", () => {
  const episodeKey = "cifb-test";

  it("allows and resets the episode when none exists", () => {
    expect(decideCiFallbackRepair({ episode: null, humanRequestAfterEpisode: false, expectedEpisodeKey: episodeKey }))
      .toEqual({ action: "repair_allowed", episodeReset: true });
  });

  it("keeps one episode across changed heads within the same base/command pair", () => {
    expect(decideCiFallbackRepair({
      episode: { episodeKey, repairsUsed: 0 },
      humanRequestAfterEpisode: false,
      expectedEpisodeKey: episodeKey,
    })).toEqual({ action: "repair_allowed", episodeReset: false });
  });

  it("blocks a second fallback failure inside the same episode", () => {
    expect(decideCiFallbackRepair({
      episode: { episodeKey, repairsUsed: 1 },
      humanRequestAfterEpisode: false,
      expectedEpisodeKey: episodeKey,
    })).toEqual({ action: "repair_blocked", reason: "second_failure_in_episode" });
  });

  it("starts a new episode only after a later human Agent request", () => {
    expect(decideCiFallbackRepair({
      episode: { episodeKey, repairsUsed: 1 },
      humanRequestAfterEpisode: true,
      expectedEpisodeKey: episodeKey,
    })).toEqual({ action: "repair_allowed", episodeReset: true });
  });
});
