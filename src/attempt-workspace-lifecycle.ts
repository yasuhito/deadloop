import {
  type AttemptRecord,
  type AttemptRole,
  type AttemptTarget,
  type CompletionReportV1,
  type ReviewerFinding,
  validateCompletionReportBinding,
} from "./attempt-lifecycle";

const { decideReviewTransition } = require("./reviewer-outcome-contract.cts");

export type RetentionReason =
  | "active_attempt"
  | "blocked"
  | "missing_report"
  | "invalid_report"
  | "github_persistence_not_confirmed"
  | "launch_failed"
  | "cleanup_pending"
  | "ownership_mismatch"
  | "newer_live_owner"
  | "herdr_unsupported";

export type AttemptReportObservation =
  | { kind: "missing" }
  | { kind: "v1"; promisePath: string; report: unknown };

export type RunnerUncertaintyReason = "timeout" | "protocol_error" | "malformed_response" | "unreachable" | "ambiguous";

export type RunnerObservation<T> =
  | { kind: "confirmed"; value: T }
  | { kind: "uncertain"; reason: RunnerUncertaintyReason; detail: string };

export class RunnerUncertaintyError extends Error {
  constructor(
    readonly reason: RunnerUncertaintyReason,
    message: string,
  ) {
    super(message);
    this.name = "RunnerUncertaintyError";
  }
}

export type CompletionMarker = {
  attemptId: string;
  role: AttemptRole;
  repository: string;
  target: AttemptTarget;
  inputHead: string;
  inputBase?: string;
  outcome: string;
  outputRevision?: string;
  validationPassed?: boolean;
};

type BoundGithubObservation = {
  repository: string;
  target: AttemptTarget;
};

export type WorkerGithubObservation = BoundGithubObservation & {
  kind: "confirmed";
  role: "worker";
  pullRequests: Array<
    BoundGithubObservation & {
      state: "open" | "closed" | "merged";
      headBranch: string;
      headSha: string;
      baseBranch: string;
      closesIssue: number | null;
      labels: string[];
      marker?: CompletionMarker;
    }
  >;
};

export type ReviewerGithubObservation = BoundGithubObservation & {
  kind: "confirmed";
  role: "reviewer";
  headSha: string;
  labels: string[];
  draft: boolean;
  reviewPersistence?: BoundGithubObservation & {
    headSha: string;
    marker: CompletionMarker;
    findings: ReviewerFinding[];
    boundedRepairAttemptMarked: boolean;
  };
};

export type WriterGithubObservation = BoundGithubObservation & {
  kind: "confirmed";
  role: "review-repair" | "branch-update";
  headSha: string;
  baseSha?: string;
  marker?: CompletionMarker;
  pushRecorded: boolean;
  successClaimRecorded: boolean;
};

export type UncertainGithubObservation = {
  kind: "uncertain";
  reason: RunnerUncertaintyReason;
  detail: string;
};

export type GithubCompletionObservation =
  | WorkerGithubObservation
  | ReviewerGithubObservation
  | WriterGithubObservation
  | UncertainGithubObservation;

export type CompletionDecisionContext = {
  workerReviewLabel?: string;
  reviewerExpectedLabels?: readonly string[];
  reviewerManagedLabels?: readonly string[];
};

export type CompletionPersistenceDecision = { action: "close" } | { action: "preserve"; reason: RetentionReason };

export type WorkspaceOwnership =
  | { exists: false }
  | {
      exists: true;
      workspaceId: string;
      ownerAttemptId: string;
      canonicalWorktreePath: string;
    };

export type WorktreePostcondition = {
  exists: boolean;
  canonicalPath: string;
  branch: string;
};

export type ReconciliationDependencies = {
  persistPhase(
    record: AttemptRecord,
    phase: "github_persisted" | "workspace_closed",
  ): AttemptRecord | Promise<AttemptRecord>;
  closeWorkspace(workspaceId: string): RunnerObservation<void> | Promise<RunnerObservation<void>>;
  observeWorkspace(
    workspaceId: string,
  ): RunnerObservation<WorkspaceOwnership> | Promise<RunnerObservation<WorkspaceOwnership>>;
  observeWorktree(input: {
    canonicalPath: string;
    branch: string;
  }): RunnerObservation<WorktreePostcondition> | Promise<RunnerObservation<WorktreePostcondition>>;
};

