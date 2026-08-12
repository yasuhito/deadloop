import { describe, expect, it } from "vitest";

import { type AttemptRecord, transitionAttempt } from "../src/attempt-lifecycle";
import {
  doctorFindingForRetention,
  evaluateCompletionPersistence,
  normalizeRunnerUncertainty,
  orchestrateFreshAttemptWorkspace,
  reconcileAttemptWorkspace as reconcileAttemptWorkspaceRuntime,
  reconcileBeforeWorkspaceOpen,
  RunnerUncertaintyError,
  type AttemptReportObservation,
  type CompletionDecisionContext,
  type FreshWorkspaceDependencies,
  type GithubCompletionObservation,
  type ReconciliationDependencies,
  type RetentionReason,
  type RunnerObservation,
  type WorkspaceOwnership,
} from "../src/attempt-workspace-lifecycle";
import {
  BASE_HEAD,
  INPUT_HEAD,
  blockedReport,
  branchUpdateFixture,
  repairFixture,
  reviewerFixture,
  workerFixture,
} from "./fixtures/attempt-workspace";

const { evaluateCompletionPersistence: evaluateSelectedRuntimePersistence } = require("../src/attempt-workspace-predicates.cjs");

function observedV1(report: unknown): AttemptReportObservation {
  return { kind: "v1", promisePath: "/runs/attempt-1/promise.json", report };
}

function decide(
  record: AttemptRecord,
  report: unknown,
  github: GithubCompletionObservation,
  context: CompletionDecisionContext = {},
) {
  return evaluateCompletionPersistence({
    record, report: observedV1(report), github,
    context: { workerReviewLabel: "agent:review", ...context },
  });
}

function confirmed<T>(value: T): RunnerObservation<T> {
  return { kind: "confirmed", value };
}

function reconcileAttemptWorkspace(
  input: Parameters<typeof reconcileAttemptWorkspaceRuntime>[0],
  dependencies: Parameters<typeof reconcileAttemptWorkspaceRuntime>[1],
) {
  return reconcileAttemptWorkspaceRuntime({
    ...input,
    context: { workerReviewLabel: "agent:review", ...input.context },
  }, dependencies);
}

const ownedWorkspace: WorkspaceOwnership = {
  exists: true,
  workspaceId: "workspace-1",
  ownerAttemptId: "attempt-1",
  canonicalWorktreePath: "/worktrees/issue-42",
};

function reconciliationDependencies(calls: string[], closeResult: RunnerObservation<void> = confirmed(undefined)) {
  const dependencies: ReconciliationDependencies = {
    persistPhase: (record, phase) => {
      calls.push(`persist:${phase}`);
      return transitionAttempt(record, phase);
    },
    closeWorkspace: (workspaceId) => {
      calls.push(`close:${workspaceId}`);
      return closeResult;
    },
    observeWorkspace: (workspaceId) => {
      calls.push(`observe:workspace:${workspaceId}`);
      return confirmed({ exists: false });
    },
    observeWorktree: ({ canonicalPath, branch }) => {
      calls.push(`observe:worktree:${canonicalPath}:${branch}`);
      return confirmed({ exists: true, branch: "agent/issue-42", canonicalPath: "/worktrees/issue-42" });
    },
  };
  return dependencies;
}

const freshIdentity = {
  workspaceId: "workspace-2",
  tabId: "tab-2",
  rootPaneId: "pane-2",
  canonicalWorktreePath: "/worktrees/issue-42",
};

function freshWorkspaceDependencies(calls: string[]): FreshWorkspaceDependencies {
  return {
    reconcileRetainedAttempts: () => {
      calls.push("reconcile");
      return confirmed(undefined);
    },
    observeMatchingWorkspaces: () => {
      calls.push("observe");
      return confirmed([]);
    },
    createWorktree: (input) => {
      calls.push(`create:${input.repoPath}:${input.branch}:${input.baseBranch}:${input.label}`);
      return confirmed(freshIdentity);
    },
    openWorktree: (input) => {
      calls.push(`open:${input.repoPath}:${input.branch}`);
      return confirmed(freshIdentity);
    },
    renameWorkspace: ({ workspaceId, label }) => {
      calls.push(`rename:${workspaceId}:${label}`);
      return confirmed(undefined);
    },
  };
}

