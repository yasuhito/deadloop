import path from "node:path";

import { hasUncommittedWork } from "./agent-scratch-area.cjs";
import type { CodeIdentityDecision } from "./code-identity";
import { automationStateKey, nextSlotAfter, type NormalizedProject, type AutomationStateEntry } from "./core";
import { passesIssueLabelGate } from "./issue-eligibility.cjs";
import type { AttemptUsageSummary } from "./model-usage-types";
const { formatCurrentAttemptUsage } = require("./model-usage-report.cts") as {
  formatCurrentAttemptUsage: (summaries: AttemptUsageSummary[]) => string[];
};
import { formatRequiredVerification } from "./required-verification";

const { observeProjectBaseBlocking } = require("./ci-base-blocking.cts") as {
  observeProjectBaseBlocking: (input: { stateDir: string; projectId: string; repoPath: string; baseBranch?: string }) => { active: boolean; reason?: string; record?: Record<string, unknown> };
};

export type LabelLike = string | { name?: string | null };

export type GithubItem = {
  number?: number;
  title?: string;
  state?: string;
  labels?: LabelLike[];
  headRefName?: string;
  headRefOid?: string;
  mergedAt?: string | null;
  closedAt?: string | null;
};

export type HerdrWorktree = {
  branch?: string;
  path?: string;
  open_workspace_id?: string | null;
  workspaceId?: string | null;
  is_linked_worktree?: boolean;
};

export type PiLooperState = {
  automations?: Record<string, AutomationStateEntry & Record<string, unknown>>;
};

export type RepositoryEnablement = "enabled" | "disabled" | "unavailable";

export type StatusReportInput = {
  cwd: string;
  projects: NormalizedProject[];
  repositoryEnablement?: RepositoryEnablement;
  state?: PiLooperState;
  statePath?: string;
  issues?: GithubItem[];
  openPrs?: GithubItem[];
  closedPrs?: GithubItem[];
  worktrees?: HerdrWorktree[];
  gitStatuses?: Record<string, string>;
  gitHeads?: Record<string, string>;
  warnings?: string[];
  codeIdentity?: CodeIdentityDecision;
  selectedProject?: NormalizedProject | null;
  nowMs?: number;
  /** Normalized usage summaries for attempts that still own a workspace (current-attempt view). */
  attemptUsage?: AttemptUsageSummary[];
};

export type StatusLineItem = {
  number?: number;
  title?: string;
};

export type ModelAvailabilityWaitStatus = {
  startedAt: string;
  durationMilliseconds: number;
  nextRetryAt: string | null;
  retryCount: number;
};

export type AutomationStatus = {
  id: string;
  name: string;
  schedule: string;
  lastResult: string;
  lastSummary?: string;
  lastScheduledAt?: number;
  nextScheduledAt: number | null;
  activeWorkMilliseconds?: number;
  modelWait?: ModelAvailabilityWaitStatus;
};

export type CleanupCandidate = {
  prNumber?: number;
  branch?: string;
  path?: string;
  workspaceId?: string | null;
  reason: string;
};

export type StatusSnapshot = {
  project: NormalizedProject | null;
  repositoryEnablement: RepositoryEnablement;
  cwd: string;
  warnings: string[];
  codeIdentity?: CodeIdentityDecision;
  attemptUsage: AttemptUsageSummary[];
  baseVerificationBlocked?: { reason?: string; failedAt?: string };
  automations: AutomationStatus[];
  issues: {
    eligible: StatusLineItem[];
    inProgress: StatusLineItem[];
    waitingForPerson: StatusLineItem[];
  };
  prs: {
    reviewTarget: StatusLineItem[];
    reviewing: StatusLineItem[];
  };
  herdr: {
    workerWorktrees: HerdrWorktree[];
    cleanupCandidates: CleanupCandidate[];
    staleLeftovers: HerdrWorktree[];
  };
};

