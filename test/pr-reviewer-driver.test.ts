import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
const { renderBranchUpdateMarker } = require("../extensions/deadloop/automations/pr-branch-update-state.cts");

const {
  branchUpdateLaunchPlan,
  branchUpdatePairWasAttempted,
  consumeRequestEvent,
  recoverableBlockedBranchUpdateHead,
  resolveAuthorizedAutomationLogins,
} = require("../extensions/deadloop/automations/pr-reviewer-driver.cts");

type RaceStage = "add-in-progress" | "delete-implement" | "delete-blocked" | "delete-selected";
type Race = { stage: RaceStage; label: string; action: "labeled" | "unlabeled"; actor?: string };

function scenario(options: {
  labels?: string[];
  races?: Race[];
  deleteStatus?: Partial<Record<RaceStage, number>>;
  afterDeleteRaces?: Race[];
  mutateOnNon200?: RaceStage;
  extraComments?: Record<string, unknown>[];
} = {}) {
  const head = "a".repeat(40);
  const labels = new Set(options.labels || ["agent:review", "agent:implement", "agent:blocked", "customer:keep"]);
  const events: Record<string, any>[] = [
    { id: "implement-20", event: "labeled", created_at: "2026-07-20T09:59:00Z", label: { name: "agent:implement" } },
    { id: "review-22", event: "labeled", created_at: "2026-07-20T10:00:00Z", label: { name: "agent:review" } },
  ];
  let eventSequence = 30;
  let commentsWritten = 0;
  const operations: string[] = [];
  const pr: any = {
    number: 24, state: "OPEN", headRefName: "feature", headRefOid: head,
    labels: [...labels].map((name) => ({ name })), comments: options.extraComments || [],
  };
  const syncLabels = () => { pr.labels = [...labels].map((name) => ({ name })); };
  const applyRaces = (stage: RaceStage, races = options.races || []) => {
    for (const race of races.filter((candidate) => candidate.stage === stage)) {
      eventSequence += 1;
      events.push({
        id: `race-${eventSequence}`,
        event: race.action,
        created_at: `2026-07-20T10:00:${eventSequence}Z`,
        actor: { login: race.actor || "human" },
        label: { name: race.label },
      });
      race.action === "labeled" ? labels.add(race.label) : labels.delete(race.label);
    }
    syncLabels();
  };
  const stageForLabel = (label: string): RaceStage => label === "agent:review"
    ? "delete-selected"
    : label === "agent:blocked" ? "delete-blocked" : "delete-implement";
  const github = {
    getRepositoryIdentity: () => ({ id: "R_repo", nameWithOwner: "owner/repo" }),
    getPr: () => ({ ...pr, labels: [...labels].map((name) => ({ name })) }),
    listPrTimelineEvents: () => [...events],
    listPrLabels: () => [...labels].map((name) => ({ name })),
    addPrLabel: (_repo: string, _number: number, label: string) => {
      operations.push(`add:${label}`);
      labels.add(label);
      applyRaces("add-in-progress");
    },
    deletePrLabel: (_repo: string, _number: number, label: string) => {
      const stage = stageForLabel(label);
      operations.push(`delete:${label}`);
      applyRaces(stage);
      const status = options.deleteStatus?.[stage] ?? (labels.has(label) ? 200 : 404);
      if (status === 200 || options.mutateOnNon200 === stage) {
        labels.delete(label);
        eventSequence += 1;
        events.push({
          id: `operation-${eventSequence}`,
          event: "unlabeled",
          created_at: `2026-07-20T10:00:${eventSequence}Z`,
          actor: { login: "deadloop-bot" },
          label: { name: label },
        });
      }
      applyRaces(stage, options.afterDeleteRaces || []);
      syncLabels();
      return { status };
    },
    movePrLabels: (_repo: string, _number: number, move: { add?: string[]; remove?: string[] }) => {
      operations.push(`move:${JSON.stringify(move)}`);
      for (const label of move.add || []) labels.add(label);
      for (const label of move.remove || []) labels.delete(label);
      syncLabels();
    },
    commentPr: () => { commentsWritten += 1; },
  };
  const env = {
    githubRepo: "owner/repo", githubRepositoryId: "R_repo", automationLogin: "deadloop-bot",
    authorizedAutomationLogins: ["deadloop-bot"], reviewLabel: "agent:review",
    implementLabel: "agent:implement", updateBranchLabel: "agent:update-branch",
    inProgressLabel: "agent:in-progress", blockedLabel: "agent:blocked",
    stateDir: path.join(tmpdir(), "missing-deadloop-state"), projectId: "demo",
  };
  try {
    const consumed = consumeRequestEvent(github, pr, env, "reviewer", () => "deadloop-bot");
    return { consumed, labels: [...labels], commentsWritten, operations };
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    Object.assign(error, { labels: [...labels], operations });
    throw error;
  }
}

