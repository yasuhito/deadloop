import { describe, expect, it } from "vitest";

import { normalizeProject } from "../src/core";
import { formatDoctorReport } from "../src/doctor";
import { buildStatusSnapshot, formatStatusReport } from "../src/status";

const project = normalizeProject({
  id: "demo",
  githubRepo: "octo/demo",
  automations: [{ id: "demo:reviewer", name: "PR reviewer", precheckFile: "precheck.sh", promptFile: "prompt.md", driverFile: "driver.cts" }],
});
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

    expect(report).toContain("attemptMonitoring: deterministic for all roles (no Automation-host model)");
  });

  it("describes deterministic reviewer and branch-update monitoring in doctor", () => {
    const report = formatDoctorReport({ ...shared, findings: [] });

    expect(report).toContain("attemptMonitoring: deterministic for all roles (no Automation-host model)");
  });

  it("extracts active-work duration and model wait observables from the automation state", () => {
    const snapshot = buildStatusSnapshot({
      ...shared,
      projects: [project],
      selectedProject: project,
      state: {
        automations: {
          "demo:demo:reviewer": {
            pendingDriverHandoff: {
              monitorAccounting: { activeMilliseconds: 86_400_000 },
              modelWait: { startedAt: "2026-08-21T00:00:00.000Z", nextRetryAt: "2026-08-21T01:00:00.000Z" },
              modelRetryCount: 2,
            },
          },
        },
      } as never,
      nowMs: Date.parse("2026-08-21T00:30:00.000Z"),
    });

    expect(snapshot.automations[0]).toMatchObject({
      activeWorkMilliseconds: 86_400_000,
      modelWait: {
        startedAt: "2026-08-21T00:00:00.000Z",
        durationMilliseconds: 1_800_000,
        nextRetryAt: "2026-08-21T01:00:00.000Z",
        retryCount: 2,
      },
    });
  });

  it("renders retry count, waiting start, duration, next retry, and active-work duration in status", () => {
    const report = formatStatusReport({
      ...shared,
      automations: [{
        id: "demo:reviewer",
        name: "PR reviewer",
        schedule: "*/10 * * * *",
        lastResult: "driver_monitor_waiting_for_model",
        lastSummary: "waiting for model availability",
        nextScheduledAt: Date.parse("2026-08-21T00:40:00.000Z"),
        activeWorkMilliseconds: 86_400_000,
        modelWait: {
          startedAt: "2026-08-21T00:00:00.000Z",
          durationMilliseconds: 1_800_000,
          nextRetryAt: "2026-08-21T01:00:00.000Z",
          retryCount: 2,
        },
      }],
      issues: { eligible: [], inProgress: [], waitingForPerson: [] },
      prs: { reviewTarget: [], reviewing: [] },
      herdr: { workerWorktrees: [], cleanupCandidates: [], staleLeftovers: [] },
    });
    const reviewerLine = report.split("\n").find((line) => line.includes("PR reviewer:")) || "";

    expect(reviewerLine).toBe(
      "- PR reviewer: */10 * * * *; last=driver_monitor_waiting_for_model; summary=waiting for model availability"
      + "; active-work=86400000ms; waiting-for-model since=2026-08-21T00:00:00.000Z (1800000ms)"
      + "; retries=2; next-retry=2026-08-21T01:00:00.000Z; next=2026-08-21T00:40:00.000Z",
    );
  });
});