export function labelsOf(item: Pick<GithubItem, "labels">): Set<string> {
  const names = new Set<string>();
  for (const label of item.labels || []) {
    if (typeof label === "string") {
      names.add(label);
    } else if (label?.name) {
      names.add(String(label.name));
    }
  }
  return names;
}

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveActiveProject(repositoryRoot: string, projects: NormalizedProject[]): NormalizedProject | null {
  return (
    projects.find((project) => {
      if (!project.repoPath) return false;
      try {
        return path.resolve(repositoryRoot) === path.resolve(project.repoPath);
      } catch {
        return repositoryRoot === project.repoPath;
      }
    }) || null
  );
}

function lineItem(item: GithubItem): StatusLineItem {
  return { number: item.number, title: item.title };
}

function isClosedPr(pr: GithubItem): boolean {
  const state = String(pr.state || "").toUpperCase();
  return state === "CLOSED" || state === "MERGED" || Boolean(pr.closedAt) || Boolean(pr.mergedAt);
}

function isMergedPr(pr: GithubItem): boolean {
  return String(pr.state || "").toUpperCase() === "MERGED" || Boolean(pr.mergedAt);
}

function isWorkerWorktree(worktree: HerdrWorktree, project: NormalizedProject): boolean {
  const branch = String(worktree.branch || "");
  if (branch.startsWith("agent/issue-")) return true;
  const worktreePath = String(worktree.path || "");
  if (!worktreePath || !project.worktreeRoot) return false;
  return isPathInside(worktreePath, project.worktreeRoot);
}

function isClean(status: unknown): boolean {
  return !hasUncommittedWork(status);
}

function localHeadMatchesClosedPr(worktree: HerdrWorktree, pr: GithubItem, gitHeads: Record<string, string>): boolean {
  const expected = String(pr.headRefOid || "");
  const worktreePath = String(worktree.path || "");
  if (!expected || !worktreePath) return false;
  return gitHeads[worktreePath] === expected;
}

function selectCleanupCandidates(
  project: NormalizedProject,
  closedPrs: GithubItem[],
  worktrees: HerdrWorktree[],
  gitStatuses: Record<string, string>,
  gitHeads: Record<string, string>,
): CleanupCandidate[] {
  const byBranch = new Map<string, HerdrWorktree>();
  for (const worktree of worktrees) {
    if (worktree.branch) byBranch.set(worktree.branch, worktree);
  }

  const candidates: CleanupCandidate[] = [];
  const selectedPaths = new Set<string>();
  for (const pr of [...closedPrs].sort((a, b) => Number(a.number || 0) - Number(b.number || 0))) {
    if (!isClosedPr(pr)) continue;
    const branch = String(pr.headRefName || "");
    if (!branch) continue;
    const worktree = byBranch.get(branch);
    if (!worktree) continue;
    const worktreePath = String(worktree.path || "");
    if (!worktreePath || selectedPaths.has(worktreePath)) continue;
    if (project.repoPath && path.resolve(worktreePath) === path.resolve(project.repoPath)) continue;
    if (worktree.is_linked_worktree === false) continue;
    const workspaceId = worktree.open_workspace_id || worktree.workspaceId;
    if (!workspaceId) continue;
    if (project.worktreeRoot && !isPathInside(worktreePath, project.worktreeRoot)) continue;
    if (!Object.prototype.hasOwnProperty.call(gitStatuses, worktreePath)) continue;
    if (!isClean(gitStatuses[worktreePath])) continue;

    let reason: string | null = null;
    if (isMergedPr(pr)) {
      reason = "merged_pr";
    } else if (localHeadMatchesClosedPr(worktree, pr, gitHeads)) {
      reason = "closed_pr_head_preserved";
    }
    if (!reason) continue;

    selectedPaths.add(worktreePath);
    candidates.push({
      prNumber: pr.number,
      branch: worktree.branch,
      path: worktree.path,
      workspaceId,
      reason,
    });
  }
  return candidates;
}

function selectStaleLeftovers(worktrees: HerdrWorktree[], cleanupCandidates: CleanupCandidate[]): HerdrWorktree[] {
  const cleanupPaths = new Set(cleanupCandidates.map((candidate) => candidate.path).filter(Boolean));
  return worktrees.filter((worktree) => worktree.path && cleanupPaths.has(worktree.path));
}