export type AttemptWorkspaceReconciliation =
  | { action: "closed"; record: AttemptRecord }
  | { action: "preserved"; reason: RetentionReason; record: AttemptRecord }
  | { action: "cleanup_pending"; reason: "cleanup_pending"; detail: string; record: AttemptRecord };

type CompleteReport = Extract<CompletionReportV1, { status: "complete" }>;
type WorkerReport = Extract<CompleteReport, { role: "worker" }>;
type ReviewerReport = Extract<CompleteReport, { role: "reviewer" }>;
type RepairReport = Extract<CompleteReport, { role: "review-repair" }>;
type BranchUpdateReport = Extract<CompleteReport, { role: "branch-update" }>;

function sameSha(left: string | undefined, right: string | undefined): boolean {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedRight = [...right].sort();
  return left.length === right.length && [...left].sort().every((value, index) => value === sortedRight[index]);
}

function sameTarget(left: AttemptTarget, right: AttemptTarget): boolean {
  return left.kind === right.kind && left.number === right.number;
}

function roleMatchesTarget(role: AttemptRole, target: AttemptTarget): boolean {
  return role === "worker" || role === "explorer" ? target.kind === "issue" : target.kind === "pull-request";
}

function sameOptionalSha(left: string | undefined, right: string | undefined): boolean {
  return left === undefined && right === undefined || sameSha(left, right);
}

function boundToRecord(observation: BoundGithubObservation, record: AttemptRecord): boolean {
  return observation.repository === record.repository && sameTarget(observation.target, record.target);
}

function sameFinding(left: ReviewerFinding, right: ReviewerFinding): boolean {
  return (
    left.title === right.title &&
    left.body === right.body &&
    left.path === right.path &&
    left.line === right.line &&
    left.severity === right.severity
  );
}

function sameFindings(left: ReviewerFinding[], right: ReviewerFinding[]): boolean {
  return left.length === right.length && left.every((finding, index) => sameFinding(finding, right[index]));
}

function markerMatches(
  marker: CompletionMarker | undefined,
  record: AttemptRecord,
  outcome: string,
  outputRevision?: string,
): boolean {
  return Boolean(
    marker &&
      marker.attemptId === record.attemptId &&
      marker.role === record.role &&
      marker.repository === record.repository &&
      sameTarget(marker.target, record.target) &&
      sameSha(marker.inputHead, record.inputRevision.head) &&
      sameOptionalSha(marker.inputBase, record.inputRevision.base) &&
      marker.outcome === outcome &&
      sameOptionalSha(marker.outputRevision, outputRevision),
  );
}

/** Pure Worker row predicate: no GitHub mutation is available through this seam. */
export function workerCompletionPersisted(
  record: AttemptRecord,
  report: WorkerReport,
  github: WorkerGithubObservation,
  reviewLabel: string,
): boolean {
  if (!boundToRecord(github, record)) return false;
  const outputRevision = report.result.outputRevision;
  if (!sameSha(record.outputRevision, outputRevision)) return false;
  const candidates = github.pullRequests.filter(
    (pullRequest) =>
      boundToRecord(pullRequest, record) && pullRequest.state === "open" && pullRequest.headBranch === record.branch,
  );
  if (candidates.length !== 1) return false;
  const pullRequest = candidates[0];
  return (
    sameSha(pullRequest.headSha, outputRevision) &&
    pullRequest.baseBranch === record.baseBranch &&
    pullRequest.closesIssue === record.target.number &&
    pullRequest.labels.includes(reviewLabel) &&
    markerMatches(pullRequest.marker, record, "complete", outputRevision) &&
    !sameSha(outputRevision, record.inputRevision.head)
  );
}

/**
 * Pure reviewer rows.
 *
 * A human-required outcome is a completed review like any other: the review ran, its result is
 * recorded on the pull request, and what is left belongs to a person. It closes on the same proof
 * the other outcomes need, and the state that proof describes is its caller's expected label set —
 * for a human handoff, one that keeps no agent workflow label at all.
 *
 * A handoff has two halves, and the empty expected set names only one of them. A pull request left
 * as a draft is not handed over however few labels it carries, so an expected set that waits on no
 * agent request has to see the draft gone as well.
 */