function failedScenario(options: Parameters<typeof scenario>[0]) {
  try { scenario(options); } catch (error) { return error as Error & { labels: string[]; operations: string[] }; }
  throw new Error("scenario unexpectedly succeeded");
}

describe("PR request consumption", () => {
  it("authorizes no login when automationLogins is empty", () => {
    expect(resolveAuthorizedAutomationLogins([])).toEqual([]);
  });

  it("binds consumption to the latest selected request event id", () => {
    expect(scenario().consumed.requestEventId).toBe("review-22");
  });

  it("does not publish a machine-readable claim comment", () => {
    expect(scenario().commentsWritten).toBe(0);
  });

  it("preserves unrelated labels while consuming the request", () => {
    expect(scenario().labels).toContain("customer:keep");
  });

  it("adds in-progress before individually deleting baseline managed labels", () => {
    expect(scenario().operations.slice(0, 4)).toEqual([
      "add:agent:in-progress",
      "delete:agent:implement",
      "delete:agent:blocked",
      "delete:agent:review",
    ]);
  });

  it("ignores an old claim comment left on the pull request", () => {
    expect(scenario({ extraComments: [{ id: 101, body: "<!-- deadloop:review-claim v1=obsolete -->" }] }).consumed.requestEventId).toBe("review-22");
  });

  it("preserves a new request added while in-progress is added", () => {
    expect(failedScenario({ races: [{ stage: "add-in-progress", label: "agent:update-branch", action: "labeled" }] }).labels).toContain("agent:update-branch");
  });

  it("preserves a new nonselected request generation that is live after normalization", () => {
    expect(failedScenario({ afterDeleteRaces: [
      { stage: "delete-implement", label: "agent:implement", action: "labeled" },
    ] }).labels).toContain("agent:implement");
  });

  it("does not resurrect a same-login cancellation during normalization", () => {
    expect(failedScenario({ races: [{ stage: "delete-implement", label: "agent:implement", action: "unlabeled", actor: "deadloop-bot" }] }).labels).not.toContain("agent:implement");
  });

  it("preserves a new selected request generation that is live after the linearization point", () => {
    expect(failedScenario({ afterDeleteRaces: [
      { stage: "delete-selected", label: "agent:review", action: "labeled" },
    ] }).labels).toContain("agent:review");
  });

  it("does not resurrect a selected request added and cancelled after DELETE", () => {
    expect(failedScenario({ afterDeleteRaces: [
      { stage: "delete-selected", label: "agent:review", action: "labeled" },
      { stage: "delete-selected", label: "agent:review", action: "unlabeled" },
    ] }).labels).not.toContain("agent:review");
  });

  it("does not resurrect a nonselected request added and cancelled after DELETE", () => {
    expect(failedScenario({ afterDeleteRaces: [
      { stage: "delete-implement", label: "agent:implement", action: "labeled" },
      { stage: "delete-implement", label: "agent:implement", action: "unlabeled" },
    ] }).labels).not.toContain("agent:implement");
  });

  it("fails closed when another host wins the selected DELETE", () => {
    expect(() => scenario({ deleteStatus: { "delete-selected": 404 } })).toThrow("documented 200");
  });

  it("fails closed when the selected DELETE response is ambiguous", () => {
    expect(() => scenario({ deleteStatus: { "delete-selected": 0 } })).toThrow("documented 200");
  });

  it("does not launch or restore after an ambiguous response whose server mutation succeeded", () => {
    expect(failedScenario({
      deleteStatus: { "delete-selected": 0 }, mutateOnNon200: "delete-selected",
    }).labels).not.toContain("agent:review");
  });

  it("does not restore a nonselected label after its ambiguous DELETE mutated the server", () => {
    expect(failedScenario({
      deleteStatus: { "delete-implement": 0 }, mutateOnNon200: "delete-implement",
    }).labels).not.toContain("agent:implement");
  });

  it("leaves in-progress visible after a partial normalization failure", () => {
    expect(failedScenario({ deleteStatus: { "delete-implement": 404 } }).labels).toContain("agent:in-progress");
  });

  it("leaves the selected request available for reprocessing after an earlier DELETE fails", () => {
    expect(failedScenario({ deleteStatus: { "delete-implement": 404 } }).labels).toContain("agent:review");
  });

  it("revalidates nonselected role generations before reaching the selected DELETE", () => {
    expect(failedScenario({ races: [{ stage: "delete-blocked", label: "agent:update-branch", action: "labeled" }] }).message).toContain("request generation changed");
  });

  it("does not reach selected consumption after a request race at the blocked-label stage", () => {
    expect(failedScenario({ races: [{ stage: "delete-blocked", label: "agent:update-branch", action: "labeled" }] }).operations).not.toContain("delete:agent:review");
  });
});

