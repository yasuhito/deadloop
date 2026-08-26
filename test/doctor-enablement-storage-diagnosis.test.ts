import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildDoctorSnapshot, formatDoctorReport } from "../src/doctor";
import { normalizeProject } from "../src/core";

function snapshotWithEvidence(evidence: unknown) {
  const project = normalizeProject({ id: "demo", repoPath: "/repos/demo", githubRepo: "owner/demo", workerModel: "test-model", reviewerModel: "test-review-model" });
  return buildDoctorSnapshot({
    cwd: "/repos/demo",
    projects: [project],
    selectedProject: project,
    enablementStorageExhaustion: evidence as never,
    enablementStorageExhaustionPath: path.join("~", ".pi", "agent", "deadloop", "enablement-storage-exhaustion.json"),
  });
}

const evidence = {
  code: "ENOSPC",
  detail: "ENOSPC: no space left on device, write",
  repoPath: "/repos/demo",
  githubRepo: "owner/demo",
  observedAt: Date.parse("2026-02-14T09:00:00Z"),
};

describe("doctor enablement storage-exhaustion finding", () => {
  it("reports retained local evidence as a finding", () => {
    expect(snapshotWithEvidence(evidence).findings.map((finding: { type: string }) => finding.type)).toContain("enablement_storage_exhaustion");
  });

  it("shows no storage-exhaustion finding without evidence", () => {
    expect(snapshotWithEvidence(null).findings.some((finding: { type: string }) => finding.type === "enablement_storage_exhaustion")).toBe(false);
  });

  it("states that the stop changed no GitHub state and recorded no permission", () => {
    const finding = snapshotWithEvidence(evidence).findings.find((finding: { type: string }) => finding.type === "enablement_storage_exhaustion");
    expect(finding.summary).toContain("no GitHub issue, pull request, or agent workflow label was changed");
  });

  it("points the report at the local evidence file and recovery commands", () => {
    const report = formatDoctorReport(snapshotWithEvidence(evidence));
    expect(report).toContain("enablement-storage-exhaustion.json");
  });
});
