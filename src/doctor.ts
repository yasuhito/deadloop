import path from "node:path";

import type { NormalizedProject } from "./core";
import { type GithubItem, type HerdrWorktree, labelsOf, resolveActiveProject } from "./status";

const STALE_IN_PROGRESS_MS = 24 * 60 * 60 * 1000;
const MAX_COMMENT_SUMMARY_LENGTH = 180;

type GithubComment = {
  body?: string | null;
  createdAt?: string | null;
  author?: { login?: string | null } | null;
};

export type DoctorGithubItem = GithubItem & {
  body?: string | null;
  updatedAt?: string | null;
  comments?: GithubComment[];
};

export type DoctorInput = {
  cwd: string;
  projects: NormalizedProject[];
  issues?: DoctorGithubItem[];
  openPrs?: DoctorGithubItem[];
  worktrees?: HerdrWorktree[];
  gitStatuses?: Record<string, string>;
  nowMs?: number;
};

export type DoctorFindingType =
  | "blocked_issue"
  | "stale_in_progress"
  | "orphan_worktree"
  | "queue_jam";

export type DoctorFinding = {
  id: string;
  type: DoctorFindingType;
  title: string;
  summary: string;
  commands: string[];
};

export type DoctorSnapshot = {
  project: NormalizedProject | null;
  cwd: string;
  findings: DoctorFinding[];
};

function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function isWorkerWorktree(worktree: HerdrWorktree, project: NormalizedProject): boolean {
  const branch = String(worktree.branch || "");
  if (branch.startsWith("agent/issue-")) return true;
  const worktreePath = String(worktree.path || "");
  if (!worktreePath || !project.worktreeRoot) return false;
  return isPathInside(worktreePath, project.worktreeRoot);
}

