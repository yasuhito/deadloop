import { describe, expect, it } from "vitest";

import { normalizeProject } from "../src/core";
import { buildDoctorSnapshot, formatDoctorReport } from "../src/doctor";

const project = normalizeProject({
  id: "deadloop",
  repoPath: "/repo",
  githubRepo: "owner/repo",
  worktreeRoot: "/wt",
  automations: [
    { id: "auto", name: "issue-coordinator", schedule: "*/10 * * * *", precheckFile: "issue-coordinator.precheck.sh" },
  ],
});

const NOW = Date.parse("2026-07-05T00:00:00Z");
const SLOT_MS = 10 * 60_000;

function withAutomationState(entry: Record<string, unknown>) {
  return { state: { automations: { "deadloop:auto": entry } } };
}

const claudeProject = normalizeProject({
  id: "deadloop",
  repoPath: "/repo",
  githubRepo: "owner/repo",
  worktreeRoot: "/wt",
  workerAgent: "claude",
});

const reviewerClaudeProject = normalizeProject({
  id: "deadloop",
  repoPath: "/repo",
  githubRepo: "owner/repo",
  worktreeRoot: "/wt",
  workerAgent: "pi",
  reviewerAgent: "claude",
});

function snapshot(overrides: Partial<Parameters<typeof buildDoctorSnapshot>[0]> = {}) {
  return buildDoctorSnapshot({
    cwd: "/repo",
    projects: [project],
    issues: [],
    openPrs: [],
    worktrees: [],
    gitStatuses: {},
    automationDir: "/ext/automations",
    statePath: "/state/state.json",
    nowMs: NOW,
    ...overrides,
  });
}

function claudeSnapshot(overrides: Partial<Parameters<typeof buildDoctorSnapshot>[0]> = {}) {
  return snapshot({ projects: [claudeProject], ...overrides });
}

describe("deadloop doctor", () => {
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
      agents: [{ name: "deadloop-issue-2-worker", agent_status: "working" }],
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

  it("reports full requeue command for needs-triage issues", () => {
    const result = snapshot({ issues: [{ number: 7, labels: ["needs-triage"] }] });

    expect(result.findings[0]?.commands).toContain(
      "gh issue edit 7 --remove-label needs-triage --add-label ready-for-agent --add-label agent:implement",
    );
  });

  it("reports the precheck file check command for precheck_skipped:127", () => {
    const result = snapshot(
      withAutomationState({ lastResult: "precheck_skipped:127", lastAttemptAt: NOW, failureStreak: 1 }),
    );

    expect(result.findings[0]?.commands).toContain("ls /ext/automations/issue-coordinator.precheck.sh");
  });

  it("reports unavailable precheck when the scheduler records a missing precheck file", () => {
    const result = snapshot(
      withAutomationState({ lastResult: "precheck_file_missing", lastAttemptAt: NOW, failureStreak: 1 }),
    );

    expect(result.findings[0]?.commands).toContain("ls /ext/automations/issue-coordinator.precheck.sh");
  });

  it("reports a spinning-loop finding for repeated identical failures", () => {
    const result = snapshot(
      withAutomationState({ lastResult: "precheck_error", lastAttemptAt: NOW, failureStreak: 3 }),
    );

    expect(result.findings[0]?.type).toBe("automation_spinning");
  });

  it("does not report normal no-work precheck skips as spinning failures", () => {
    const result = snapshot(
      withAutomationState({ lastResult: "precheck_skipped:1", lastAttemptAt: NOW, failureStreak: 3 }),
    );

    expect(result.findings).toEqual([]);
  });

  it("reports a stalled-coordinator finding when attempts stop for 3 slots", () => {
    const result = snapshot(
      withAutomationState({ lastResult: "queued", lastAttemptAt: NOW - 3 * SLOT_MS - 1, failureStreak: 0 }),
    );

    expect(result.findings[0]?.type).toBe("coordinator_stalled");
  });

  it("does not report a healthy automation that just ran", () => {
    const result = snapshot(
      withAutomationState({ lastResult: "queued", lastAttemptAt: NOW, failureStreak: 0 }),
    );

    expect(result.findings).toEqual([]);
  });

  it("reports the claude workspace trust acceptance command for untrusted repos", () => {
    const result = claudeSnapshot({ claudeConfig: { ok: true, projects: {} } });

    expect(result.findings[0]?.commands).toContain("cd /repo && claude");
  });

  it("does not report workspace trust findings for trusted claude repos", () => {
    const result = claudeSnapshot({
      claudeConfig: { ok: true, projects: { "/repo": { hasTrustDialogAccepted: true } } },
    });

    expect(result.findings).toEqual([]);
  });

  it("reports workspace trust for a claude reviewer even when the worker is pi", () => {
    const result = snapshot({ projects: [reviewerClaudeProject], claudeConfig: { ok: true, projects: {} } });

    expect(result.findings[0]?.commands).toContain("cd /repo && claude");
  });

  it("does not report workspace trust findings for pi projects", () => {
    const result = snapshot({ claudeConfig: { ok: false } });

    expect(result.findings).toEqual([]);
  });

  it("reports an inspection command when the claude config is unreadable", () => {
    const result = claudeSnapshot({ claudeConfig: { ok: false } });

    expect(result.findings[0]?.commands).toContain(
      "jq --arg p /repo '.projects[$p].hasTrustDialogAccepted' ~/.claude.json",
    );
  });


  it("reports a stuck reviewing claim when no reviewer agent is running", () => {
    const result = snapshot({
      openPrs: [{ number: 10, headRefName: "agent/issue-10-demo", labels: ["agent:reviewing"] }],
      agents: [],
    });

    expect(result.findings[0]?.commands).toContain("gh pr edit 10 -R owner/repo --remove-label agent:reviewing");
  });

  it("does not report a reviewing claim when the reviewer agent is working", () => {
    const result = snapshot({
      openPrs: [{ number: 10, headRefName: "agent/issue-10-demo", labels: ["agent:reviewing"] }],
      agents: [{ name: "deadloop-pr-10-reviewer", agent_status: "working" }],
    });

    expect(result.findings).toEqual([]);
  });

  it("reports a stuck implement claim with a worktree confirmation command when no worker is running", () => {
    const result = snapshot({
      issues: [{ number: 11, labels: ["agent:in-progress"] }],
      worktrees: [{ branch: "agent/issue-11-demo", path: "/wt/agent-issue-11-demo", open_workspace_id: "ws-11" }],
      agents: [],
    });

    expect(result.findings[0]?.commands).toContain("git -C /wt/agent-issue-11-demo log origin/main..HEAD --oneline");
  });

  it("does not report stuck claims when no claim labels are present", () => {
    const result = snapshot({
      openPrs: [{ number: 12, headRefName: "agent/issue-12-demo", labels: [] }],
      issues: [{ number: 13, labels: [] }],
      agents: [],
    });

    expect(result.findings).toEqual([]);
  });

  it("prints no-problem message when there are no findings", () => {
    const report = formatDoctorReport(snapshot());

    expect(report).toContain("問題なし");
  });

  it("prints the layered config source", () => {
    const report = formatDoctorReport(snapshot());

    expect(report).toContain("config: local=unknown local projects.json; repoPolicy=origin/main:deadloop.json (not-read)");
  });
});