describe("attempt completion persistence decisions", () => {
  it("closes a completely persisted Worker result", () => {
    const fixture = workerFixture();

    expect(decide(fixture.record, fixture.report, fixture.github)).toEqual({ action: "close" });
  });

  it("uses the configured Worker review label for persistence proof", () => {
    const fixture = workerFixture();
    const github = {
      ...fixture.github,
      pullRequests: fixture.github.pullRequests.map((pullRequest) => ({ ...pullRequest, labels: ["custom:review"] })),
    };
    expect(decide(fixture.record, fixture.report, github, { workerReviewLabel: "custom:review" })).toEqual({ action: "close" });
  });

  it("preserves a blocked Worker result", () => {
    const fixture = workerFixture();

    expect(decide(fixture.record, blockedReport("worker"), fixture.github)).toEqual({
      action: "preserve",
      reason: "blocked",
    });
  });

  it("preserves an invalid Worker result", () => {
    const fixture = workerFixture();

    expect(decide(fixture.record, { ...fixture.report, evidence: { validations: [] } }, fixture.github)).toEqual({
      action: "preserve",
      reason: "invalid_report",
    });
  });

  it("preserves an output-bearing Worker without journal output enrichment", () => {
    const fixture = workerFixture();

    expect(decide({ ...fixture.record, outputRevision: undefined }, fixture.report, fixture.github)).toEqual({
      action: "preserve",
      reason: "invalid_report",
    });
  });

  it("preserves a Worker GitHub observation bound to another repository", () => {
    const fixture = workerFixture();

    expect(decide(fixture.record, fixture.report, { ...fixture.github, repository: "octo/other" })).toEqual({
      action: "preserve",
      reason: "github_persistence_not_confirmed",
    });
  });

  it("preserves a Worker PR observation bound to another issue", () => {
    const fixture = workerFixture();
    const github = {
      ...fixture.github,
      pullRequests: [{ ...fixture.github.pullRequests[0], target: { kind: "issue" as const, number: 43 } }],
    };

    expect(decide(fixture.record, fixture.report, github)).toEqual({
      action: "preserve",
      reason: "github_persistence_not_confirmed",
    });
  });

  it("rejects a Worker attempt consistently bound to a pull request", () => {
    const fixture = workerFixture();
    const target = { kind: "pull-request" as const, number: 42 };
    const record = { ...fixture.record, target };
    const report = { ...fixture.report, target: { ...fixture.report.target, ...target } };
    const github = {
      ...fixture.github,
      target,
      pullRequests: [{
        ...fixture.github.pullRequests[0],
        target,
        marker: { ...fixture.github.pullRequests[0].marker, target },
      }],
    };

    expect(decide(record, report, github)).toEqual({ action: "preserve", reason: "invalid_report" });
  });

  it("closes a persisted approved reviewer result", () => {
    const fixture = reviewerFixture("approved");

    expect(decide(fixture.record, fixture.report, fixture.github, fixture.context)).toEqual({ action: "close" });
  });

  it("closes a persisted changes-requested reviewer result", () => {
    const fixture = reviewerFixture("changes_requested");

    expect(decide(fixture.record, fixture.report, fixture.github, fixture.context)).toEqual({ action: "close" });
  });

  it.each([
    [false, ["ready-for-human"]],
    [true, ["agent:in-progress"]],
  ] as const)("allows unrelated labels with autoMerge=%s while requiring exact managed workflow labels", (_autoMerge, expectedLabels) => {
    const fixture = reviewerFixture("approved");
    const github = { ...fixture.github, labels: [...expectedLabels, "team:platform"] };
    const context = {
      reviewerExpectedLabels: expectedLabels,
      reviewerManagedLabels: ["agent:review", "agent:in-progress", "agent:in-progress", "agent:blocked", "ready-for-human"],
    };

    expect(decide(fixture.record, fixture.report, github, context)).toEqual({ action: "close" });
  });

  it.each([
    [false, ["ready-for-human"], "agent:review"],
    [true, ["agent:in-progress"], "ready-for-human"],
  ] as const)("preserves autoMerge=%s reviewer ownership when a conflicting managed label remains", (_autoMerge, expectedLabels, conflictingLabel) => {
    const fixture = reviewerFixture("approved");
    const github = { ...fixture.github, labels: [...expectedLabels, conflictingLabel, "team:platform"] };
    const context = {
      reviewerExpectedLabels: expectedLabels,
      reviewerManagedLabels: ["agent:review", "agent:in-progress", "agent:in-progress", "agent:blocked", "ready-for-human"],
    };

    expect(decide(fixture.record, fixture.report, github, context)).toEqual({
      action: "preserve",
      reason: "github_persistence_not_confirmed",
    });
  });

  it.each([
    [false, ["ready-for-human"], "agent:blocked"],
    [true, ["agent:in-progress"], "ready-for-human"],
  ] as const)("keeps the selected restart runtime from closing autoMerge=%s with a conflicting managed label", (_autoMerge, expectedLabels, conflictingLabel) => {
    const fixture = reviewerFixture("approved");
    const context = {
      reviewerExpectedLabels: expectedLabels,
      reviewerManagedLabels: ["agent:review", "agent:in-progress", "agent:in-progress", "agent:blocked", "ready-for-human"],
    };
    expect(evaluateSelectedRuntimePersistence({
      record: fixture.record,
      report: { kind: "v1", promisePath: fixture.record.promiseFile, report: fixture.report },
      github: { ...fixture.github, labels: [...expectedLabels, conflictingLabel, "team:platform"] },
      context,
    })).toEqual({ action: "preserve", reason: "github_persistence_not_confirmed" });
  });

  it("does not let a reviewer observation self-declare its expected label policy", () => {
    const fixture = reviewerFixture("approved");

    expect(decide(fixture.record, fixture.report, fixture.github)).toEqual({
      action: "preserve",
      reason: "github_persistence_not_confirmed",
    });
  });

  it("requires one exact head-bound reviewer persistence object", () => {
    const fixture = reviewerFixture("changes_requested");
    const github = {
      ...fixture.github,
      reviewPersistence: { ...fixture.github.reviewPersistence, repository: "octo/other" },
    };

    expect(decide(fixture.record, fixture.report, github, fixture.context)).toEqual({
      action: "preserve",
      reason: "github_persistence_not_confirmed",
    });
  });

  it("rejects an approved reviewer marker with an unexpected base revision", () => {
    const fixture = reviewerFixture("approved");
    const github = {
      ...fixture.github,
      reviewPersistence: {
        ...fixture.github.reviewPersistence,
        marker: { ...fixture.github.reviewPersistence.marker, inputBase: BASE_HEAD },
      },
    };

    expect(decide(fixture.record, fixture.report, github, fixture.context)).toEqual({
      action: "preserve",
      reason: "github_persistence_not_confirmed",
    });
  });

  it("rejects an approved reviewer marker with an unexpected output revision", () => {
    const fixture = reviewerFixture("approved");
    const github = {
      ...fixture.github,
      reviewPersistence: {
        ...fixture.github.reviewPersistence,
        marker: { ...fixture.github.reviewPersistence.marker, outputRevision: "c".repeat(40) },
      },
    };

    expect(decide(fixture.record, fixture.report, github, fixture.context)).toEqual({
      action: "preserve",
      reason: "github_persistence_not_confirmed",
    });
  });

  it("rejects a reviewer attempt consistently bound to an issue", () => {
    const fixture = reviewerFixture("approved");
    const target = { kind: "issue" as const, number: 42 };
    const record = { ...fixture.record, target };
    const report = { ...fixture.report, target: { ...fixture.report.target, ...target } };
    const github = {
      ...fixture.github,
      target,
      reviewPersistence: {
        ...fixture.github.reviewPersistence,
        target,
        marker: { ...fixture.github.reviewPersistence.marker, target },
      },
    };

    expect(decide(record, report, github, fixture.context)).toEqual({ action: "preserve", reason: "invalid_report" });
  });

  it("preserves a human-required reviewer result", () => {
    const fixture = reviewerFixture("human_required");

    expect(decide(fixture.record, fixture.report, fixture.github)).toEqual({
      action: "preserve",
      reason: "human_required",
    });
  });

  it("preserves a blocked reviewer result", () => {
    const fixture = reviewerFixture();

    expect(decide(fixture.record, blockedReport("reviewer"), fixture.github)).toEqual({
      action: "preserve",
      reason: "blocked",
    });
  });

  it("closes a persisted pushed repair result", () => {
    const fixture = repairFixture("repair_pushed");

    expect(decide(fixture.record, fixture.report, fixture.github)).toEqual({ action: "close" });
  });

  it("closes a repair result whose input head became stale", () => {
    const fixture = repairFixture("stale_head");

    expect(decide(fixture.record, fixture.report, fixture.github)).toEqual({ action: "close" });
  });

  it("preserves a blocked repair result", () => {
    const fixture = repairFixture();

    expect(decide(fixture.record, blockedReport("review-repair"), fixture.github)).toEqual({
      action: "preserve",
      reason: "blocked",
    });
  });

  it("preserves an invalid repair result", () => {
    const fixture = repairFixture();

    expect(decide(fixture.record, { ...fixture.report, result: { outcome: "repair_pushed" } }, fixture.github)).toEqual(
      {
        action: "preserve",
        reason: "invalid_report",
      },
    );
  });

  it("preserves repair output that differs from the journal output", () => {
    const fixture = repairFixture();

    expect(decide({ ...fixture.record, outputRevision: "f".repeat(40) }, fixture.report, fixture.github)).toEqual({
      action: "preserve",
      reason: "invalid_report",
    });
  });

  it("rejects a review-repair attempt consistently bound to an issue", () => {
    const fixture = repairFixture();
    const target = { kind: "issue" as const, number: 42 };
    const record = { ...fixture.record, target };
    const report = { ...fixture.report, target: { ...fixture.report.target, ...target } };
    const github = {
      ...fixture.github,
      target,
      marker: fixture.github.marker ? { ...fixture.github.marker, target } : undefined,
    };

    expect(decide(record, report, github)).toEqual({ action: "preserve", reason: "invalid_report" });
  });

  it("closes a persisted pushed branch-update result when the selected base advanced", () => {
    const fixture = branchUpdateFixture("branch_update_pushed");

    expect(decide(fixture.record, fixture.report, fixture.github)).toEqual({ action: "close" });
  });

  it("closes a stale branch-update result when only the PR head must differ", () => {
    const fixture = branchUpdateFixture("stale_head");

    expect(decide(fixture.record, fixture.report, fixture.github)).toEqual({ action: "close" });
  });

  it("preserves a blocked branch-update result", () => {
    const fixture = branchUpdateFixture();

    expect(decide(fixture.record, blockedReport("branch-update"), fixture.github)).toEqual({
      action: "preserve",
      reason: "blocked",
    });
  });

  it("preserves an invalid branch-update result", () => {
    const fixture = branchUpdateFixture();

    expect(decide(fixture.record, { ...fixture.report, inputRevision: { head: INPUT_HEAD } }, fixture.github)).toEqual({
      action: "preserve",
      reason: "invalid_report",
    });
  });

  it("preserves a branch-update marker bound to another pull request", () => {
    const fixture = branchUpdateFixture();
    const github = {
      ...fixture.github,
      marker: fixture.github.marker
        ? { ...fixture.github.marker, target: { kind: "pull-request" as const, number: 43 } }
        : undefined,
    };

    expect(decide(fixture.record, fixture.report, github)).toEqual({
      action: "preserve",
      reason: "github_persistence_not_confirmed",
    });
  });

  it("rejects a branch-update attempt consistently bound to an issue", () => {
    const fixture = branchUpdateFixture();
    const target = { kind: "issue" as const, number: 42 };
    const record = { ...fixture.record, target };
    const report = { ...fixture.report, target: { ...fixture.report.target, ...target } };
    const github = {
      ...fixture.github,
      target,
      marker: fixture.github.marker ? { ...fixture.github.marker, target } : undefined,
    };

    expect(decide(record, report, github)).toEqual({ action: "preserve", reason: "invalid_report" });
  });

  it("does not treat an advanced base alone as a stale branch update", () => {
    const fixture = branchUpdateFixture("stale_head");
    const github = { ...fixture.github, headSha: INPUT_HEAD, baseSha: "f".repeat(40) };

    expect(decide(fixture.record, fixture.report, github)).toEqual({
      action: "preserve",
      reason: "github_persistence_not_confirmed",
    });
  });

  it("requires the launch-unique promise path", () => {
    const fixture = workerFixture();

    expect(
      evaluateCompletionPersistence({
        record: fixture.record,
        report: { kind: "v1", promisePath: "/another/promise.json", report: fixture.report },
        github: fixture.github,
      }),
    ).toEqual({ action: "preserve", reason: "ownership_mismatch" });
  });

  it("preserves a complete report when GitHub cannot be confirmed", () => {
    const fixture = workerFixture();

    expect(
      decide(fixture.record, fixture.report, { kind: "uncertain", reason: "timeout", detail: "gh timed out" }),
    ).toEqual({
      action: "preserve",
      reason: "github_persistence_not_confirmed",
    });
  });
});

