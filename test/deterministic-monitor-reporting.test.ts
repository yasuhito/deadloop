import { describe, expect, it } from "vitest";

import { normalizeProject } from "../src/core";
import { formatDoctorReport } from "../src/doctor";
import { formatStatusReport } from "../src/status";

const project = normalizeProject({ id: "demo", githubRepo: "octo/demo" });
const shared = { project, repositoryEnablement: "enabled" as const, cwd: "/repo", warnings: [] };

describe("deterministic attempt monitoring reports", () => {
  it("describes deterministic reviewer and branch-update monitoring in status", () => {
    const report = formatStatusReport({
      ...shared,
      automations: [],
      issues: { eligible: [], inProgress: [], waitingForPerson: [] },
      prs: { reviewTarget: [], reviewing: [] },
      herdr: { workerWorktrees: [], cleanupCandidates: [], staleLeftovers: [] },
    });

    expect(report).toContain("attemptMonitoring: deterministic for reviewer and branch-update (no Automation-host model)");
  });

  it("describes deterministic reviewer and branch-update monitoring in doctor", () => {
    const report = formatDoctorReport({ ...shared, findings: [] });

    expect(report).toContain("attemptMonitoring: deterministic for reviewer and branch-update (no Automation-host model)");
  });
});
