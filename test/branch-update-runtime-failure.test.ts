import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { reportObservation } = require("../src/monitor-handoff-observation.cts");
const { applyTerminalMonitorDisposition } = require("../extensions/deadloop/automations/contain-terminal-monitor.cts");
const {
  branchUpdateFailureRestartable,
  recoverableBlockedBranchUpdateHead,
} = require("../extensions/deadloop/automations/pr-reviewer-driver.cts");

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const ATTEMPT_ID = "attempt-1";
const STOP_ATTEMPT_ID = "restart-1";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formal storage-exhaustion evidence for a stopped branch update", () => {
  it("classifies an EDQUOT completion-report read failure as observed storage exhaustion", () => {
    const record = { promiseFile: "/runs/attempt-1/promise.json" };
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw Object.assign(new Error("quota exceeded"), { code: "EDQUOT" });
    });

    expect(reportObservation(record)).toEqual({ kind: "invalid", cause: "storage_exhaustion" });
  });
});

function writeAttemptRecord(root: string, overrides: Record<string, unknown> = {}): { runDir: string; promiseFile: string; worktreePath: string } {
  const runDir = path.join(root, "runs", String(overrides.attemptId || ATTEMPT_ID));
  const worktreePath = path.join(root, "worktrees", "pr-42");
  const promiseFile = path.join(runDir, "promise.json");
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(runDir, "attempt.json"), `${JSON.stringify({
    attemptId: ATTEMPT_ID,
    launchUuid: "launch-1",
    project: "demo",
    repository: "octo/demo",
    role: "branch-update",
    target: { kind: "pull-request", number: 42 },
    inputRevision: { head: HEAD, base: BASE },
    branch: "pr-42",
    worktreePath,
    agentName: "demo-pr-42-branch-update-x",
    workspaceLabel: "demo-pr-42-branch-update-x",
    promptFile: path.join(runDir, "branch-update-prompt.md"),
    promiseFile,
    phase: "agent_started",
    lastSuccessfulPhase: "agent_started",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    rootPaneId: "pane-1",
    ...overrides,
  })}\n`);
  return { runDir, promiseFile, worktreePath };
}

function fixture(dispositionReason = "missing_completion_report") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-update-failure-"));
  const { runDir, promiseFile, worktreePath } = writeAttemptRecord(root);
  const target = {
    number: 42,
    state: "OPEN",
    headRefOid: HEAD,
    labels: ["agent:in-progress", "triage"],
  };
  const comments: Record<string, unknown>[] = [];
  let open = true;
  const runner = {
    listAgents: () => open ? [{ name: "demo-pr-42-branch-update-x", paneId: "pane-1", cwd: worktreePath, status: "done" }] : [],
    listWorkspaces: () => open ? [{ workspaceId: "workspace-1", worktreePath, tabCount: 1, paneCount: 1 }] : [],
    listWorktrees: () => [{ path: worktreePath }],
    closeWorkspace: () => { open = false; },
  };
  const commandRunner = {
    runText: () => "terminal failure",
    runJson: (_args: string[], options: { input?: string } = {}) => {
      if (options.input) target.labels = JSON.parse(options.input).labels;
      return target.labels;
    },
  };
  const github: Record<string, unknown> = {
    getIssue: () => ({ ...target }),
    getPr: () => ({ ...target }),
    listIssueComments: () => [...comments],
    listPrComments: () => [...comments],
    commentPr: (_repo: string, _number: number, body: string) => comments.push({
      user: { login: "deadloop-bot" }, body, created_at: "2026-08-26T00:00:00Z", updated_at: "2026-08-26T00:00:00Z",
    }),
  };
  const handoffInput = {
    attemptRecordFile: path.join(runDir, "attempt.json"),
    promiseFile,
    prNumber: 42,
    expectedHeadOid: HEAD,
    expectedBaseOid: BASE,
    branch: "pr-42",
    automationDir: "/automation",
    actorName: "branch-update worker",
    projectId: "demo",
    repoPath: root,
    githubRepo: "octo/demo",
    stateDir: root,
    enabledAt: 1,
  };
  const input = {
    handoff: { kind: "branch-update", input: handoffInput },
    disposition: { action: "stop", reason: dispositionReason },
    project: {
      id: "demo",
      repoPath: root,
      githubRepo: "octo/demo",
      stateDir: root,
      enabledAt: 1,
      automationLogin: "deadloop-bot",
      labels: {
        explore: "agent:explore",
        implement: "agent:implement",
        review: "agent:review",
        updateBranch: "agent:update-branch",
        inProgress: "agent:in-progress",
        blocked: "agent:blocked",
      },
    },
  };
  const dependencies = {
    commandRunner,
    runner,
    github,
    withEnabledProjectLock: (_project: unknown, operation: (enabled: unknown, recheck: () => void) => boolean) =>
      operation({}, () => undefined),
  };
  return {
    comments,
    dependencies,
    github,
    input,
    promiseFile,
    root,
    target,
    worktreePath,
    /** The formal channel: the attempt's report file exists, but deadloop cannot read it. */
    breakPromiseRead(code = "ENOSPC") {
      const real = fs.readFileSync;
      vi.spyOn(fs, "readFileSync").mockImplementation(((file: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) => {
        if (String(file) === promiseFile) throw Object.assign(new Error("storage broken"), { code });
        return (real as (...args: unknown[]) => string)(file, ...rest);
      }) as typeof fs.readFileSync);
    },
    setChangedHeadBeforeComment() {
      const changed = `${"c".repeat(39)}d`;
      github.commentPr = (repo: string, number_: number, body: string) => {
        target.headRefOid = changed;
        return (github.commentPr as unknown as (...args: unknown[]) => Record<string, unknown>)(repo, number_, body);
      };
    },
    setBaseResolvedAfterFirstObservation() {
      let prReads = 0;
      github.getPr = () => {
        prReads += 1;
        return prReads > 1 ? { ...target, mergeable: "MERGEABLE" } : { ...target };
      };
    },
    advanceQueuedRequestGeneration(latestEventId: string) {
      github.listPrTimelineEvents = () => [
        { id: "req-1", event: "labeled", created_at: "2026-08-25T00:00:00Z", label: { name: "agent:update-branch" } },
        { id: latestEventId, event: "labeled", created_at: "2026-08-26T00:10:00Z", label: { name: "agent:update-branch" } },
      ];
    },
  };
}