function modelAvailabilityWaitStatus(entry: Record<string, unknown>, nowMs: number): ModelAvailabilityWaitStatus | undefined {
  const handoff = entry.pendingDriverHandoff;
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) return undefined;
  const payload = handoff as Record<string, unknown>;
  const wait = payload.modelWait as Record<string, unknown> | undefined;
  if (!wait || typeof wait !== "object") return undefined;
  const startedAt = typeof wait.startedAt === "string" ? wait.startedAt : "";
  const startedMs = Date.parse(startedAt);
  return {
    startedAt,
    durationMilliseconds: Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : 0,
    nextRetryAt: typeof wait.nextRetryAt === "string" ? wait.nextRetryAt : null,
    retryCount: Number(payload.modelRetryCount || 0),
  };
}

export function buildStatusSnapshot(input: StatusReportInput): StatusSnapshot {
  const project = input.selectedProject === undefined
    ? resolveActiveProject(input.cwd, input.projects)
    : input.selectedProject;
  const repositoryEnablement = project ? "enabled" : input.repositoryEnablement || "unavailable";
  const nowMs = input.nowMs ?? Date.now();
  if (!project) {
    return {
      project: null,
      repositoryEnablement,
      cwd: input.cwd,
      warnings: input.warnings || [],
      codeIdentity: input.codeIdentity,
      attemptUsage: [],
      automations: [],
      issues: { eligible: [], inProgress: [], waitingForPerson: [] },
      prs: { reviewTarget: [], reviewing: [] },
      herdr: { workerWorktrees: [], cleanupCandidates: [], staleLeftovers: [] },
    };
  }

  const state = input.state || { automations: {} };
  let baseVerificationBlocked: StatusSnapshot["baseVerificationBlocked"];
  if (project.repoPath && input.statePath) {
    try {
      const blocking = observeProjectBaseBlocking({
        stateDir: path.dirname(input.statePath),
        projectId: project.id,
        repoPath: project.repoPath,
        baseBranch: project.baseBranch,
      });
      if (blocking.active) {
        const record = (blocking.record || {}) as Record<string, unknown>;
        baseVerificationBlocked = { reason: blocking.reason, failedAt: record.failedAt ? String(record.failedAt) : undefined };
      }
    } catch {}
  }
  const automations = project.automations.map((automation) => {
    const entry = state.automations?.[automationStateKey(project, automation)] || {};
    const handoff = entry.pendingDriverHandoff;
    const payload = handoff && typeof handoff === "object" && !Array.isArray(handoff)
      ? handoff as Record<string, unknown>
      : undefined;
    const accounting = payload?.monitorAccounting as { activeMilliseconds?: unknown } | undefined;
    const activeMilliseconds = Number(accounting?.activeMilliseconds);
    return {
      id: automation.id,
      name: automation.name,
      schedule: automation.schedule,
      lastResult: String(entry.lastResult || "never"),
      lastSummary: String(entry.lastSummary || "").trim() || undefined,
      lastScheduledAt: Number.isFinite(entry.lastScheduledAt) ? Number(entry.lastScheduledAt) : undefined,
      nextScheduledAt: nextSlotAfter(entry, automation, nowMs),
      activeWorkMilliseconds: accounting && Number.isFinite(activeMilliseconds) ? activeMilliseconds : undefined,
      modelWait: modelAvailabilityWaitStatus(entry, nowMs),
    };
  });

  const issues = input.issues || [];
  // The implementation request is the `agent:implement` label and the same five labels stop it, so this
  // reuses the gate the launcher itself applies (issue-coordinator-decisions.cts) rather than restating
  // it: two hand-written copies are what let `ready-for-agent` become a phantom requirement here. The
  // gate's other conditions are not reproduced — it serves `agent:explore` requests first and skips an
  // Issue whose dependencies are still open, neither of which status fetches.
  const eligible = issues.filter((issue) =>
    passesIssueLabelGate(issue, {
      required: [project.labels.implement],
      blocked: [
        project.labels.inProgress,
        project.labels.blocked,
        project.labels.needsInfo,
        project.labels.human,
        project.labels.wontfix,
      ],
    }),
  );
  const inProgress = issues.filter((issue) => labelsOf(issue).has(project.labels.inProgress));
  // `ready-for-human` joins this line because it is the third way an Issue waits on a person; without it
  // an Issue handed back to a human would be excluded from eligible and named nowhere in the report.
  const waitingForPerson = issues.filter((issue) => {
    const labels = labelsOf(issue);
    return labels.has(project.labels.blocked) || labels.has(project.labels.needsInfo) || labels.has(project.labels.human);
  });

  const openPrs = input.openPrs || [];
  const reviewTarget = openPrs.filter((pr) => labelsOf(pr).has(project.labels.review));
  const reviewing = openPrs.filter((pr) => labelsOf(pr).has(project.labels.inProgress));

  const workerWorktrees = (input.worktrees || []).filter((worktree) => isWorkerWorktree(worktree, project));
  const cleanupCandidates = selectCleanupCandidates(
    project,
    input.closedPrs || [],
    workerWorktrees,
    input.gitStatuses || {},
    input.gitHeads || {},
  );

  return {
    project,
    repositoryEnablement,
    cwd: input.cwd,
    warnings: input.warnings || [],
    codeIdentity: input.codeIdentity,
    attemptUsage: (input.attemptUsage || []).filter((summary) => summary.active),
    ...(baseVerificationBlocked ? { baseVerificationBlocked } : {}),
    automations,
    issues: {
      eligible: eligible.map(lineItem),
      inProgress: inProgress.map(lineItem),
      waitingForPerson: waitingForPerson.map(lineItem),
    },
    prs: {
      reviewTarget: reviewTarget.map(lineItem),
      reviewing: reviewing.map(lineItem),
    },
    herdr: {
      workerWorktrees,
      cleanupCandidates,
      staleLeftovers: selectStaleLeftovers(workerWorktrees, cleanupCandidates),
    },
  };
}