export function reviewerCompletionPersisted(
  record: AttemptRecord,
  report: ReviewerReport,
  github: ReviewerGithubObservation,
  expectedLabels: readonly string[],
  managedLabels: readonly string[] = expectedLabels,
): boolean {
  const transition = decideReviewTransition(report.result).transition;
  if (!boundToRecord(github, record) || !sameSha(github.headSha, record.inputRevision.head)) return false;
  const managed = new Set(managedLabels);
  if (!sameStringSet(github.labels.filter((label) => managed.has(label)), expectedLabels)) return false;
  if (expectedLabels.length === 0 && github.draft) return false;
  const persistence = github.reviewPersistence;
  if (
    !persistence ||
    !boundToRecord(persistence, record) ||
    !sameSha(persistence.headSha, record.inputRevision.head) ||
    !markerMatches(persistence.marker, record, report.result.outcome)
  ) {
    return false;
  }
  if (transition === "repair") {
    return persistence.boundedRepairAttemptMarked && sameFindings(persistence.findings, report.result.findings ?? []);
  }
  return true;
}

/** Pure review-repair rows. */
export function repairCompletionPersisted(
  record: AttemptRecord,
  report: RepairReport,
  github: WriterGithubObservation,
): boolean {
  if (!boundToRecord(github, record)) return false;
  const outputRevision = report.result.outputRevision;
  if (!sameSha(record.outputRevision, outputRevision)) return false;
  if (report.result.outcome === "stale_head") {
    return (
      sameSha(github.headSha, outputRevision) &&
      !sameSha(github.headSha, record.inputRevision.head) &&
      !github.pushRecorded &&
      !github.successClaimRecorded
    );
  }
  return (
    sameSha(github.headSha, outputRevision) &&
    !sameSha(outputRevision, record.inputRevision.head) &&
    github.pushRecorded &&
    github.successClaimRecorded &&
    markerMatches(github.marker, record, "repair_pushed", outputRevision) &&
    github.marker?.validationPassed === true
  );
}

/** Pure branch-update rows. The current base is intentionally not compared with the selected base. */
export function branchUpdateCompletionPersisted(
  record: AttemptRecord,
  report: BranchUpdateReport,
  github: WriterGithubObservation,
): boolean {
  if (!boundToRecord(github, record)) return false;
  const outputRevision = report.result.outputRevision;
  if (!sameSha(record.outputRevision, outputRevision)) return false;
  if (report.result.outcome === "stale_head") {
    return (
      sameSha(github.headSha, outputRevision) &&
      !sameSha(github.headSha, record.inputRevision.head) &&
      !github.pushRecorded &&
      !github.successClaimRecorded
    );
  }
  return (
    sameSha(github.headSha, outputRevision) &&
    !sameSha(outputRevision, record.inputRevision.head) &&
    github.pushRecorded &&
    github.successClaimRecorded &&
    markerMatches(github.marker, record, "branch_update_pushed", outputRevision) &&
    github.marker?.validationPassed === true
  );
}

function rolePredicate(
  record: AttemptRecord,
  report: CompleteReport,
  github: Exclude<GithubCompletionObservation, UncertainGithubObservation>,
  context: CompletionDecisionContext,
): boolean {
  if (report.role !== github.role) return false;
  if (report.role === "worker" && github.role === "worker") {
    return context.workerReviewLabel !== undefined
      && workerCompletionPersisted(record, report, github, context.workerReviewLabel);
  }
  if (report.role === "reviewer" && github.role === "reviewer") {
    return (
      context.reviewerExpectedLabels !== undefined &&
      reviewerCompletionPersisted(
        record,
        report,
        github,
        context.reviewerExpectedLabels,
        context.reviewerManagedLabels ?? context.reviewerExpectedLabels,
      )
    );
  }
  if (report.role === "review-repair" && github.role === "review-repair") {
    return repairCompletionPersisted(record, report, github);
  }
  if (report.role === "branch-update" && github.role === "branch-update") {
    return branchUpdateCompletionPersisted(record, report, github);
  }
  return false;
}

/**
 * Validates the launch-unique path and the V1 report against the durable record before consulting
 * the role predicate.
 */
