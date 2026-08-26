import type { AttemptRecord, AttemptRole, AttemptTarget } from "../../src/attempt-lifecycle";
import type {
  CompletionDecisionContext,
  CompletionMarker,
  ReviewerGithubObservation,
  WorkerGithubObservation,
  WriterGithubObservation,
} from "../../src/attempt-workspace-lifecycle";
import type { PriorRequiredFindingDisposition } from "../../src/reviewer-outcome-contract-types";

const { decideReviewTransition } = require("../../src/reviewer-outcome-contract.cts");

export const INPUT_HEAD = "a".repeat(40);
export const BASE_HEAD = "b".repeat(40);
export const OUTPUT_HEAD = "c".repeat(40);
export const REMOTE_HEAD = "d".repeat(40);
export const REPOSITORY = "octo/demo";
export const TARGET_NUMBER = 42;

const pullRequestTarget = { kind: "pull-request" as const, number: TARGET_NUMBER };
const issueTarget = { kind: "issue" as const, number: TARGET_NUMBER };

const commonReport = {
  schemaVersion: 1 as const,
  attemptId: "attempt-1",
  target: { repository: REPOSITORY, ...pullRequestTarget },
  inputRevision: { head: INPUT_HEAD },
  status: "complete" as const,
  summary: "Completed",
};

function marker(
  role: AttemptRole,
  target: AttemptTarget,
  outcome: string,
  extra: Partial<CompletionMarker> = {},
): CompletionMarker {
  return {
    attemptId: "attempt-1",
    role,
    repository: REPOSITORY,
    target,
    inputHead: INPUT_HEAD,
    outcome,
    ...extra,
  };
}

export function attemptRecord(role: AttemptRecord["role"], outputRevision?: string): AttemptRecord {
  return {
    attemptId: "attempt-1",
    launchUuid: "launch-1",
    project: "demo",
    repository: REPOSITORY,
    role,
    target: role === "worker" ? issueTarget : pullRequestTarget,
    inputRevision: {
      head: INPUT_HEAD,
      ...(role === "branch-update" ? { base: BASE_HEAD } : {}),
    },
    ...(role === "worker" ? { requiredVerification: {
      repository: REPOSITORY,
      command: "npm test",
      source: { kind: "repo_policy" as const, location: "deadloop.json" },
      baseRevision: INPUT_HEAD,
    } } : {}),
    branch: "agent/issue-42",
    baseBranch: "main",
    worktreePath: "/worktrees/issue-42",
    agentName: `dl-${role}-42-deadbeef0000`,
    workspaceLabel: `${role} 42`,
    promptFile: "/runs/attempt-1/prompt.md",
    promiseFile: "/runs/attempt-1/promise.json",
    phase: "report_received",
    lastSuccessfulPhase: "report_received",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    rootPaneId: "pane-1",
    ...(outputRevision === undefined ? {} : { outputRevision }),
  };
}

export function workerFixture() {
  const record = attemptRecord("worker", OUTPUT_HEAD);
  const report = {
    ...commonReport,
    role: "worker" as const,
    target: { ...commonReport.target, kind: "issue" as const },
    result: { outputRevision: OUTPUT_HEAD },
    evidence: { validations: ["npm test passed"] },
  };
  const github = {
    kind: "confirmed",
    role: "worker",
    repository: REPOSITORY,
    target: issueTarget,
    issueClaimable: false,
    pullRequests: [
      {
        repository: REPOSITORY,
        target: issueTarget,
        state: "open",
        headBranch: record.branch,
        headSha: OUTPUT_HEAD,
        baseBranch: "main",
        closesIssue: TARGET_NUMBER,
        labels: ["agent:review"],
        marker: marker("worker", issueTarget, "complete", { outputRevision: OUTPUT_HEAD }),
      },
    ],
  } satisfies WorkerGithubObservation;
  return { record, report, github, context: { workerReviewLabel: "agent:review" } };
}

