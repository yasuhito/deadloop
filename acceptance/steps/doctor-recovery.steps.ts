import assert from "node:assert/strict";

import { Given, Then, When } from "@cucumber/cucumber";

import { normalizeProject } from "../../src/core";
import { buildDoctorSnapshot, formatDoctorReport, type DoctorInput } from "../../src/doctor";

type DoctorWorld = { input?: DoctorInput; report?: string };

const nowMs = Date.parse("2026-07-05T00:00:00Z");
const project = normalizeProject({
  id: "deadloop",
  repoPath: "/repo",
  githubRepo: "owner/repo",
  worktreeRoot: "/wt",
  automations: [{ id: "auto", name: "issue-coordinator", schedule: "*/10 * * * *", precheckFile: "issue-coordinator.precheck.sh" }],
});

function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    cwd: "/repo",
    projects: [project],
    issues: [],
    openPrs: [],
    worktrees: [],
    gitStatuses: {},
    automationDir: "/ext/automations",
    statePath: "/state/state.json",
    nowMs,
    ...overrides,
  };
}

function setInput(world: DoctorWorld, overrides: Partial<DoctorInput>): void {
  world.input = input(overrides);
}

Given("An Issue has `agent:blocked`", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 1, labels: ["agent:blocked"] }] });
});

Given("A blocking reason is recorded for an Issue with `agent:blocked`", function (this: DoctorWorld) {
  setInput(this, {
    issues: [{
      number: 1,
      labels: ["agent:blocked"],
      comments: [
        { body: "BLOCKED: old reason", createdAt: "2026-07-03T00:00:00Z" },
        { body: "BLOCKED: missing API token.\n\nTry again later.", createdAt: "2026-07-04T00:00:00Z" },
      ],
    }],
  });
});

const requiredVerificationStopComment = "<!-- deadloop:required-verification-blocked:v1 target=issue-8 fingerprint=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->";

Given("An Issue was stopped by unresolved required verification", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 8, labels: ["agent:blocked"], comments: [{ body: requiredVerificationStopComment }] }] });
});

Given("An Issue was stopped by required verification that is now resolved", function (this: DoctorWorld) {
  const resolvedProject = normalizeProject({ ...project, checkCommand: "npm run check" }, {
    localPath: "/state/projects.json",
    repoPolicyPath: "deadloop.json",
    repoPolicyBaseBranch: "origin/main",
    repoPolicyStatus: "loaded",
    repoPolicyAppliedKeys: ["checkCommand"],
    repoPolicyBaseRevision: "a".repeat(40),
    repoPolicyCheckCommand: "npm run check",
  });
  setInput(this, {
    projects: [resolvedProject],
    issues: [{ number: 8, labels: ["agent:blocked"], comments: [{ body: requiredVerificationStopComment }] }],
  });
});

const prRequiredVerificationStopComment = "<!-- deadloop:required-verification-blocked:v1 target=pr-9 fingerprint=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -->";

Given("A pull request was stopped by unresolved required verification", function (this: DoctorWorld) {
  setInput(this, { openPrs: [{ number: 9, labels: ["agent:review", "agent:blocked"], comments: [{ body: prRequiredVerificationStopComment }] }] });
});

Given("A pull request was stopped by required verification that is now resolved", function (this: DoctorWorld) {
  const resolvedProject = normalizeProject({ ...project, checkCommand: "npm run check" }, {
    localPath: "/state/projects.json",
    repoPolicyPath: "deadloop.json",
    repoPolicyBaseBranch: "origin/main",
    repoPolicyStatus: "loaded",
    repoPolicyAppliedKeys: ["checkCommand"],
    repoPolicyBaseRevision: "a".repeat(40),
    repoPolicyCheckCommand: "npm run check",
  });
  setInput(this, {
    projects: [resolvedProject],
    openPrs: [{ number: 9, labels: ["agent:review", "agent:blocked"], comments: [{ body: prRequiredVerificationStopComment }] }],
  });
});

Given("A worktree exists for an Issue with `agent:in-progress` whose updates stopped more than 24 hours ago", function (this: DoctorWorld) {
  setInput(this, {
    issues: [{ number: 2, labels: ["agent:in-progress"], updatedAt: "2026-07-03T23:59:59Z" }],
    worktrees: [{ branch: "agent/issue-2-demo", path: "/wt/agent-issue-2-demo", open_workspace_id: "ws-2" }],
  });
});

Given("An actively worked Issue with `agent:in-progress` was updated recently", function (this: DoctorWorld) {
  setInput(this, {
    issues: [{ number: 2, labels: ["agent:in-progress"], updatedAt: "2026-07-04T00:00:01Z" }],
    agents: [{ name: "deadloop-issue-2-worker", agent_status: "working" }],
  });
});