export function evaluateCompletionPersistence(input: {
  record: AttemptRecord;
  report: AttemptReportObservation;
  github: GithubCompletionObservation;
  context?: CompletionDecisionContext;
  attemptActive?: boolean;
}): CompletionPersistenceDecision {
  if (input.record.phase === "launch_failed") return { action: "preserve", reason: "launch_failed" };
  if (!roleMatchesTarget(input.record.role, input.record.target)) {
    return { action: "preserve", reason: "invalid_report" };
  }
  if (input.report.kind === "missing") {
    return { action: "preserve", reason: input.attemptActive ? "active_attempt" : "missing_report" };
  }
  if (input.report.promisePath !== input.record.promiseFile) {
    return { action: "preserve", reason: "ownership_mismatch" };
  }

  let report: CompletionReportV1;
  try {
    report = validateCompletionReportBinding(input.record, input.report.report).report;
  } catch {
    return { action: "preserve", reason: "invalid_report" };
  }
  if (report.status === "blocked") return { action: "preserve", reason: "blocked" };
  if (["worker", "review-repair", "branch-update"].includes(report.role)) {
    if (!input.record.outputRevision || !sameSha(input.record.outputRevision, (report.result as { outputRevision: string }).outputRevision)) {
      return { action: "preserve", reason: "invalid_report" };
    }
  }
  if (input.github.kind === "uncertain") {
    return { action: "preserve", reason: "github_persistence_not_confirmed" };
  }
  return rolePredicate(input.record, report, input.github, input.context ?? {})
    ? { action: "close" }
    : { action: "preserve", reason: "github_persistence_not_confirmed" };
}

function uncertaintyObservation(error: unknown): Exclude<RunnerObservation<never>, { kind: "confirmed" }> {
  if (error instanceof RunnerUncertaintyError) {
    return { kind: "uncertain", reason: error.reason, detail: error.message };
  }
  return {
    kind: "uncertain",
    reason: "ambiguous",
    detail: error instanceof Error ? error.message : "unknown runner failure",
  };
}

async function observeRunner<T>(
  operation: () => RunnerObservation<T> | Promise<RunnerObservation<T>>,
): Promise<RunnerObservation<T>> {
  try {
    return await operation();
  } catch (error) {
    return uncertaintyObservation(error);
  }
}

export function normalizeRunnerUncertainty(
  observation: Exclude<RunnerObservation<unknown>, { kind: "confirmed" }>,
  stage: "ownership" | "cleanup",
):
  | { action: "preserve"; reason: "ownership_mismatch"; detail: string }
  | { action: "pending"; reason: "cleanup_pending"; detail: string } {
  if (stage === "ownership") {
    return { action: "preserve", reason: "ownership_mismatch", detail: observation.detail };
  }
  return { action: "pending", reason: "cleanup_pending", detail: observation.detail };
}

function ownedByRecord(record: AttemptRecord, ownership: WorkspaceOwnership): boolean {
  return (
    ownership.exists &&
    ownership.workspaceId === record.workspaceId &&
    ownership.ownerAttemptId === record.attemptId &&
    ownership.canonicalWorktreePath === record.worktreePath
  );
}

function cleanupPending(record: AttemptRecord, detail: string): AttemptWorkspaceReconciliation {
  return { action: "cleanup_pending", reason: "cleanup_pending", detail, record };
}

function pendingRunnerUncertainty(
  record: AttemptRecord,
  observation: Exclude<RunnerObservation<unknown>, { kind: "confirmed" }>,
): AttemptWorkspaceReconciliation {
  const normalized = normalizeRunnerUncertainty(observation, "cleanup");
  return cleanupPending(record, normalized.detail);
}

function preserveRunnerUncertainty(
  record: AttemptRecord,
  observation: Exclude<RunnerObservation<unknown>, { kind: "confirmed" }>,
): AttemptWorkspaceReconciliation {
  const normalized = normalizeRunnerUncertainty(observation, "ownership");
  return { action: "preserved", reason: normalized.reason, record };
}

async function finishAbsentWorkspace(
  record: AttemptRecord,
  dependencies: ReconciliationDependencies,
): Promise<AttemptWorkspaceReconciliation> {
  const worktree = await observeRunner(() =>
    dependencies.observeWorktree({
      canonicalPath: record.worktreePath,
      branch: record.branch,
    }),
  );
  if (worktree.kind === "uncertain") return pendingRunnerUncertainty(record, worktree);
  if (
    !worktree.value.exists ||
    worktree.value.canonicalPath !== record.worktreePath ||
    worktree.value.branch !== record.branch
  ) {
    return cleanupPending(record, "linked worktree path or branch was not retained");
  }
  const closed = await dependencies.persistPhase(record, "workspace_closed");
  return { action: "closed", record: closed };
}

/**
 * Cleanup-only orchestration. Its dependency contract deliberately exposes no GitHub/workflow
 * mutation, worktree removal, tab closure, pane closure, or agent retirement operation.
 */
