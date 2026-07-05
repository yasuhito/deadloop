import { describe, expect, it } from "vitest";

import { normalizeProject } from "../src/core";
import { buildDoctorSnapshot, formatDoctorReport } from "../src/doctor";

const project = normalizeProject({
  id: "pi-looper",
  repoPath: "/repo",
  githubRepo: "owner/repo",
  worktreeRoot: "/wt",
});

function snapshot(overrides: Partial<Parameters<typeof buildDoctorSnapshot>[0]> = {}) {
  return buildDoctorSnapshot({
    cwd: "/repo",
    projects: [project],
    issues: [],
    openPrs: [],
    worktrees: [],
    gitStatuses: {},
    nowMs: Date.parse("2026-07-05T00:00:00Z"),
    ...overrides,
  });
}

describe("pi-looper doctor", () => {
  it("reports the blocked issue requeue command", () => {
    const result = snapshot({ issues: [{ number: 1, labels: ["agent:blocked"] }] });

    expect(result.findings[0]?.commands).toContain(
      "gh issue edit 1 --remove-label agent:blocked --add-label agent:implement",
    );
  });

  it("summarizes the latest blocked comment", () => {
    const result = snapshot({
      issues: [
        {
          number: 1,
          labels: ["agent:blocked"],
          comments: [{ body: "BLOCKED: missing API token.\n\nTry again later.", createdAt: "2026-07-04T00:00:00Z" }],
        },
      ],
    });

    expect(result.findings[0]?.summary).toContain("BLOCKED: missing API token.");
  });

  it("reports git status command for stale in-progress issues", () => {
    const result = snapshot({
      issues: [
        {
          number: 2,
          labels: ["agent:in-progress"],
          updatedAt: "2026-07-03T23:59:59Z",
        },
      ],
      worktrees: [{ branch: "agent/issue-2-demo", path: "/wt/agent-issue-2-demo", open_workspace_id: "ws-2" }],
    });

    expect(result.findings[0]?.commands).toContain("git -C /wt/agent-issue-2-demo status --short");
  });

  it("does not report fresh in-progress issues", () => {
    const result = snapshot({
      issues: [{ number: 2, labels: ["agent:in-progress"], updatedAt: "2026-07-04T00:00:01Z" }],
    });

    expect(result.findings).toEqual([]);
  });

  it("reports cleanup command for clean orphan linked worktrees", () => {
    const result = snapshot({
      worktrees: [{ branch: "agent/issue-3-old", path: "/wt/agent-issue-3-old", open_workspace_id: "ws-3" }],
      gitStatuses: { "/wt/agent-issue-3-old": "" },
    });

    expect(result.findings[0]?.commands).toContain("herdr worktree remove --workspace ws-3");
  });

  it("reports confirmation command for dirty orphan linked worktrees", () => {
    const result = snapshot({
      worktrees: [{ branch: "agent/issue-4-dirty", path: "/wt/agent-issue-4-dirty", open_workspace_id: "ws-4" }],
      gitStatuses: { "/wt/agent-issue-4-dirty": " M src/file.ts" },
    });

    expect(result.findings[0]?.commands).toContain("git -C /wt/agent-issue-4-dirty status --short");
  });

  it("ignores linked worktrees with an open PR", () => {
    const result = snapshot({
      openPrs: [{ number: 5, headRefName: "agent/issue-5-active" }],
      worktrees: [{ branch: "agent/issue-5-active", path: "/wt/agent-issue-5-active", open_workspace_id: "ws-5" }],
      gitStatuses: { "/wt/agent-issue-5-active": "" },
    });

    expect(result.findings).toEqual([]);
  });

  it("reports implement label command for ready-only issues", () => {
    const result = snapshot({ issues: [{ number: 6, labels: ["ready-for-agent"] }] });

    expect(result.findings[0]?.commands).toContain("gh issue edit 6 --add-label agent:implement");
  });

  it("reports triage confirmation command for needs-triage issues", () => {
    const result = snapshot({ issues: [{ number: 7, labels: ["needs-triage"] }] });

    expect(result.findings[0]?.commands).toContain("gh issue view 7");
  });

  it("prints no-problem message when there are no findings", () => {
    const report = formatDoctorReport(snapshot());

    expect(report).toContain("問題なし");
  });
});
