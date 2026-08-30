import { describe, expect, it } from "vitest";

import { buildDoctorSnapshot, formatDoctorReport } from "../src/doctor";
import { normalizeProject } from "../src/core";

function snapshotWith(pendingFiles: number | undefined) {
  const project = normalizeProject({ id: "demo", repoPath: "/repos/demo", githubRepo: "owner/demo", workerModel: "test-model", reviewerModel: "test-review-model" });
  return buildDoctorSnapshot({
    cwd: "/repos/demo",
    projects: [project],
    selectedProject: project,
    ...(pendingFiles === undefined ? {} : { enablementPendingFiles: pendingFiles }),
  });
}

describe("doctor enablement pending lock files", () => {
  it("always reports the residual pending temp file count", () => {
    expect(formatDoctorReport(snapshotWith(3))).toContain("enablement lock pending files: 3");
  });

  it("reports zero when no pending temp file exists", () => {
    expect(formatDoctorReport(snapshotWith(undefined))).toContain("enablement lock pending files: 0");
  });

  it("raises a finding only when pending temp files remain", () => {
    expect(snapshotWith(2).findings.map((finding: { type: string }) => finding.type)).toContain("enablement_pending_lock_files");
    expect(snapshotWith(0).findings.some((finding: { type: string }) => finding.type === "enablement_pending_lock_files")).toBe(false);
  });

  it("states that the next lock acquisition cleans the residual files", () => {
    const finding = snapshotWith(2).findings.find((finding: { type: string }) => finding.type === "enablement_pending_lock_files");
    expect(finding.summary).toContain("next enablement state lock acquisition");
  });
});