function formatTimestamp(ms: number | null | undefined): string {
  if (!ms) return "unknown";
  return new Date(ms).toISOString();
}

function formatItems(items: StatusLineItem[]): string {
  if (!items.length) return "none";
  return items.map((item) => `#${item.number ?? "?"}${item.title ? ` ${item.title}` : ""}`).join(", ");
}

function formatConfigSource(project: NormalizedProject): string {
  const source = project.configSource;
  const local = source.localPath || "unknown local projects.json";
  const policy = `${source.repoPolicyBaseBranch}:${source.repoPolicyPath}`;
  const applied = source.repoPolicyAppliedKeys.length ? `; applied=${source.repoPolicyAppliedKeys.join(",")}` : "";
  const error = source.repoPolicyError ? `; error=${source.repoPolicyError}` : "";
  return `local=${local}; repoPolicy=${policy} (${source.repoPolicyStatus}${applied}${error})`;
}

function formatWorktrees(worktrees: HerdrWorktree[]): string {
  if (!worktrees.length) return "none";
  return worktrees
    .map((worktree) => {
      const workspaceId = worktree.open_workspace_id || worktree.workspaceId || "no-workspace";
      return `${worktree.branch || "unknown-branch"} -> ${worktree.path || "unknown-path"} (${workspaceId})`;
    })
    .join("; ");
}

function formatCleanupCandidates(candidates: CleanupCandidate[]): string {
  if (!candidates.length) return "none";
  return candidates
    .map((candidate) => {
      const pr = candidate.prNumber ? `#${candidate.prNumber} ` : "";
      const workspaceId = candidate.workspaceId || "no-workspace";
      return `${pr}${candidate.branch || "unknown-branch"} -> ${candidate.path || "unknown-path"} (${workspaceId}; ${candidate.reason})`;
    })
    .join("; ");
}

function formatAutomationSummary(summary: string | undefined): string {
  return summary ? `; summary=${summary}` : "";
}

function formatModelWait(wait: ModelAvailabilityWaitStatus | undefined): string {
  if (!wait) return "";
  const next = wait.nextRetryAt ? formatTimestamp(Date.parse(wait.nextRetryAt)) : "next scheduler tick";
  return `; waiting-for-model since=${wait.startedAt || "unknown"} (${wait.durationMilliseconds}ms)`
    + `; retries=${wait.retryCount}; next-retry=${next}`;
}

