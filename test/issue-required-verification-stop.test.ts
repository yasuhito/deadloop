import { describe, expect, it } from "vitest";

const {
  applyIssueRequiredVerificationStop,
  planIssueRequiredVerificationStop,
  requiredVerificationStopMarker,
} = require("../src/issue-required-verification-stop.ts");

const labels = { implement: "agent:implement", inProgress: "agent:in-progress", blocked: "agent:blocked" };
const resolution = {
  status: "blocked" as const,
  reason: "no_source" as const,
  repository: "owner/repo",
  baseRevision: "a".repeat(40),
  sources: [],
};

function issue(comments: Array<{ body: string }> = []) {
  return { number: 42, labels: [{ name: "ready-for-agent" }, { name: "agent:implement" }], comments };
}

function stopComment() {
  return planIssueRequiredVerificationStop({ issue: issue(), resolution, phase: "before_launch", labels }).comment || "";
}

describe("implementation Issue required-verification stop", () => {
  it("keeps the ready label while removing implementation ownership", () => {
    expect(planIssueRequiredVerificationStop({ issue: issue(), resolution, phase: "before_launch", labels }).removeLabels).toEqual(["agent:implement"]);
  });

  it("removes the in-progress label at completion time", () => {
    const current = issue(); current.labels = [{ name: "ready-for-agent" }, { name: "agent:in-progress" }];
    expect(planIssueRequiredVerificationStop({ issue: current, resolution, phase: "completion", labels }).removeLabels).toEqual(["agent:in-progress"]);
  });

  it("removes both claim labels from an inconsistent stopped Issue", () => {
    const current = issue(); current.labels.push({ name: "agent:in-progress" });
    expect(planIssueRequiredVerificationStop({ issue: current, resolution, phase: "before_launch", labels }).removeLabels).toEqual(["agent:implement", "agent:in-progress"]);
  });

  it("adds the blocked label", () => {
    expect(planIssueRequiredVerificationStop({ issue: issue(), resolution, phase: "before_launch", labels }).addLabels).toEqual(["agent:blocked"]);
  });

  it("documents the stop reason", () => {
    expect(stopComment()).toContain("reason: no_source");
  });

  it("documents the inspected sources", () => {
    expect(stopComment()).toContain("Inspected sources:\n- none");
  });

  it("documents the skipped operations", () => {
    expect(stopComment()).toContain("No Worker, branch, push, or pull request was created.");
  });

  it("documents that the stop does not consume a retry", () => {
    expect(stopComment()).toContain("did not consume an implementation retry allowance.");
  });

  it("documents recovery guidance", () => {
    expect(stopComment()).toContain("Run `/deadloop-doctor`");
  });

  it("suppresses an identical stop comment", () => {
    const first = planIssueRequiredVerificationStop({ issue: issue(), resolution, phase: "before_launch", labels });
    expect(planIssueRequiredVerificationStop({ issue: issue([{ body: first.comment || "" }]), resolution, phase: "before_launch", labels }).comment).toBeUndefined();
  });

  it("does not notify again when only the trusted base revision changes", () => {
    const first = planIssueRequiredVerificationStop({ issue: issue(), resolution, phase: "before_launch", labels });
    const changed = { ...resolution, baseRevision: "b".repeat(40) };
    expect(planIssueRequiredVerificationStop({ issue: issue([{ body: first.comment || "" }]), resolution: changed, phase: "before_launch", labels }).comment).toBeUndefined();
  });

  it("uses a target-specific stable marker", () => {
    expect(requiredVerificationStopMarker(42, resolution)).toMatch(/^<!-- deadloop:required-verification-blocked:v1 target=issue-42 fingerprint=[0-9a-f]{64} -->$/);
  });

  it("does not release ownership when fingerprint comment creation fails", () => {
    const moves: unknown[] = [];
    const plan = planIssueRequiredVerificationStop({ issue: issue(), resolution, phase: "before_launch", labels });
    let failure = "";
    try {
      applyIssueRequiredVerificationStop({
        commentIssue: () => { throw new Error("comment failed"); },
        moveIssueLabels: (...args: unknown[]) => { moves.push(args); },
      }, "owner/repo", 42, plan);
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    expect({ failure, moves: moves.length }).toEqual({ failure: "comment failed", moves: 0 });
  });

  it("resumes label release from a fingerprinted-comment partial state", () => {
    const first = planIssueRequiredVerificationStop({ issue: issue(), resolution, phase: "before_launch", labels });
    const partial = issue([{ body: first.comment || "" }]);
    const resumed = planIssueRequiredVerificationStop({ issue: partial, resolution, phase: "before_launch", labels });
    const moves: unknown[] = [];
    applyIssueRequiredVerificationStop({ commentIssue: () => undefined, moveIssueLabels: (...args: unknown[]) => { moves.push(args); } }, "owner/repo", 42, resumed);
    expect(moves).toHaveLength(1);
  });
});