function shellArg(value: unknown): string {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function issueRef(issue: Pick<DoctorGithubItem, "number" | "title">): string {
  return `#${issue.number ?? "?"}${issue.title ? ` ${issue.title}` : ""}`;
}

function compactLine(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function newestFirst(comments: GithubComment[]): GithubComment[] {
  return [...comments].sort((a, b) => Date.parse(String(b.createdAt || "")) - Date.parse(String(a.createdAt || "")));
}

function blockedCommentSummary(issue: DoctorGithubItem): string {
  const comments = newestFirst(issue.comments || []);
  const comment = comments.find((candidate) => /blocked|blocker|ブロック|停止/i.test(String(candidate.body || "")))
    || comments.find((candidate) => compactLine(candidate.body));
  const body = compactLine(comment?.body);
  if (!body) return "blocked コメントは見つかりませんでした。Issue 本文と最近のコメントを確認してください。";
  if (body.length <= MAX_COMMENT_SUMMARY_LENGTH) return body;
  return `${body.slice(0, MAX_COMMENT_SUMMARY_LENGTH - 1)}…`;
}

function parseIssueNumberFromWorktree(worktree: HerdrWorktree): number | null {
  const text = `${worktree.branch || ""} ${worktree.path || ""}`;
  const match = /(?:^|[-_/])issue-(\d+)(?:$|[-_/\s])/i.exec(text);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

function worktreeMatchesIssue(worktree: HerdrWorktree, issueNumber: number): boolean {
  const text = `${worktree.branch || ""} ${worktree.path || ""}`;
  return new RegExp(`(?:^|[-_/])issue-${issueNumber}(?:$|[-_/\\s])`, "i").test(text);
}

function worktreePath(worktree: HerdrWorktree): string {
  return String(worktree.path || "");
}

function workspaceId(worktree: HerdrWorktree): string {
  return String(worktree.open_workspace_id || worktree.workspaceId || "");
}

function findWorktreeForIssue(issueNumber: number, worktrees: HerdrWorktree[]): HerdrWorktree | null {
  return worktrees.find((worktree) => worktreeMatchesIssue(worktree, issueNumber)) || null;
}

function isStale(issue: DoctorGithubItem, nowMs: number): boolean {
  const updatedAt = Date.parse(String(issue.updatedAt || ""));
  if (!Number.isFinite(updatedAt)) return false;
  return nowMs - updatedAt >= STALE_IN_PROGRESS_MS;
}

function gitInspectionCommands(project: NormalizedProject, worktree: HerdrWorktree | null): string[] {
  const targetPath = worktree ? worktreePath(worktree) : "";
  if (targetPath) {
    return [
      `git -C ${shellArg(targetPath)} status --short`,
      `git -C ${shellArg(targetPath)} log ${shellArg(project.baseBranch || "origin/main")}..HEAD --oneline`,
    ];
  }
  if (project.repoPath) return [`herdr worktree list --cwd ${shellArg(project.repoPath)} --json`];
  return ["herdr worktree list --json"];
}

function hasOpenIssueForWorktree(worktree: HerdrWorktree, issues: DoctorGithubItem[]): boolean {
  const number = parseIssueNumberFromWorktree(worktree);
  if (!number) return false;
  return issues.some((issue) => Number(issue.number) === number);
}

function hasOpenPrForWorktree(worktree: HerdrWorktree, openPrs: DoctorGithubItem[]): boolean {
  const branch = String(worktree.branch || "");
  if (!branch) return false;
  return openPrs.some((pr) => String(pr.headRefName || "") === branch);
}

function isCleanStatus(gitStatuses: Record<string, string>, pathValue: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(gitStatuses, pathValue)) return false;
  return String(gitStatuses[pathValue] || "").trim() === "";
}

function buildBlockedIssueFindings(project: NormalizedProject, issues: DoctorGithubItem[]): DoctorFinding[] {
  return issues
    .filter((issue) => labelsOf(issue).has(project.labels.blocked))
    .map((issue) => ({
      id: `blocked-issue-${issue.number ?? "unknown"}`,
      type: "blocked_issue" as const,
      title: `blocked issue: ${issueRef(issue)}`,
      summary: blockedCommentSummary(issue),
      commands: [
        `gh issue edit ${issue.number ?? "<number>"} --remove-label ${shellArg(project.labels.blocked)} --add-label ${shellArg(project.labels.implement)}`,
      ],
    }));
}

function buildStaleInProgressFindings(
  project: NormalizedProject,
  issues: DoctorGithubItem[],
  worktrees: HerdrWorktree[],
  nowMs: number,
): DoctorFinding[] {
  return issues
    .filter((issue) => labelsOf(issue).has(project.labels.inProgress))
    .filter((issue) => isStale(issue, nowMs))
    .map((issue) => {
      const worktree = issue.number ? findWorktreeForIssue(issue.number, worktrees) : null;
      return {
        id: `stale-in-progress-${issue.number ?? "unknown"}`,
        type: "stale_in_progress" as const,
        title: `stale in-progress issue: ${issueRef(issue)}`,
        summary: `24 時間以上更新がありません。updatedAt=${issue.updatedAt || "unknown"}`,
        commands: gitInspectionCommands(project, worktree),
      };
    });
}

function buildOrphanWorktreeFindings(
  project: NormalizedProject,
  issues: DoctorGithubItem[],
  openPrs: DoctorGithubItem[],
  worktrees: HerdrWorktree[],
  gitStatuses: Record<string, string>,
): DoctorFinding[] {
  return worktrees
    .filter((worktree) => worktree.is_linked_worktree !== false)
    .filter((worktree) => isWorkerWorktree(worktree, project))
    .filter((worktree) => {
      const currentPath = worktreePath(worktree);
      return !project.repoPath || !currentPath || path.resolve(currentPath) !== path.resolve(project.repoPath);
    })
    .filter((worktree) => !hasOpenIssueForWorktree(worktree, issues) && !hasOpenPrForWorktree(worktree, openPrs))
    .map((worktree) => {
      const currentPath = worktreePath(worktree);
      const currentWorkspaceId = workspaceId(worktree);
      const clean = currentPath ? isCleanStatus(gitStatuses, currentPath) : false;
      const commands = clean && currentWorkspaceId
        ? [`herdr worktree remove --workspace ${shellArg(currentWorkspaceId)}`]
        : gitInspectionCommands(project, worktree);
      return {
        id: `orphan-worktree-${currentWorkspaceId || currentPath || worktree.branch || "unknown"}`,
        type: "orphan_worktree" as const,
        title: `orphan linked worktree: ${worktree.branch || "unknown-branch"}`,
        summary: clean
          ? `対応する open issue / open PR が無く、作業ツリーは clean です: ${currentPath || "unknown-path"}`
          : `対応する open issue / open PR がありません。未コミット変更の確認が必要です: ${currentPath || "unknown-path"}`,
        commands,
      };
    });
}

function buildQueueJamFindings(project: NormalizedProject, issues: DoctorGithubItem[]): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const issue of issues) {
    const labels = labelsOf(issue);
    if (
      labels.has(project.labels.ready) &&
      !labels.has(project.labels.implement) &&
      !labels.has(project.labels.blocked) &&
      !labels.has(project.labels.inProgress) &&
      !labels.has(project.labels.needsInfo) &&
      !labels.has(project.labels.needsTriage) &&
      !labels.has(project.labels.wontfix)
    ) {
      findings.push({
        id: `ready-without-implement-${issue.number ?? "unknown"}`,
        type: "queue_jam",
        title: `ready issue missing implement label: ${issueRef(issue)}`,
        summary: `${project.labels.ready} はありますが ${project.labels.implement} がありません。Worker が拾えるキューに入っていません。`,
        commands: [`gh issue edit ${issue.number ?? "<number>"} --add-label ${shellArg(project.labels.implement)}`],
      });
    }
    if (labels.has(project.labels.needsTriage)) {
      findings.push({
        id: `needs-triage-${issue.number ?? "unknown"}`,
        type: "queue_jam",
        title: `needs-triage issue: ${issueRef(issue)}`,
        summary: `${project.labels.needsTriage} に降格されています。内容を確認し、実装可能ならラベルを戻してください。`,
        commands: [
          `gh issue view ${issue.number ?? "<number>"}`,
          `gh issue edit ${issue.number ?? "<number>"} --remove-label ${shellArg(project.labels.needsTriage)} --add-label ${shellArg(project.labels.ready)} --add-label ${shellArg(project.labels.implement)}`,
        ],
      });
    }
  }
  return findings;
}