export async function reconcileAttemptWorkspace(
  input: {
    record: AttemptRecord;
    report: AttemptReportObservation;
    github: GithubCompletionObservation;
    workspace: RunnerObservation<WorkspaceOwnership>;
    newerLiveOwner: RunnerObservation<boolean>;
    context?: CompletionDecisionContext;
    attemptActive?: boolean;
  },
  dependencies: ReconciliationDependencies,
): Promise<AttemptWorkspaceReconciliation> {
  if (input.record.phase === "workspace_closed") return { action: "closed", record: input.record };
  if (input.record.phase !== "github_persisted") {
    const decision = evaluateCompletionPersistence(input);
    if (decision.action === "preserve") {
      return { action: "preserved", reason: decision.reason, record: input.record };
    }
  }
  if (input.workspace.kind === "uncertain") {
    return input.record.phase === "github_persisted"
      ? pendingRunnerUncertainty(input.record, input.workspace)
      : preserveRunnerUncertainty(input.record, input.workspace);
  }
  if (input.newerLiveOwner.kind === "uncertain") {
    return preserveRunnerUncertainty(input.record, input.newerLiveOwner);
  }
  if (input.newerLiveOwner.value) {
    return { action: "preserved", reason: "newer_live_owner", record: input.record };
  }

  let record = input.record;
  if (!input.workspace.value.exists) {
    if (record.phase !== "github_persisted") {
      return { action: "preserved", reason: "ownership_mismatch", record };
    }
    return finishAbsentWorkspace(record, dependencies);
  }
  if (!ownedByRecord(record, input.workspace.value) || !record.workspaceId) {
    return { action: "preserved", reason: "ownership_mismatch", record };
  }
  const workspaceId = record.workspaceId;

  if (record.phase !== "github_persisted") record = await dependencies.persistPhase(record, "github_persisted");
  const close = await observeRunner(() => dependencies.closeWorkspace(workspaceId));
  if (close.kind === "uncertain") return pendingRunnerUncertainty(record, close);

  const workspace = await observeRunner(() => dependencies.observeWorkspace(workspaceId));
  if (workspace.kind === "uncertain") return pendingRunnerUncertainty(record, workspace);
  if (workspace.value.exists) return cleanupPending(record, "workspace remains after close");
  return finishAbsentWorkspace(record, dependencies);
}

export type FreshWorkspaceIdentity = {
  workspaceId: string;
  tabId: string;
  rootPaneId: string;
  canonicalWorktreePath: string;
};

export type FreshWorkspaceDependencies = {
  reconcileRetainedAttempts(): RunnerObservation<void> | Promise<RunnerObservation<void>>;
  observeMatchingWorkspaces():
    | RunnerObservation<WorkspaceOwnership[]>
    | Promise<RunnerObservation<WorkspaceOwnership[]>>;
  createWorktree(input: {
    repoPath: string;
    branch: string;
    baseBranch: string;
    label: string;
  }): RunnerObservation<FreshWorkspaceIdentity> | Promise<RunnerObservation<FreshWorkspaceIdentity>>;
  openWorktree(input: {
    repoPath: string;
    branch: string;
  }): RunnerObservation<FreshWorkspaceIdentity> | Promise<RunnerObservation<FreshWorkspaceIdentity>>;
  renameWorkspace(input: {
    workspaceId: string;
    label: string;
  }): RunnerObservation<void> | Promise<RunnerObservation<void>>;
};

export async function reconcileBeforeWorkspaceOpen(
  dependencies: Pick<FreshWorkspaceDependencies, "reconcileRetainedAttempts" | "observeMatchingWorkspaces">,
): Promise<
  | { action: "open_fresh"; openWithLabel: false; renameAfterOpen: true }
  | { action: "reject"; reason: "existing_workspace" | "ownership_ambiguous"; relabel: false }
> {
  const reconciled = await observeRunner(() => dependencies.reconcileRetainedAttempts());
  if (reconciled.kind === "uncertain") {
    normalizeRunnerUncertainty(reconciled, "ownership");
    return { action: "reject", reason: "ownership_ambiguous", relabel: false };
  }
  const matching = await observeRunner(() => dependencies.observeMatchingWorkspaces());
  if (matching.kind === "uncertain") {
    normalizeRunnerUncertainty(matching, "ownership");
    return { action: "reject", reason: "ownership_ambiguous", relabel: false };
  }
  if (matching.value.some((workspace) => workspace.exists)) {
    return { action: "reject", reason: "existing_workspace", relabel: false };
  }
  return { action: "open_fresh", openWithLabel: false, renameAfterOpen: true };
}