export function reviewerFixture(
  outcome: "approved" | "changes_requested" | "human_required" = "approved",
  priorRequiredFindings: PriorRequiredFindingDisposition = "all_resolved",
) {
  const findings = outcome === "changes_requested"
    ? [{ title: "Bug", body: "Fix it", path: "src/a.ts", line: 1, severity: "major" as const }]
    : [];
  const repairs = decideReviewTransition({ outcome, priorRequiredFindings }).transition === "repair";
  // A review that is not repairing hands the pull request to a person. That expectation is explicit:
  // the closure proof waits on the shared human-handoff state (ready, no agent workflow label left),
  // not on an empty expected label set.
  const expectedLabels = repairs ? ["agent:review", "agent:in-progress"] : [];
  const context = (repairs
    ? { reviewerExpectedLabels: expectedLabels }
    : {
        reviewerHumanHandoff: {
          reviewLabel: "agent:review",
          implementLabel: "agent:implement",
          updateBranchLabel: "agent:update-branch",
          inProgressLabel: "agent:in-progress",
          blockedLabel: "agent:blocked",
        },
      }) satisfies CompletionDecisionContext;
  const github = {
    kind: "confirmed",
    role: "reviewer",
    repository: REPOSITORY,
    target: pullRequestTarget,
    headSha: INPUT_HEAD,
    labels: [...expectedLabels],
    draft: false,
    reviewPersistence: {
      repository: REPOSITORY,
      target: pullRequestTarget,
      headSha: INPUT_HEAD,
      marker: marker("reviewer", pullRequestTarget, outcome),
      findings,
      boundedRepairAttemptMarked: repairs,
    },
  } satisfies ReviewerGithubObservation;
  return {
    record: attemptRecord("reviewer"),
    report: {
      ...commonReport,
      role: "reviewer" as const,
      result: {
        outcome,
        reviewedHead: INPUT_HEAD,
        findings,
        ...(outcome === "changes_requested" ? { priorRequiredFindings } : {}),
      },
      evidence: { reviewed: ["diff"] },
    },
    github,
    context,
  };
}

export function repairFixture(outcome: "repair_pushed" | "stale_head" = "repair_pushed") {
  const outputRevision = outcome === "repair_pushed" ? OUTPUT_HEAD : REMOTE_HEAD;
  const github = {
    kind: "confirmed",
    role: "review-repair",
    repository: REPOSITORY,
    target: pullRequestTarget,
    headSha: outputRevision,
    marker: outcome === "repair_pushed"
      ? marker("review-repair", pullRequestTarget, outcome, { outputRevision, validationPassed: true })
      : undefined,
    pushRecorded: outcome === "repair_pushed",
    successClaimRecorded: outcome === "repair_pushed",
  } satisfies WriterGithubObservation;
  return {
    record: attemptRecord("review-repair", outputRevision),
    report: {
      ...commonReport,
      role: "review-repair" as const,
      result: outcome === "repair_pushed"
        ? {
            outcome,
            outputRevision,
            repairs: [{ title: "Bug", summary: "Fixed", paths: ["src/a.ts"] }],
          }
        : { outcome, outputRevision },
      evidence: outcome === "repair_pushed"
        ? {
            finalizer: {
              action: "pushed",
              reason: outcome,
              originalHeadOid: INPUT_HEAD,
              headOid: outputRevision,
              checks: [{ command: "npm test", result: "passed" }],
            },
            validations: [{ command: "npm test", result: "passed" }],
          }
        : {
            finalizer: {
              action: "stale_head",
              reason: "head_sha_changed",
              originalHeadOid: INPUT_HEAD,
              currentRemoteHeadOid: outputRevision,
            },
          },
    },
    github,
  };
}

export function branchUpdateFixture(outcome: "branch_update_pushed" | "stale_head" = "branch_update_pushed") {
  const outputRevision = outcome === "branch_update_pushed" ? OUTPUT_HEAD : REMOTE_HEAD;
  const github = {
    kind: "confirmed",
    role: "branch-update",
    repository: REPOSITORY,
    target: pullRequestTarget,
    headSha: outputRevision,
    baseSha: "e".repeat(40),
    marker: outcome === "branch_update_pushed"
      ? marker("branch-update", pullRequestTarget, outcome, {
          inputBase: BASE_HEAD,
          outputRevision,
          validationPassed: true,
        })
      : undefined,
    pushRecorded: outcome === "branch_update_pushed",
    successClaimRecorded: outcome === "branch_update_pushed",
  } satisfies WriterGithubObservation;
  return {
    record: attemptRecord("branch-update", outputRevision),
    report: {
      ...commonReport,
      role: "branch-update" as const,
      inputRevision: { head: INPUT_HEAD, base: BASE_HEAD },
      result: { outcome, outputRevision },
      evidence: outcome === "branch_update_pushed"
        ? {
            finalizer: {
              action: "pushed",
              reason: outcome,
              originalHeadOid: INPUT_HEAD,
              baseHeadOid: BASE_HEAD,
              headOid: outputRevision,
              checks: [{ command: "npm test", result: "passed" }],
            },
            validations: [{ command: "npm test", result: "passed" }],
          }
        : {
            finalizer: {
              action: "stale_head",
              reason: "head_sha_changed",
              originalHeadOid: INPUT_HEAD,
              baseHeadOid: BASE_HEAD,
              currentRemoteHeadOid: outputRevision,
            },
          },
    },
    github,
  };
}

export function blockedReport(role: AttemptRecord["role"]) {
  const record = attemptRecord(role);
  return {
    schemaVersion: 1 as const,
    attemptId: record.attemptId,
    role,
    target: { repository: record.repository, ...record.target },
    inputRevision: record.inputRevision,
    status: "blocked" as const,
    summary: "Blocked",
    result: { reason: "unsafe", explanation: "Cannot continue", recovery: "Inspect workspace" },
    evidence: {},
  };
}