describe("attempt workspace reconciliation", () => {
  it("records persistence before closing only the owned workspace", async () => {
    const fixture = workerFixture();
    const calls: string[] = [];

    await reconcileAttemptWorkspace(
      {
        record: fixture.record,
        report: observedV1(fixture.report),
        github: fixture.github,
        workspace: confirmed(ownedWorkspace),
        newerLiveOwner: confirmed(false),
      },
      reconciliationDependencies(calls),
    );

    expect(calls).toEqual([
      "persist:github_persisted",
      "close:workspace-1",
      "observe:workspace:workspace-1",
      "observe:worktree:/worktrees/issue-42:agent/issue-42",
      "persist:workspace_closed",
    ]);
  });

  it("refuses closure when a newer live attempt owns the checkout", async () => {
    const fixture = workerFixture();
    const calls: string[] = [];

    const result = await reconcileAttemptWorkspace(
      {
        record: fixture.record,
        report: observedV1(fixture.report),
        github: fixture.github,
        workspace: confirmed(ownedWorkspace),
        newerLiveOwner: confirmed(true),
      },
      reconciliationDependencies(calls),
    );

    expect({ result, calls }).toEqual({
      result: { action: "preserved", reason: "newer_live_owner", record: fixture.record },
      calls: [],
    });
  });

  it("causes zero cleanup calls for a blocked completion", async () => {
    const fixture = workerFixture();
    const calls: string[] = [];

    const result = await reconcileAttemptWorkspace(
      {
        record: fixture.record,
        report: observedV1(blockedReport("worker")),
        github: fixture.github,
        workspace: confirmed(ownedWorkspace),
        newerLiveOwner: confirmed(false),
      },
      reconciliationDependencies(calls),
    );

    expect({ result: result.action, calls }).toEqual({ result: "preserved", calls: [] });
  });

  it("handles workspace_closed before changed report or GitHub observations", async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const record = transitionAttempt(transitionAttempt(fixture.record, "github_persisted"), "workspace_closed");

    const result = await reconcileAttemptWorkspace(
      {
        record,
        report: { kind: "missing" },
        github: { kind: "uncertain", reason: "unreachable", detail: "GitHub unavailable" },
        workspace: { kind: "uncertain", reason: "ambiguous", detail: "workspace list changed" },
        newerLiveOwner: { kind: "uncertain", reason: "ambiguous", detail: "owner list changed" },
      },
      reconciliationDependencies(calls),
    );

    expect({ result, calls }).toEqual({ result: { action: "closed", record }, calls: [] });
  });

  it("uses github_persisted as durable cleanup authority after the report and GitHub state change", async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const record = transitionAttempt(fixture.record, "github_persisted");

    const result = await reconcileAttemptWorkspace(
      {
        record,
        report: observedV1({ ...fixture.report, attemptId: "changed-attempt" }),
        github: { ...fixture.github, issueClaimable: true },
        workspace: confirmed(ownedWorkspace),
        newerLiveOwner: confirmed(false),
      },
      reconciliationDependencies(calls),
    );

    expect(result.action).toBe("closed");
  });

  it("uses github_persisted as durable cleanup authority when report and GitHub reads are missing", async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const record = transitionAttempt(fixture.record, "github_persisted");

    const result = await reconcileAttemptWorkspace(
      {
        record,
        report: { kind: "missing" },
        github: { kind: "uncertain", reason: "unreachable", detail: "GitHub unavailable" },
        workspace: confirmed(ownedWorkspace),
        newerLiveOwner: confirmed(false),
      },
      reconciliationDependencies(calls),
    );

    expect(result.action).toBe("closed");
  });

  it("normalizes an ambiguous close as cleanup pending after persistence", async () => {
    const fixture = workerFixture();
    const calls: string[] = [];

    const result = await reconcileAttemptWorkspace(
      {
        record: fixture.record,
        report: observedV1(fixture.report),
        github: fixture.github,
        workspace: confirmed(ownedWorkspace),
        newerLiveOwner: confirmed(false),
      },
      reconciliationDependencies(calls, { kind: "uncertain", reason: "timeout", detail: "close timed out" }),
    );

    expect(result).toMatchObject({ action: "cleanup_pending", reason: "cleanup_pending", detail: "close timed out" });
  });

  it("normalizes a thrown typed close timeout as cleanup pending", async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const dependencies = reconciliationDependencies(calls);
    dependencies.closeWorkspace = () => {
      throw new RunnerUncertaintyError("timeout", "typed close timeout");
    };

    const result = await reconcileAttemptWorkspace(
      {
        record: fixture.record,
        report: observedV1(fixture.report),
        github: fixture.github,
        workspace: confirmed(ownedWorkspace),
        newerLiveOwner: confirmed(false),
      },
      dependencies,
    );

    expect(result).toMatchObject({ action: "cleanup_pending", detail: "typed close timeout" });
  });

  it("does not replay workflow side effects while retrying cleanup", async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const record = transitionAttempt(fixture.record, "github_persisted");

    await reconcileAttemptWorkspace(
      {
        record,
        report: observedV1(fixture.report),
        github: fixture.github,
        workspace: confirmed(ownedWorkspace),
        newerLiveOwner: confirmed(false),
      },
      reconciliationDependencies(calls),
    );

    expect(calls).toEqual([
      "close:workspace-1",
      "observe:workspace:workspace-1",
      "observe:worktree:/worktrees/issue-42:agent/issue-42",
      "persist:workspace_closed",
    ]);
  });

  it("treats an absent workspace after persistence as idempotent cleanup", async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const record = transitionAttempt(fixture.record, "github_persisted");

    const result = await reconcileAttemptWorkspace(
      {
        record,
        report: observedV1(fixture.report),
        github: fixture.github,
        workspace: confirmed({ exists: false }),
        newerLiveOwner: confirmed(false),
      },
      reconciliationDependencies(calls),
    );

    expect(result.action).toBe("closed");
  });

  it("leaves persistence pending when the retained branch postcondition fails", async () => {
    const fixture = workerFixture();
    const calls: string[] = [];
    const dependencies = reconciliationDependencies(calls);
    dependencies.observeWorktree = () =>
      confirmed({
        exists: true,
        branch: "another-branch",
        canonicalPath: "/worktrees/issue-42",
      });

    const result = await reconcileAttemptWorkspace(
      {
        record: fixture.record,
        report: observedV1(fixture.report),
        github: fixture.github,
        workspace: confirmed(ownedWorkspace),
        newerLiveOwner: confirmed(false),
      },
      dependencies,
    );

    expect(result).toMatchObject({ action: "cleanup_pending", reason: "cleanup_pending" });
  });

  it("preserves an ambiguous ownership observation before persistence", async () => {
    const fixture = workerFixture();
    const calls: string[] = [];

    const result = await reconcileAttemptWorkspace(
      {
        record: fixture.record,
        report: observedV1(fixture.report),
        github: fixture.github,
        workspace: { kind: "uncertain", reason: "protocol_error", detail: "bad response" },
        newerLiveOwner: confirmed(false),
      },
      reconciliationDependencies(calls),
    );

    expect(result).toEqual({ action: "preserved", reason: "ownership_mismatch", record: fixture.record });
  });

  it("reconciles retained attempts before allowing a fresh workspace open", async () => {
    const calls: string[] = [];

    const result = await reconcileBeforeWorkspaceOpen({
      reconcileRetainedAttempts: () => {
        calls.push("reconcile");
        return Promise.resolve(confirmed(undefined));
      },
      observeMatchingWorkspaces: () => {
        calls.push("observe");
        return Promise.resolve(confirmed([]));
      },
    });

    expect({ calls, result }).toEqual({
      calls: ["reconcile", "observe"],
      result: { action: "open_fresh", openWithLabel: false, renameAfterOpen: true },
    });
  });

  it("rejects open without relabelling when a prior workspace remains", async () => {
    const result = await reconcileBeforeWorkspaceOpen({
      reconcileRetainedAttempts: () => Promise.resolve(confirmed(undefined)),
      observeMatchingWorkspaces: () => Promise.resolve(confirmed([ownedWorkspace])),
    });

    expect(result).toEqual({ action: "reject", reason: "existing_workspace", relabel: false });
  });
});

