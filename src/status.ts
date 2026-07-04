import path from "node:path";

import {
  automationStateKey,
  nextSlotAfter,
  type NormalizedProject,
  type AutomationStateEntry,
} from "./core";

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

export type StatusReportInput = {
  cwd: string;
  projects: NormalizedProject[];
  state?: PiLooperState;
  issues?: GithubItem[];
  openPrs?: GithubItem[];
  closedPrs?: GithubItem[];
  worktrees?: HerdrWorktree[];
  gitStatuses?: Record<string, string>;
  gitHeads?: Record<string, string>;
  nowMs?: number;
};

export type StatusLineItem = {
  number?: number;
  title?: string;
};

export type AutomationStatus = {
  id: string;
  name: string;
  schedule: string;
  lastResult: string;
  lastScheduledAt?: number;
  nextScheduledAt: number | null;
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
  cwd: string;
  automations: AutomationStatus[];
  issues: {
    eligible: StatusLineItem[];
    inProgress: StatusLineItem[];
    blockedOrNeedsInfo: StatusLineItem[];
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

export function resolveActiveProject(cwd: string, projects: NormalizedProject[]): NormalizedProject | null {
  return (
    projects.find((project) => {
      if (!project.repoPath) return false;
      try {
        return isPathInside(cwd, project.repoPath);
      } catch {
        return cwd === project.repoPath;
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
  return String(status || "").trim() === "";
}

function localHeadMatchesClosedPr(
  worktree: HerdrWorktree,
  pr: GithubItem,
  gitHeads: Record<string, string>,
): boolean {
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

function selectStaleLeftovers(
  worktrees: HerdrWorktree[],
  cleanupCandidates: CleanupCandidate[],
): HerdrWorktree[] {
  const cleanupPaths = new Set(cleanupCandidates.map((candidate) => candidate.path).filter(Boolean));
  return worktrees.filter((worktree) => worktree.path && cleanupPaths.has(worktree.path));
}

export function buildStatusSnapshot(input: StatusReportInput): StatusSnapshot {
  const project = resolveActiveProject(input.cwd, input.projects);
  const nowMs = input.nowMs ?? Date.now();
  if (!project) {
    return {
      project: null,
      cwd: input.cwd,
      automations: [],
      issues: { eligible: [], inProgress: [], blockedOrNeedsInfo: [] },
      prs: { reviewTarget: [], reviewing: [] },
      herdr: { workerWorktrees: [], cleanupCandidates: [], staleLeftovers: [] },
    };
  }

  const state = input.state || { automations: {} };
  const automations = project.automations.map((automation) => {
    const entry = state.automations?.[automationStateKey(project, automation)] || {};
    return {
      id: automation.id,
      name: automation.name,
      schedule: automation.schedule,
      lastResult: String(entry.lastResult || "never"),
      lastScheduledAt: Number.isFinite(entry.lastScheduledAt) ? Number(entry.lastScheduledAt) : undefined,
      nextScheduledAt: nextSlotAfter(entry, automation, nowMs),
    };
  });

  const issues = input.issues || [];
  const eligible = issues.filter((issue) => {
    const labels = labelsOf(issue);
    return labels.has(project.labels.ready) && labels.has(project.labels.implement) && !labels.has(project.labels.inProgress) && !labels.has(project.labels.blocked) && !labels.has(project.labels.needsInfo) && !labels.has(project.labels.wontfix);
  });
  const inProgress = issues.filter((issue) => labelsOf(issue).has(project.labels.inProgress));
  const blockedOrNeedsInfo = issues.filter((issue) => {
    const labels = labelsOf(issue);
    return labels.has(project.labels.blocked) || labels.has(project.labels.needsInfo);
  });

  const openPrs = input.openPrs || [];
  const reviewTarget = openPrs.filter((pr) => labelsOf(pr).has(project.labels.review));
  const reviewing = openPrs.filter((pr) => labelsOf(pr).has(project.labels.reviewing));

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
    cwd: input.cwd,
    automations,
    issues: {
      eligible: eligible.map(lineItem),
      inProgress: inProgress.map(lineItem),
      blockedOrNeedsInfo: blockedOrNeedsInfo.map(lineItem),
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

function formatCleanupCandidates(candidates: CleanupCandidate[]): string {
  if (!candidates.length) return "none";
  return candidates
    .map((candidate) => {
      const pr = candidate.prNumber ? `#${candidate.prNumber} ` : "";
      return `${pr}${candidate.branch || "unknown-branch"} -> ${candidate.path || "unknown-path"} (${candidate.reason})`;
    })
    .join("; ");
}

export function formatStatusReport(snapshot: StatusSnapshot): string {
  if (!snapshot.project) {
    return [`pi-looper status: no active project`, `cwd: ${snapshot.cwd}`].join("\n");
  }

  const project = snapshot.project;
  const lines = [
    `pi-looper status: ${project.id}`,
    `repo: ${project.githubRepo || "unknown"}`,
    `cwd: ${snapshot.cwd}`,
    `autoMerge: ${project.autoMerge ? "on" : "off"}`,
    "",
    "Automations:",
  ];

  if (!snapshot.automations.length) {
    lines.push("- none");
  } else {
    for (const automation of snapshot.automations) {
      lines.push(
        `- ${automation.name}: ${automation.schedule}; last=${automation.lastResult}; next=${formatTimestamp(automation.nextScheduledAt)}`,
      );
    }
  }

  lines.push(
    "",
    "Issues:",
    `- eligible: ${formatItems(snapshot.issues.eligible)}`,
    `- in-progress: ${formatItems(snapshot.issues.inProgress)}`,
    `- blocked/needs-info: ${formatItems(snapshot.issues.blockedOrNeedsInfo)}`,
    "",
    "PRs:",
    `- review target: ${formatItems(snapshot.prs.reviewTarget)}`,
    `- reviewing: ${formatItems(snapshot.prs.reviewing)}`,
    "",
    "Herdr:",
    `- worker worktrees: ${snapshot.herdr.workerWorktrees.length}`,
    `- cleanup candidates: ${formatCleanupCandidates(snapshot.herdr.cleanupCandidates)}`,
    `- stale leftovers: ${snapshot.herdr.staleLeftovers.length ? snapshot.herdr.staleLeftovers.map((worktree) => worktree.path || worktree.branch || "unknown").join(", ") : "none"}`,
  );

  return lines.join("\n");
}
