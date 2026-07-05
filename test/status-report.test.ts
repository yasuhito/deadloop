import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { EXTENSION_CODE_CHANGED_WARNING, normalizeProject } from "../src/core";
import { buildStatusSnapshot, formatStatusReport, resolveActiveProject } from "../src/status";

const fixture = JSON.parse(readFileSync("test/fixtures/status/report-case.json", "utf8"));
const projects = fixture.projects.map(normalizeProject);

function report(warnings: string[] = []) {
  return formatStatusReport(
    buildStatusSnapshot({
      ...fixture,
      projects,
      warnings,
    }),
  );
}

describe("pi-looper status report", () => {
  it("resolves the active project from the configured repository path", () => {
    expect(resolveActiveProject("/home/yasuhito/Work/pi-looper/docs", projects)?.id).toBe("pi-looper");
  });

  it("shows when there are no eligible issues", () => {
    expect(report()).toContain("- eligible: none");
  });

  it("shows the review target PR", () => {
    expect(report()).toContain("- review target: #21 Add status report");
  });

  it("shows the cleanup candidate worktree", () => {
    expect(report()).toContain(
      "- cleanup candidates: #20 agent/issue-12-old -> /home/yasuhito/Work/herdr-worktrees/pi-looper/agent-issue-12-old (workspace-20; merged_pr)",
    );
  });

  it("shows active Herdr worker worktrees with workspace ids", () => {
    expect(report()).toContain(
      "agent/issue-13-add-pi-looper-status-report -> /home/yasuhito/Work/herdr-worktrees/pi-looper/agent-issue-13-add-pi-looper-status-report (workspace-13)",
    );
  });

  it("shows extension code freshness warnings", () => {
    expect(report([EXTENSION_CODE_CHANGED_WARNING])).toContain(EXTENSION_CODE_CHANGED_WARNING);
  });
});