describe("fresh attempt workspace orchestration", () => {
  it("creates the first worktree after reconciliation and renames the fresh workspace", async () => {
    const calls: string[] = [];

    const result = await orchestrateFreshAttemptWorkspace(
      {
        mode: "create",
        repoPath: "/repo",
        branch: "agent/issue-42",
        baseBranch: "main",
        workspaceLabel: "Worker Issue 42",
        expectedCanonicalWorktreePath: "/worktrees/issue-42",
      },
      freshWorkspaceDependencies(calls),
    );

    expect({ result, calls }).toEqual({
      result: { action: "opened", identity: freshIdentity },
      calls: [
        "reconcile",
        "observe",
        "create:/repo:agent/issue-42:main:Worker Issue 42",
        "rename:workspace-2:Worker Issue 42",
      ],
    });
  });

  it("opens an existing worktree without a label before renaming", async () => {
    const calls: string[] = [];

    const result = await orchestrateFreshAttemptWorkspace(
      {
        mode: "open",
        repoPath: "/repo",
        branch: "agent/issue-42",
        workspaceLabel: "Reviewer PR 42",
        expectedCanonicalWorktreePath: "/worktrees/issue-42",
      },
      freshWorkspaceDependencies(calls),
    );

    expect({ result, calls }).toEqual({
      result: { action: "opened", identity: freshIdentity },
      calls: ["reconcile", "observe", "open:/repo:agent/issue-42", "rename:workspace-2:Reviewer PR 42"],
    });
  });

  it("accepts the same worktree only with fresh chained-attempt identities", async () => {
    const calls: string[] = [];

    const result = await orchestrateFreshAttemptWorkspace(
      {
        mode: "open",
        repoPath: "/repo",
        branch: "agent/issue-42",
        workspaceLabel: "Repair PR 42",
        expectedCanonicalWorktreePath: "/worktrees/issue-42",
        priorAttempt: {
          workspaceId: "workspace-1",
          tabId: "tab-1",
          rootPaneId: "pane-1",
          canonicalWorktreePath: "/worktrees/issue-42",
        },
      },
      freshWorkspaceDependencies(calls),
    );

    expect(result).toEqual({ action: "opened", identity: freshIdentity });
  });

  it("rejects a reused chained workspace without renaming it", async () => {
    const calls: string[] = [];
    const dependencies = freshWorkspaceDependencies(calls);
    dependencies.openWorktree = (input) => {
      calls.push(`open:${input.repoPath}:${input.branch}`);
      return confirmed({ ...freshIdentity, workspaceId: "workspace-1" });
    };

    const result = await orchestrateFreshAttemptWorkspace(
      {
        mode: "open",
        repoPath: "/repo",
        branch: "agent/issue-42",
        workspaceLabel: "Reviewer PR 42",
        expectedCanonicalWorktreePath: "/worktrees/issue-42",
        priorAttempt: {
          workspaceId: "workspace-1",
          tabId: "tab-1",
          rootPaneId: "pane-1",
          canonicalWorktreePath: "/worktrees/issue-42",
        },
      },
      dependencies,
    );

    expect({ result, calls }).toEqual({
      result: { action: "rejected", reason: "non_fresh_workspace", relabel: false },
      calls: ["reconcile", "observe", "open:/repo:agent/issue-42"],
    });
  });

  it("normalizes ambiguous open and never relabels an unconfirmed workspace", async () => {
    const calls: string[] = [];
    const dependencies = freshWorkspaceDependencies(calls);
    dependencies.openWorktree = (input) => {
      calls.push(`open:${input.repoPath}:${input.branch}`);
      throw new RunnerUncertaintyError("timeout", "open timed out");
    };

    const result = await orchestrateFreshAttemptWorkspace(
      {
        mode: "open",
        repoPath: "/repo",
        branch: "agent/issue-42",
        workspaceLabel: "Reviewer PR 42",
        expectedCanonicalWorktreePath: "/worktrees/issue-42",
      },
      dependencies,
    );

    expect({ result, calls }).toEqual({
      result: { action: "rejected", reason: "workspace_open_ambiguous", detail: "open timed out", relabel: false },
      calls: ["reconcile", "observe", "open:/repo:agent/issue-42"],
    });
  });

  it("does not create, open, or relabel while exclusivity remains blocked", async () => {
    const calls: string[] = [];
    const dependencies = freshWorkspaceDependencies(calls);
    dependencies.observeMatchingWorkspaces = () => {
      calls.push("observe");
      return confirmed([ownedWorkspace]);
    };

    const result = await orchestrateFreshAttemptWorkspace(
      {
        mode: "open",
        repoPath: "/repo",
        branch: "agent/issue-42",
        workspaceLabel: "Reviewer PR 42",
        expectedCanonicalWorktreePath: "/worktrees/issue-42",
      },
      dependencies,
    );

    expect({ result, calls }).toEqual({
      result: { action: "rejected", reason: "existing_workspace", relabel: false },
      calls: ["reconcile", "observe"],
    });
  });
});