Given("A clean orphaned worktree exists", function (this: DoctorWorld) {
  setInput(this, {
    worktrees: [{ branch: "agent/issue-3-old", path: "/wt/agent-issue-3-old", open_workspace_id: "ws-3" }],
    gitStatuses: { "/wt/agent-issue-3-old": "" },
  });
});

Given("An orphaned worktree has changes", function (this: DoctorWorld) {
  setInput(this, {
    worktrees: [{ branch: "agent/issue-4-dirty", path: "/wt/agent-issue-4-dirty", open_workspace_id: "ws-4" }],
    gitStatuses: { "/wt/agent-issue-4-dirty": " M src/file.ts" },
  });
});

Given("A worktree is linked to an open pull request", function (this: DoctorWorld) {
  setInput(this, {
    openPrs: [{ number: 5, headRefName: "agent/issue-5-active" }],
    worktrees: [{ branch: "agent/issue-5-active", path: "/wt/agent-issue-5-active", open_workspace_id: "ws-5" }],
    gitStatuses: { "/wt/agent-issue-5-active": "" },
  });
});

Given("An Issue has only `ready-for-agent`", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 6, labels: ["ready-for-agent"] }] });
});

Given("An Issue has `needs-triage`", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 7, labels: ["needs-triage"] }] });
});

Given("A record says the precheck is unavailable", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "precheck_skipped:127", lastAttemptAt: nowMs } } } });
});

Given("A record says the precheck file is missing", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "precheck_file_missing", lastAttemptAt: nowMs } } } });
});

Given("A record contains repeated instances of the same automation failure", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "precheck_error", lastAttemptAt: nowMs, failureStreak: 3 } } } });
});

Given("A record contains a normal idle wait with no work", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "precheck_skipped:1", lastAttemptAt: nowMs, failureStreak: 3 } } } });
});

Given("Automation has been stuck for at least three attempts", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "queued", lastAttemptAt: nowMs - 1_800_001 } } } });
});

Given("There is a recent normal automation attempt", function (this: DoctorWorld) {
  setInput(this, { state: { automations: { "deadloop:auto": { lastResult: "queued", lastAttemptAt: nowMs } } } });
});

Given("A Claude worktree is not trusted", function (this: DoctorWorld) {
  setInput(this, { projects: [normalizeProject({ ...project, workerAgent: "claude" })], claudeConfig: { ok: true, projects: {} } });
});

Given("A Claude worktree is trusted", function (this: DoctorWorld) {
  setInput(this, { projects: [normalizeProject({ ...project, workerAgent: "claude" })], claudeConfig: { ok: true, projects: { "/repo": { hasTrustDialogAccepted: true } } } });
});

Given("A Claude review worktree is not trusted", function (this: DoctorWorld) {
  setInput(this, { projects: [normalizeProject({ ...project, reviewerAgent: "claude" })], claudeConfig: { ok: true, projects: {} } });
});

Given("A worktree uses only Pi", function (this: DoctorWorld) {
  setInput(this, { claudeConfig: { ok: false } });
});

Given("Claude trust configuration cannot be read for a worktree", function (this: DoctorWorld) {
  setInput(this, { projects: [normalizeProject({ ...project, workerAgent: "claude" })], claudeConfig: { ok: false } });
});

Given("A pull request has `agent:in-progress` but no active review agent", function (this: DoctorWorld) {
  setInput(this, { openPrs: [{ number: 10, headRefName: "agent/issue-10-demo", labels: ["agent:in-progress"] }] });
});

Given("A pull request has `agent:in-progress` and a retained launch-failed attempt", function (this: DoctorWorld) {
  setInput(this, {
    openPrs: [{ number: 10, headRefName: "agent/issue-10-demo", labels: ["agent:in-progress"] }],
    retainedClaims: [{ kind: "pull-request", number: 10 }],
  });
});

Given("A pull request has `agent:in-progress` and ownership of its retained attempt record cannot be determined", function (this: DoctorWorld) {
  setInput(this, {
    openPrs: [{ number: 10, headRefName: "agent/issue-10-demo", labels: ["agent:in-progress"] }],
    retainedClaimOwnershipAmbiguous: true,
  });
});

Given("A pull request has `agent:in-progress` and an active review agent", function (this: DoctorWorld) {
  setInput(this, {
    openPrs: [{ number: 10, headRefName: "agent/issue-10-demo", labels: ["agent:in-progress"] }],
    agents: [{ name: "deadloop-pr-10-reviewer", agent_status: "working" }],
  });
});

Given("An Issue with `agent:in-progress` has a worktree but no active Worker", function (this: DoctorWorld) {
  setInput(this, {
    issues: [{ number: 11, labels: ["agent:in-progress"] }],
    worktrees: [{ branch: "agent/issue-11-demo", path: "/wt/agent-issue-11-demo", open_workspace_id: "ws-11" }],
  });
});