function formatActiveWork(activeWorkMilliseconds: number | undefined): string {
  return activeWorkMilliseconds === undefined ? "" : `; active-work=${activeWorkMilliseconds}ms`;
}

function formatCodeIdentity(decision: CodeIdentityDecision | undefined): string[] {
  if (!decision) return [];
  return [
    `loaded code identity: ${decision.loadedIdentity || "unavailable"}`,
    `deployed code identity: ${decision.deployedIdentity || "unavailable"}`,
    `automation host: ${decision.action === "continue" ? "running" : "stopped"}`,
    ...(decision.action === "stop" ? [`stop reason: ${decision.reason}`, `recovery: ${decision.recovery}`] : []),
  ];
}

export function formatStatusReport(snapshot: StatusSnapshot): string {
  const codeIdentity = formatCodeIdentity(snapshot.codeIdentity);
  if (!snapshot.project) {
    const lines = snapshot.repositoryEnablement === "disabled"
      ? ["deadloop is not enabled for this repository.", "", "Enable it:", "  /deadloop-enable", ""]
      : ["deadloop status is unavailable for the current location.", ""];
    return [
      ...lines,
      `cwd: ${snapshot.cwd}`,
      ...codeIdentity,
      ...snapshot.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n");
  }

  const project = snapshot.project;
  const lines = [
    `deadloop status: ${project.id}`,
    `repo: ${project.githubRepo || "unknown"}`,
    `cwd: ${snapshot.cwd}`,
    ...codeIdentity,
    ...snapshot.warnings.map((warning) => `warning: ${warning}`),
    `config: ${formatConfigSource(project)}`,
    formatRequiredVerification(project.requiredVerification),
    ...(snapshot.baseVerificationBlocked
      ? [`baseVerificationBlocked: ${snapshot.baseVerificationBlocked.reason || "base_verification_failed"} since ${snapshot.baseVerificationBlocked.failedAt || "unknown"}; no agent launch consumes an Agent request until base or contract changes`]
      : []),
    `autoMerge: ${project.autoMerge ? "on" : "off"}`,
    `externalReview: ${project.externalReview.enabled ? "on" : "off"}`,
    `roleModels: worker=${project.workerModel}; reviewer=${project.reviewerModel}`
      + `; explorer=${project.explorerModel}; repair=${project.repairModel}; branchUpdate=${project.branchUpdateModel}`,
    "attemptMonitoring: deterministic for all roles (no Automation-host model)",
    ...formatCurrentAttemptUsage(snapshot.attemptUsage),
    "",
    "Automations:",
  ];

  if (!snapshot.automations.length) {
    lines.push("- none");
  } else {
    for (const automation of snapshot.automations) {
      const summary = formatAutomationSummary(automation.lastSummary);
      lines.push(
        `- ${automation.name}: ${automation.schedule}; last=${automation.lastResult}${summary}`
        + `${formatActiveWork(automation.activeWorkMilliseconds)}${formatModelWait(automation.modelWait)}`
        + `; next=${formatTimestamp(automation.nextScheduledAt)}`,
      );
    }
  }

  lines.push(
    "",
    "Issues:",
    `- eligible: ${formatItems(snapshot.issues.eligible)}`,
    `- in-progress: ${formatItems(snapshot.issues.inProgress)}`,
    `- waiting for a person: ${formatItems(snapshot.issues.waitingForPerson)}`,
    "",
    "PRs:",
    `- review target: ${formatItems(snapshot.prs.reviewTarget)}`,
    `- reviewing: ${formatItems(snapshot.prs.reviewing)}`,
    "",
    "Herdr:",
    `- worker worktrees: ${formatWorktrees(snapshot.herdr.workerWorktrees)}`,
    `- cleanup candidates: ${formatCleanupCandidates(snapshot.herdr.cleanupCandidates)}`,
    `- stale leftovers: ${snapshot.herdr.staleLeftovers.length ? snapshot.herdr.staleLeftovers.map((worktree) => worktree.path || worktree.branch || "unknown").join(", ") : "none"}`,
  );

  return lines.join("\n");
}