describe("typed uncertainty and doctor findings", () => {
  it("normalizes pre-persistence runner uncertainty to preservation", () => {
    expect(
      normalizeRunnerUncertainty({ kind: "uncertain", reason: "ambiguous", detail: "unknown owner" }, "ownership"),
    ).toEqual({
      action: "preserve",
      reason: "ownership_mismatch",
      detail: "unknown owner",
    });
  });

  it("normalizes post-persistence runner uncertainty to cleanup pending", () => {
    expect(
      normalizeRunnerUncertainty(
        { kind: "uncertain", reason: "protocol_error", detail: "bad close response" },
        "cleanup",
      ),
    ).toEqual({
      action: "pending",
      reason: "cleanup_pending",
      detail: "bad close response",
    });
  });

  it.each([
    "active_attempt",
    "blocked",
    "human_required",
    "missing_report",
    "invalid_report",
    "github_persistence_not_confirmed",
    "launch_failed",
    "cleanup_pending",
    "ownership_mismatch",
    "newer_live_owner",
    "herdr_unsupported",
  ] satisfies RetentionReason[])("returns a read-only doctor finding for %s", (reason) => {
    expect(doctorFindingForRetention(reason, "attempt-1").readOnly).toBe(true);
  });

  it("reports a selected-base binding mismatch as an invalid report", () => {
    const fixture = branchUpdateFixture();
    const report = { ...fixture.report, inputRevision: { head: INPUT_HEAD, base: `${BASE_HEAD.slice(0, -1)}c` } };

    expect(decide(fixture.record, report, fixture.github)).toEqual({ action: "preserve", reason: "invalid_report" });
  });
});