Given("An Issue and a pull request have no claim labels", function (this: DoctorWorld) {
  setInput(this, { issues: [{ number: 13, labels: [] }], openPrs: [{ number: 12, headRefName: "agent/issue-12-demo", labels: [] }] });
});

Given("A deadloop project has no problems", function (this: DoctorWorld) {
  setInput(this, {});
});

When("The operator runs doctor", function (this: DoctorWorld) {
  if (!this.input) throw new Error("doctor input is missing");
  this.report = formatDoctorReport(buildDoctorSnapshot(this.input));
});

Then("doctor shows a command to requeue the Issue", function (this: DoctorWorld) {
  assert.match(this.report || "", /gh issue edit 1 --remove-label agent:blocked --add-label agent:implement/);
});

Then("doctor displays the latest blocking reason", function (this: DoctorWorld) {
  assert.match(this.report || "", /BLOCKED: missing API token\./);
});

Then("doctor does not show its requeue command", function (this: DoctorWorld) {
  assert.doesNotMatch(this.report || "", /gh issue edit 8 .*--add-label agent:implement/);
});

Then("doctor shows its target-specific requeue command", function (this: DoctorWorld) {
  assert.match(this.report || "", /gh issue edit 8 --remove-label agent:blocked --add-label agent:implement/);
});

Then("doctor does not show its PR requeue command", function (this: DoctorWorld) {
  assert.doesNotMatch(this.report || "", /gh pr edit 9 .*--add-label agent:review/);
});

Then("doctor shows its PR-specific requeue command", function (this: DoctorWorld) {
  assert.match(this.report || "", /gh pr edit 9 -R owner\/repo --remove-label agent:blocked --remove-label agent:review && gh pr edit 9 -R owner\/repo --add-label agent:review/);
});

Then("doctor shows a command to inspect changes in the stale worktree", function (this: DoctorWorld) {
  assert.match(this.report || "", /git -C \/wt\/agent-issue-2-demo status --short/);
});

Then("doctor shows a command to inspect the worktree with changes", function (this: DoctorWorld) {
  assert.match(this.report || "", /git -C \/wt\/agent-issue-4-dirty status --short/);
});

Then("doctor shows no findings", function (this: DoctorWorld) {
  assert.match(this.report || "", /Findings: none/);
});

Then("doctor shows a command to clean up the worktree", function (this: DoctorWorld) {
  assert.match(this.report || "", /herdr worktree remove --workspace ws-3/);
});

Then("doctor shows a command to enqueue the Issue", function (this: DoctorWorld) {
  assert.match(this.report || "", /gh issue edit 6 --add-label agent:implement/);
});

Then("doctor shows a command to inspect the Issue", function (this: DoctorWorld) {
  assert.match(this.report || "", /gh issue view 7/);
});

Then("doctor shows a command to requeue the Issue that needs triage", function (this: DoctorWorld) {
  assert.match(this.report || "", /gh issue edit 7 --remove-label needs-triage --add-label ready-for-agent --add-label agent:implement/);
});

Then("doctor shows a command to inspect the precheck file", function (this: DoctorWorld) {
  assert.match(this.report || "", /ls \/ext\/automations\/issue-coordinator\.precheck\.sh/);
});

Then("doctor shows the recurring automation failure", function (this: DoctorWorld) {
  assert.match(this.report || "", /\[automation_spinning\]/);
});

Then("doctor shows the stuck automation", function (this: DoctorWorld) {
  assert.match(this.report || "", /\[coordinator_stalled\]/);
});

Then("doctor shows a command to open the Claude worktree", function (this: DoctorWorld) {
  assert.match(this.report || "", /cd \/repo && claude/);
});

Then("doctor shows a command to inspect Claude trust configuration", function (this: DoctorWorld) {
  assert.match(this.report || "", /jq --arg p \/repo '.projects\[\$p\]\.hasTrustDialogAccepted' ~\/\.claude\.json/);
});

Then("doctor shows a command to release the review claim", function (this: DoctorWorld) {
  assert.match(this.report || "", /gh pr edit 10 -R owner\/repo --remove-label agent:in-progress/);
});

Then("doctor does not show a command that releases only the review claim", function (this: DoctorWorld) {
  assert.doesNotMatch(this.report || "", /gh pr edit 10 .*--remove-label agent:in-progress/);
});

Then("doctor shows a command to inspect commits in the worktree", function (this: DoctorWorld) {
  assert.match(this.report || "", /git -C \/wt\/agent-issue-11-demo log origin\/main\.\.HEAD --oneline/);
});

Then("doctor explicitly reports no findings", function (this: DoctorWorld) {
  assert.match(this.report || "", /Findings: none/);
});

Then("doctor shows the configuration source", function (this: DoctorWorld) {
  assert.match(this.report || "", /config: local=unknown local projects\.json; repoPolicy=origin\/main:deadloop\.json \(not-read\)/);
});