describe("the published failure record for a stopped branch update", () => {
  it("records a formal EDQUOT read failure as the capacity stop bound to the selected pair", () => {
    const world = fixture("storage_exhaustion");
    world.breakPromiseRead("EDQUOT");
    applyTerminalMonitorDisposition(world.input as never, world.dependencies as never);

    expect(String(world.comments[0]?.body))
      .toContain(`<!-- deadloop:terminal-monitor-stop attempt=${ATTEMPT_ID} head=${HEAD} base=${BASE} reason=storage_exhaustion -->`);
  });

  it("binds the generic technical failure to the attempt, the selection-time head, and the selected base", () => {
    const world = fixture();
    applyTerminalMonitorDisposition(world.input as never, world.dependencies as never);

    expect(String(world.comments[0]?.body))
      .toContain(`Selected base head at selection: \`${BASE}\``);
  });

  it("posts one comment when the same failure is processed again", () => {
    const world = fixture();
    applyTerminalMonitorDisposition(world.input as never, world.dependencies as never);
    applyTerminalMonitorDisposition(world.input as never, world.dependencies as never);

    expect(world.comments).toHaveLength(1);
  });

  it("omits local worktree and completion-report paths from the public comment", () => {
    const world = fixture();
    applyTerminalMonitorDisposition(world.input as never, world.dependencies as never);
    const body = String(world.comments[0]?.body || "");

    expect([world.worktreePath, world.promiseFile].some((localPath) => body.includes(localPath))).toBe(false);
  });
});

describe("the pre-mutation guards around a stopped update", () => {
  it("does not post the comment when the head changes just before posting", () => {
    const world = fixture();
    world.setChangedHeadBeforeComment();
    try {
      applyTerminalMonitorDisposition(world.input as never, world.dependencies as never);
    } catch {}

    expect(world.comments).toHaveLength(0);
  });

  it("publishes nothing once GitHub reports the conflict resolved against the selected base", () => {
    const world = fixture();
    world.setBaseResolvedAfterFirstObservation();
    try {
      applyTerminalMonitorDisposition(world.input as never, world.dependencies as never);
    } catch {}

    expect(world.comments).toHaveLength(0);
  });

  it("leaves the labels untouched when the queued request generation advanced during the run", () => {
    const world = fixture();
    writeAttemptRecord(world.root, { attemptId: ATTEMPT_ID, requestEventId: "req-1" });
    world.advanceQueuedRequestGeneration("req-2");
    try {
      applyTerminalMonitorDisposition(world.input as never, world.dependencies as never);
    } catch {}

    expect(world.target.labels).toEqual(["agent:in-progress", "triage"]);
  });

  it("honors a completion report that appeared before the stop applies", () => {
    const world = fixture();
    fs.writeFileSync(world.promiseFile, JSON.stringify({
      schemaVersion: 1,
      attemptId: ATTEMPT_ID,
      role: "branch-update",
      status: "complete",
      summary: "pushed after all",
      target: { repository: "octo/demo", kind: "pull-request", number: 42 },
      inputRevision: { head: HEAD, base: BASE },
      result: { outcome: "branch_update_pushed", outputRevision: `${"c".repeat(39)}d` },
      evidence: { finalizer: {} },
    }));

    const applied = applyTerminalMonitorDisposition(world.input as never, world.dependencies as never);

    expect(applied).toBe(false);
  });
});

