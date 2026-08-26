import { describe, expect, it } from "vitest";

const {
  planPrRequiredVerificationStop,
  prRequiredVerificationStopMarker,
  requiredVerificationStopDiagnosis,
} = require("../src/issue-required-verification-stop.cts");

const labels = {
  review: "agent:review",
  implement: "agent:implement",
  updateBranch: "agent:update-branch",
  inProgress: "agent:in-progress",
  blocked: "agent:blocked",
  human: "ready-for-human",
};
const resolution = {
  status: "blocked" as const,
  reason: "stale_policy" as const,
  repository: "owner/repo",
  baseRevision: "a".repeat(40),
  sources: [{ kind: "repo_policy" as const, location: "deadloop.json", command: "npm test" }],
  sourceScope: "fixed" as const,
};

function pr(comments: Array<{ body: string }> = []) {
  return {
    number: 42,
    labels: [{ name: "agent:in-progress" }, { name: "ready-for-human" }],
    comments,
  };
}

describe("pull request required-verification stop", () => {
  it("preserves the review target while releasing the active claim", () => {
    expect(planPrRequiredVerificationStop({ pr: pr(), resolution, labels })).toMatchObject({
      removeLabels: ["agent:in-progress", "ready-for-human"],
      addLabels: ["agent:review", "agent:blocked"],
    });
  });

  it("does not add the human handoff label", () => {
    expect(planPrRequiredVerificationStop({ pr: pr(), resolution, labels }).addLabels).not.toContain("ready-for-human");
  });

  it("suppresses the same recovery comment", () => {
    const first = planPrRequiredVerificationStop({ pr: pr(), resolution, labels });
    expect(planPrRequiredVerificationStop({ pr: pr([{ body: first.comment || "" }]), resolution, labels }).comment).toBeUndefined();
  });

  it("uses the same stable fingerprint format with a PR-specific target", () => {
    expect(prRequiredVerificationStopMarker(42, resolution)).toMatch(/^<!-- deadloop:required-verification-blocked:v1 target=pr-42 fingerprint=[0-9a-f]{64} -->$/);
  });

  it("derives a stop diagnosis from the fixed reviewer contract", () => {
    const diagnosis = requiredVerificationStopDiagnosis({ repository: "owner/repo", requiredVerification: { ...resolution, source: resolution.sources[0], command: "npm test" } }, new Error("required verification blocked: stale_policy"));
    expect(diagnosis.sources).toEqual(resolution.sources);
  });
});