export function buildDoctorSnapshot(input: DoctorInput): DoctorSnapshot {
  const project = resolveActiveProject(input.cwd, input.projects);
  if (!project) return { project: null, cwd: input.cwd, findings: [] };

  const issues = input.issues || [];
  const openPrs = input.openPrs || [];
  const worktrees = input.worktrees || [];
  const gitStatuses = input.gitStatuses || {};
  const nowMs = input.nowMs ?? Date.now();

  return {
    project,
    cwd: input.cwd,
    findings: [
      ...buildBlockedIssueFindings(project, issues),
      ...buildStaleInProgressFindings(project, issues, worktrees, nowMs),
      ...buildOrphanWorktreeFindings(project, issues, openPrs, worktrees, gitStatuses),
      ...buildQueueJamFindings(project, issues),
    ],
  };
}

export function formatDoctorReport(snapshot: DoctorSnapshot): string {
  if (!snapshot.project) {
    return [`pi-looper doctor: no active project`, `cwd: ${snapshot.cwd}`].join("\n");
  }

  const lines = [
    `pi-looper doctor: ${snapshot.project.id}`,
    `repo: ${snapshot.project.githubRepo || "unknown"}`,
    `cwd: ${snapshot.cwd}`,
    "",
  ];

  if (!snapshot.findings.length) {
    lines.push("Findings: 問題なし");
    return lines.join("\n");
  }

  lines.push(`Findings: ${snapshot.findings.length}`);
  for (const finding of snapshot.findings) {
    lines.push(`- [${finding.type}] ${finding.title}`, `  summary: ${finding.summary}`, "  commands:");
    for (const command of finding.commands) {
      lines.push(`  - ${command}`);
    }
  }
  return lines.join("\n");
}