describe("branch update launch plan", () => {
  const launchEnv = {
    projectId: "demo", baseBranch: "origin/main", repoPath: "/repo", automationDir: "/automation", stateDir: "/state",
    worktreeRoot: "/worktrees", githubRepo: "owner/repo", branchUpdateAgent: "pi", branchUpdateModel: "",
    branchUpdateRemote: "origin", enabledAt: 1, checkCommand: "npm test", requiredVerification: {},
  };
  const pr = { number: 31, headRefName: "agent/issue-31", headRefOid: "a".repeat(40) };
  const decision = { headOid: "a".repeat(40), baseOid: "b".repeat(40) };

  it("persists a custom base branch in the branch-update worktree request", () => {
    const plan = branchUpdateLaunchPlan(pr, { ...launchEnv, baseBranch: "origin/develop" }, decision, "launch-uuid");

    expect(plan.input.worktree.baseBranch).toBe("origin/develop");
  });

  it("describes the finalizer leased push without allowing direct force-push", () => {
    const plan = branchUpdateLaunchPlan(pr, launchEnv, decision, "launch-uuid");

    expect(plan.input.renderPrompt({ promiseFile: "/state/runs/x/promise.json", worktreePath: "/worktree" })).toContain("only permitted push to the driver-selected branch, leased to the validated head");
  });

  it("carries a proven retained recovery head into checkout alignment", () => {
    const preservedHead = "c".repeat(40);
    const plan = branchUpdateLaunchPlan(pr, launchEnv, decision, "launch-uuid", preservedHead);

    expect(plan.input.preservedCheckoutHead).toBe(preservedHead);
  });

  it("proves a clean descendant from a released blocked branch-update attempt", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "deadloop-retained-update-"));
    const runDir = path.join(stateDir, "runs", "attempt-1");
    const promiseFile = path.join(runDir, "promise.json");
    const expectedHead = "a".repeat(40);
    const preservedHead = "c".repeat(40);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
      attemptId: "attempt-1",
      launchUuid: "launch-1",
      project: "demo",
      repository: "owner/repo",
      role: "branch-update",
      target: { kind: "pull-request", number: 31 },
      inputRevision: { head: expectedHead, base: "b".repeat(40) },
      branch: "agent/issue-31",
      baseBranch: "origin/main",
      worktreePath: "/worktrees/agent-issue-31",
      agentName: "dl-u-31-deadbeef0000",
      workspaceLabel: "branch update",
      promptFile: path.join(runDir, "prompt.md"),
      promiseFile,
      phase: "authority_released",
      lastSuccessfulPhase: "agent_started",
      workspaceId: "workspace-1",
      tabId: "tab-1",
      rootPaneId: "pane-1",
      authorityRelease: { reason: "owner_absent", releasedAt: "2026-08-20T07:56:13Z" },
    }));
    writeFileSync(promiseFile, JSON.stringify({
      schemaVersion: 1,
      attemptId: "attempt-1",
      role: "branch-update",
      target: { repository: "owner/repo", kind: "pull-request", number: 31 },
      inputRevision: { head: expectedHead, base: "b".repeat(40) },
      status: "blocked",
      summary: "Required verification failed",
      result: {
        reason: "required_verification_failed",
        explanation: "npm test failed",
        recovery: "fix and requeue",
      },
      evidence: {},
    }));

    try {
      const recovered = recoverableBlockedBranchUpdateHead(
        { ...pr, labels: [{ name: "agent:blocked" }, { name: "agent:update-branch" }] },
        { ...launchEnv, stateDir, blockedLabel: "agent:blocked", updateBranchLabel: "agent:update-branch" },
        {
          runText: (args: string[]) => args.includes("rev-parse") ? preservedHead : "",
        },
      );
      expect(recovered).toBe(preservedHead);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not exhaust a head/base pair whose matching attempt never launched", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "deadloop-never-launched-update-"));
    const runDir = path.join(stateDir, "runs", "attempt-1");
    const headOid = "a".repeat(40);
    const baseOid = "b".repeat(40);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "attempt.json"), JSON.stringify({
      attemptId: "attempt-1",
      launchUuid: "launch-1",
      project: "demo",
      repository: "owner/repo",
      role: "branch-update",
      target: { kind: "pull-request", number: 31 },
      inputRevision: { head: headOid, base: baseOid },
      branch: "agent/issue-31",
      baseBranch: "origin/main",
      worktreePath: "/worktrees/agent-issue-31",
      agentName: "dl-u-31-deadbeef0000",
      workspaceLabel: "branch update",
      promptFile: path.join(runDir, "prompt.md"),
      promiseFile: path.join(runDir, "promise.json"),
      phase: "authority_released",
      lastSuccessfulPhase: "github_claimed",
      launchError: "workspace was still open",
      requestEventId: "request-1",
      authorityRelease: { reason: "never_launched", releasedAt: "2026-08-20T10:02:12Z" },
    }));

    try {
      expect(branchUpdatePairWasAttempted(
        { ...pr, comments: [{ body: renderBranchUpdateMarker(headOid, baseOid) }] },
        { ...launchEnv, stateDir },
        headOid,
        baseOid,
      )).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // The removed precheck skipped candidate-free ticks before any driver ran; the driver's own
  // first skip branch now observes the same early skip.
  it("skips candidate-free runs", () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "deadloop-reviewer-state-"));
    try {
      const result = spawnSync("node", ["extensions/deadloop/automations/pr-reviewer-driver.cts", "--fixture", "test/fixtures/pr-reviewer-driver/no-candidate.json"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          DEADLOOP_PROJECT_ID: "demo",
          DEADLOOP_REPO_PATH: "/repo",
          DEADLOOP_GITHUB_REPO: "owner/repo",
          DEADLOOP_AUTHORIZED_AUTOMATION_LOGINS: "deadloop-bot",
          DEADLOOP_STATE_DIR: stateDir,
        },
      });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      expect(JSON.parse(result.stdout)).toMatchObject({ action: "skip" });
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