function restartWorld(options: {
  buildAgents?: (worktreePath: string) => Array<Record<string, unknown>>;
  releaseReason?: string;
  omitJournal?: boolean;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-update-restart-"));
  if (!options.omitJournal) {
    writeAttemptRecord(root, {
      attemptId: STOP_ATTEMPT_ID,
      phase: "authority_released",
      authorityRelease: { reason: options.releaseReason || "terminal_missing_report", releasedAt: "2026-08-26T00:00:00Z" },
    });
  }
  const pr = {
    number: 42,
    headRefName: "pr-42",
    headRefOid: HEAD,
    comments: [{
      author: { login: "deadloop-bot" },
      body: `deadloop stopped this attempt.\n\n<!-- deadloop:terminal-monitor-stop attempt=${STOP_ATTEMPT_ID} head=${HEAD} base=${BASE} reason=missing_completion_report -->`,
    }],
  };
  const env = {
    projectId: "demo",
    githubRepo: "octo/demo",
    stateDir: root,
    automationLogin: "deadloop-bot",
    worktreeRoot: path.join(root, "worktrees"),
  };
  const worktreePath = path.join(root, "worktrees", "pr-42");
  const fixture = { agents: { result: { agents: options.buildAgents ? options.buildAgents(worktreePath) : [] } } };
  return { env, fixture, pr, worktreePath };
}

describe("the retained checkout of a stopped update", () => {
  const midMergeHead = "c".repeat(40);

  function checkoutWorld(statusOutput = "") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-update-checkout-"));
    writeAttemptRecord(root, {
      attemptId: STOP_ATTEMPT_ID,
      phase: "authority_released",
      authorityRelease: { reason: "terminal_missing_report", releasedAt: "2026-08-26T00:00:00Z" },
    });
    return recoverableBlockedBranchUpdateHead(
      { number: 42, headRefName: "pr-42", headRefOid: HEAD } as never,
      { projectId: "demo", githubRepo: "octo/demo", stateDir: root, worktreeRoot: path.join(root, "worktrees") } as never,
      { runText: (args: string[]) => (args.includes("rev-parse") ? `${midMergeHead}\n` : args.includes("status") ? statusOutput : "") },
    );
  }

  it("preserves the mid-merge checkout of a runtime-failed update as the recovery checkout", () => {
    expect(checkoutWorld()).toBe(midMergeHead);
  });

  it("keeps no recovery checkout when the stopped worktree holds uncommitted work", () => {
    expect(checkoutWorld("?? scratch.c\n")).toBeUndefined();
  });
});

describe("restart eligibility of a published update failure", () => {
  it("allows a new request to restart when the journal, the published marker, and a quiet runtime agree", () => {
    const world = restartWorld();

    expect(branchUpdateFailureRestartable(world.pr as never, world.env as never, world.fixture as never, HEAD, BASE)).toBe(true);
  });

  it("refuses to restart while another agent still occupies the stopped checkout", () => {
    const world = restartWorld({
      buildAgents: (worktreePath) => [{ name: "demo-pr-42-branch-update-x", paneId: "pane-1", cwd: worktreePath, status: "working" }],
    });

    expect(branchUpdateFailureRestartable(world.pr as never, world.env as never, world.fixture as never, HEAD, BASE)).toBe(false);
  });

  it("refuses to restart when liveness cannot resolve the stopped checkout", () => {
    const world = restartWorld({
      buildAgents: (worktreePath) => [{ name: "some-other-agent", paneId: "pane-9", cwd: worktreePath, status: "done" }],
    });

    expect(branchUpdateFailureRestartable(world.pr as never, world.env as never, world.fixture as never, HEAD, BASE)).toBe(false);
  });

  it("refuses to restart when no retained journal matches the published stop", () => {
    const world = restartWorld({ omitJournal: true });

    expect(branchUpdateFailureRestartable(world.pr as never, world.env as never, world.fixture as never, HEAD, BASE)).toBe(false);
  });

  it("treats a superseded prior attempt as an exhausted pair rather than a restartable failure", () => {
    const world = restartWorld({ releaseReason: "superseded_by_request" });

    expect(branchUpdateFailureRestartable(world.pr as never, world.env as never, world.fixture as never, HEAD, BASE)).toBe(false);
  });
});
