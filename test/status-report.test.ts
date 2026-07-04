import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { normalizeProject } from "../src/core";
import { buildStatusSnapshot, formatStatusReport, resolveActiveProject } from "../src/status";

const fixture = JSON.parse(readFileSync("test/fixtures/status/report-case.json", "utf8"));
const projects = fixture.projects.map(normalizeProject);

describe("pi-looper status report", () => {
  it("resolves the active project from the configured repository path", () => {
    expect(resolveActiveProject("/home/yasuhito/Work/pi-looper/docs", projects)?.id).toBe("pi-looper");
  });

  it("formats no eligible issues, one review target PR, and one cleanup candidate", () => {
    expect(
      formatStatusReport(
        buildStatusSnapshot({
          ...fixture,
          projects,
        }),
      ),
    ).toBe(`pi-looper status: pi-looper
repo: yasuhito/pi-looper
cwd: /home/yasuhito/Work/pi-looper
autoMerge: off

Automations:
- pi-looper issue coordinator: */10 * * * *; last=queued; next=2026-07-05T00:10:00.000Z
- pi-looper PR reviewer: */10 * * * *; last=never; next=2026-07-05T00:10:00.000Z

Issues:
- eligible: none
- in-progress: #13 Add pi-looper status report
- blocked/needs-info: none

PRs:
- review target: #21 Add status report
- reviewing: none

Herdr:
- worker worktrees: 1
- cleanup candidates: #20 agent/issue-12-old -> /home/yasuhito/Work/herdr-worktrees/pi-looper/agent-issue-12-old (merged_pr)
- stale leftovers: /home/yasuhito/Work/herdr-worktrees/pi-looper/agent-issue-12-old`);
  });
});