export type FreshWorkspaceInput = {
  repoPath: string;
  branch: string;
  workspaceLabel: string;
  expectedCanonicalWorktreePath: string;
  priorAttempt?: FreshWorkspaceIdentity;
} & ({ mode: "create"; baseBranch: string } | { mode: "open" });

export type FreshWorkspaceOrchestration =
  | { action: "opened"; identity: FreshWorkspaceIdentity }
  | {
      action: "rejected";
      reason: "existing_workspace" | "ownership_ambiguous" | "workspace_open_ambiguous" | "non_fresh_workspace";
      detail?: string;
      relabel: false;
    }
  | {
      action: "retained";
      reason: "workspace_rename_ambiguous";
      detail: string;
      identity: FreshWorkspaceIdentity;
    };

function validFreshIdentity(input: FreshWorkspaceInput, identity: FreshWorkspaceIdentity): boolean {
  const fields = [identity.workspaceId, identity.tabId, identity.rootPaneId, identity.canonicalWorktreePath];
  if (fields.some((field) => typeof field !== "string" || !field)) return false;
  if (identity.canonicalWorktreePath !== input.expectedCanonicalWorktreePath) return false;
  if (!input.priorAttempt) return true;
  return (
    input.priorAttempt.canonicalWorktreePath === identity.canonicalWorktreePath &&
    input.priorAttempt.workspaceId !== identity.workspaceId &&
    input.priorAttempt.tabId !== identity.tabId &&
    input.priorAttempt.rootPaneId !== identity.rootPaneId
  );
}

/** Dormant create/open seam. It is intentionally not imported by any selected automation path. */
export async function orchestrateFreshAttemptWorkspace(
  input: FreshWorkspaceInput,
  dependencies: FreshWorkspaceDependencies,
): Promise<FreshWorkspaceOrchestration> {
  const preOpen = await reconcileBeforeWorkspaceOpen(dependencies);
  if (preOpen.action === "reject") {
    return { action: "rejected", reason: preOpen.reason, relabel: false };
  }

  const opened = await observeRunner(() =>
    input.mode === "create"
      ? dependencies.createWorktree({
          repoPath: input.repoPath,
          branch: input.branch,
          baseBranch: input.baseBranch,
          label: input.workspaceLabel,
        })
      : dependencies.openWorktree({ repoPath: input.repoPath, branch: input.branch }),
  );
  if (opened.kind === "uncertain") {
    const normalized = normalizeRunnerUncertainty(opened, "ownership");
    return {
      action: "rejected",
      reason: "workspace_open_ambiguous",
      detail: normalized.detail,
      relabel: false,
    };
  }
  if (!validFreshIdentity(input, opened.value)) {
    return { action: "rejected", reason: "non_fresh_workspace", relabel: false };
  }

  const renamed = await observeRunner(() =>
    dependencies.renameWorkspace({ workspaceId: opened.value.workspaceId, label: input.workspaceLabel }),
  );
  if (renamed.kind === "uncertain") {
    const normalized = normalizeRunnerUncertainty(renamed, "ownership");
    return {
      action: "retained",
      reason: "workspace_rename_ambiguous",
      detail: normalized.detail,
      identity: opened.value,
    };
  }
  return { action: "opened", identity: opened.value };
}

export type AttemptWorkspaceDoctorFinding = {
  id: string;
  type: RetentionReason;
  title: string;
  summary: string;
  readOnly: true;
};

const DOCTOR_TITLES: Record<RetentionReason, string> = {
  active_attempt: "active attempt",
  blocked: "intentionally retained blocker",
  missing_report: "missing completion report",
  invalid_report: "malformed or mismatched completion report",
  github_persistence_not_confirmed: "GitHub persistence not confirmed",
  launch_failed: "launch failed after partial mutation",
  cleanup_pending: "cleanup pending after confirmed persistence",
  ownership_mismatch: "workspace ownership mismatch",
  newer_live_owner: "newer live attempt owns the checkout",
  herdr_unsupported: "unsupported or unsupported Herdr",
};

/** Data-only diagnostic; callers may render it, but no destructive operation is exposed. */
export function doctorFindingForRetention(reason: RetentionReason, attemptId: string): AttemptWorkspaceDoctorFinding {
  const title = DOCTOR_TITLES[reason];
  return {
    id: `attempt-workspace-${attemptId}-${reason}`,
    type: reason,
    title,
    summary: `Attempt ${attemptId} workspace retained: ${title}.`,
    readOnly: true,
  };
}
