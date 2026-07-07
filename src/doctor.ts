import path from "node:path";

import { evaluateWorkspaceTrust } from "./agent-trust.cjs";
import { type NormalizedAutomation, type NormalizedProject, automationStateKey, parseEveryMinutes } from "./core";
import { type GithubItem, type HerdrWorktree, labelsOf, resolveActiveProject } from "./status";

const STALE_IN_PROGRESS_MS = 24 * 60 * 60 * 1000;
const MAX_COMMENT_SUMMARY_LENGTH = 180;
const STALLED_SLOT_THRESHOLD = 3;
const SPINNING_STREAK_THRESHOLD = 3;
const UNAVAILABLE_PRECHECK_CODES = new Set([126, 127]);

type DoctorAutomationEntry = {
  lastResult?: string | null;
  lastAttemptAt?: number | null;
  failureStreak?: number | null;
};

type DoctorState = {
  automations?: Record<string, DoctorAutomationEntry> | null;
};

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

type ClaudeProjectTrust = { hasTrustDialogAccepted?: boolean } | null | undefined;

export type ClaudeConfigResult =
  | { ok: true; projects: Record<string, ClaudeProjectTrust> }
  | { ok: false };

export type HerdrAgent = {
  name?: string | null;
  agent?: string | null;
  agent_status?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
};

export type DoctorInput = {
  cwd: string;
  projects: NormalizedProject[];
  warnings?: string[];
  issues?: DoctorGithubItem[];
  openPrs?: DoctorGithubItem[];
  worktrees?: HerdrWorktree[];
  agents?: HerdrAgent[];
  gitStatuses?: Record<string, string>;
  state?: DoctorState | null;
  automationDir?: string;
  statePath?: string;
  claudeConfig?: ClaudeConfigResult;
  nowMs?: number;
};

export type DoctorFindingType =
  | "blocked_issue"
  | "stale_in_progress"
  | "orphan_worktree"
  | "queue_jam"
  | "stuck_claim"
  | "automation_unavailable"
  | "automation_spinning"
  | "coordinator_stalled"
  | "workspace_trust";

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
  warnings: string[];
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

function findWorktreeForBranch(branch: string, worktrees: HerdrWorktree[]): HerdrWorktree | null {
  if (!branch) return null;
  return worktrees.find((worktree) => String(worktree.branch || "") === branch) || null;
}

function agentCwdInside(agent: HerdrAgent, targetPath: string): boolean {
  if (!targetPath) return false;
  for (const candidate of [agent.cwd, agent.foreground_cwd]) {
    const value = String(candidate || "");
    if (value && isPathInside(value, targetPath)) return true;
  }
  return false;
}

function hasWorkingReviewer(
  agents: HerdrAgent[],
  reviewerName: string,
  worktree: HerdrWorktree | null,
): boolean {
  const worktreePathValue = worktree ? worktreePath(worktree) : "";
  return agents.some((agent) => {
    if (String(agent.agent_status || "") !== "working") return false;
    return String(agent.name || "") === reviewerName || agentCwdInside(agent, worktreePathValue);
  });
}

function hasWorkerAgent(agents: HerdrAgent[], workerName: string, worktree: HerdrWorktree | null): boolean {
  const worktreePathValue = worktree ? worktreePath(worktree) : "";
  return agents.some(
    (agent) => String(agent.name || "") === workerName || agentCwdInside(agent, worktreePathValue),
  );
}

function requeueImplementCommand(project: NormalizedProject, issueNumber: number | undefined): string {
  const repo = project.githubRepo || "<repo>";
  return `gh issue edit ${issueNumber ?? "<number>"} -R ${shellArg(repo)} --remove-label ${shellArg(project.labels.inProgress)} --add-label ${shellArg(project.labels.ready)} --add-label ${shellArg(project.labels.implement)}`;
}

function buildStuckReviewClaimFindings(
  project: NormalizedProject,
  openPrs: DoctorGithubItem[],
  worktrees: HerdrWorktree[],
  agents: HerdrAgent[],
): DoctorFinding[] {
  const repo = project.githubRepo || "<repo>";
  return openPrs
    .filter((pr) => labelsOf(pr).has(project.labels.reviewing))
    .filter((pr) => {
      const reviewerName = `${project.id}-pr-${pr.number ?? "?"}-reviewer`;
      const worktree = findWorktreeForBranch(String(pr.headRefName || ""), worktrees);
      return !hasWorkingReviewer(agents, reviewerName, worktree);
    })
    .map((pr) => ({
      id: `stuck-review-claim-${pr.number ?? "unknown"}`,
      type: "stuck_claim" as const,
      title: `stuck reviewing claim: ${issueRef(pr)}`,
      summary: `${project.labels.reviewing} が付いていますが、対応するレビューエージェントが Herdr で working ではありません。レビュー run が中断された残骸の疑いがあります。`,
      commands: [`gh pr edit ${pr.number ?? "<number>"} -R ${shellArg(repo)} --remove-label ${shellArg(project.labels.reviewing)}`],
    }));
}

function buildStuckImplementClaimFindings(
  project: NormalizedProject,
  issues: DoctorGithubItem[],
  worktrees: HerdrWorktree[],
  agents: HerdrAgent[],
): DoctorFinding[] {
  return issues
    .filter((issue) => labelsOf(issue).has(project.labels.inProgress))
    .filter((issue) => {
      const workerName = `${project.id}-issue-${issue.number ?? "?"}-worker`;
      const worktree = issue.number ? findWorktreeForIssue(issue.number, worktrees) : null;
      return !hasWorkerAgent(agents, workerName, worktree);
    })
    .map((issue) => {
      const worktree = issue.number ? findWorktreeForIssue(issue.number, worktrees) : null;
      const targetPath = worktree ? worktreePath(worktree) : "";
      const confirmCommand = targetPath
        ? `git -C ${shellArg(targetPath)} log ${shellArg(project.baseBranch || "origin/main")}..HEAD --oneline`
        : project.repoPath
          ? `herdr worktree list --cwd ${shellArg(project.repoPath)} --json`
          : "herdr worktree list --json";
      return {
        id: `stuck-implement-claim-${issue.number ?? "unknown"}`,
        type: "stuck_claim" as const,
        title: `stuck implement claim: ${issueRef(issue)}`,
        summary: `${project.labels.inProgress} が付いていますが、対応する Worker が Herdr に存在しません。実装 run が中断された残骸の疑いがあります。まず未回収コミットを確認してから再 queue してください。`,
        commands: [confirmCommand, requeueImplementCommand(project, issue.number)],
      };
    });
}

function automationRef(project: NormalizedProject, automation: NormalizedAutomation): string {
  const name = automation.name || automation.id;
  return `${project.id} ${name.replace(new RegExp(`^${project.id}[:\\s]+`), "")}`.trim();
}

function precheckSkippedCode(result: string): number | null {
  const match = /^precheck_skipped:(\d+)$/.exec(result);
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isFinite(code) ? code : null;
}

function isFailureResult(result: string): boolean {
  return result === "precheck_error" || result === "send_error" || result === "precheck_file_missing";
}

function precheckCheckCommand(automationDir: string, automation: NormalizedAutomation): string {
  const target = automation.precheckFile
    ? path.posix.join(automationDir, automation.precheckFile)
    : automationDir;
  return `ls ${shellArg(target)}`;
}

function buildAutomationFindings(
  project: NormalizedProject,
  state: DoctorState,
  automationDir: string,
  statePath: string,
  nowMs: number,
): DoctorFinding[] {
  const entries = state.automations || {};
  const findings: DoctorFinding[] = [];
  for (const automation of project.automations) {
    const entry = entries[automationStateKey(project, automation)];
    if (!entry) continue;

    const result = String(entry.lastResult || "");
    const ref = automationRef(project, automation);
    const intervalMinutes = parseEveryMinutes(automation.schedule);
    const slotMs = intervalMinutes ? intervalMinutes * 60_000 : null;

    const lastAttemptAt = Number(entry.lastAttemptAt);
    if (slotMs && Number.isFinite(lastAttemptAt) && nowMs - lastAttemptAt >= STALLED_SLOT_THRESHOLD * slotMs) {
      findings.push({
        id: `automation-stalled-${automation.id}`,
        type: "coordinator_stalled",
        title: `automation not attempted: ${ref}`,
        summary: `${STALLED_SLOT_THRESHOLD} スロット以上、試行が途絶えています。オーケストレータセッションが停止している疑いがあります。lastAttemptAt=${new Date(lastAttemptAt).toISOString()}`,
        commands: [`cat ${shellArg(statePath)}`],
      });
      continue;
    }

    const code = precheckSkippedCode(result);
    if ((code !== null && UNAVAILABLE_PRECHECK_CODES.has(code)) || result === "precheck_file_missing") {
      const reason = code !== null ? `code ${code} でスキップされ` : "設定された precheck ファイルが見つからず";
      findings.push({
        id: `automation-unavailable-${automation.id}`,
        type: "automation_unavailable",
        title: `precheck unavailable: ${ref}`,
        summary: `precheck が ${reason}、自動化が起動していません。precheck スクリプトの不在または実行不能が疑われます。`,
        commands: [precheckCheckCommand(automationDir, automation)],
      });
      continue;
    }

    const failureStreak = Number(entry.failureStreak) || 0;
    if (isFailureResult(result) && failureStreak >= SPINNING_STREAK_THRESHOLD) {
      findings.push({
        id: `automation-spinning-${automation.id}`,
        type: "automation_spinning",
        title: `automation spinning: ${ref}`,
        summary: `同じ失敗 ${result} が ${failureStreak} 回連続しています。ループが空回りしています。`,
        commands: [precheckCheckCommand(automationDir, automation)],
      });
    }
  }
  return findings;
}

function buildWorkspaceTrustFindings(
  project: NormalizedProject,
  claudeConfig: ClaudeConfigResult | undefined,
): DoctorFinding[] {
  if (project.workerAgent !== "claude" && project.reviewerAgent !== "claude") return [];
  const repoPath = project.repoPath;
  if (!repoPath) return [];

  const trust = evaluateWorkspaceTrust(claudeConfig, repoPath);
  if (trust === "trusted") return [];

  if (trust === "unknown") {
    return [
      {
        id: `workspace-trust-unknown-${repoPath}`,
        type: "workspace_trust",
        title: `workspace trust 状態を確認できません: ${repoPath}`,
        summary:
          "~/.claude.json を読めないため trust 状態を確認できません。claude エージェントは未 trust だと初回起動が trust ダイアログでブロックされます。",
        commands: [
          `jq --arg p ${shellArg(repoPath)} '.projects[$p].hasTrustDialogAccepted' ~/.claude.json`,
        ],
      },
    ];
  }

  return [
    {
      id: `workspace-trust-${repoPath}`,
      type: "workspace_trust",
      title: `workspace trust 未受け入れ: ${repoPath}`,
      summary:
        "claude エージェントは対話モードで起動するため、未 trust だと初回起動が trust ダイアログでブロックされます。一度手動で受け入れてください。",
      commands: [`cd ${shellArg(repoPath)} && claude`],
    },
  ];
}

export function buildDoctorSnapshot(input: DoctorInput): DoctorSnapshot {
  const project = resolveActiveProject(input.cwd, input.projects);
  const warnings = input.warnings || [];
  if (!project) return { project: null, cwd: input.cwd, warnings, findings: [] };

  const issues = input.issues || [];
  const openPrs = input.openPrs || [];
  const worktrees = input.worktrees || [];
  const agents = input.agents || [];
  const gitStatuses = input.gitStatuses || {};
  const state = input.state || {};
  const automationDir = input.automationDir || ".";
  const statePath = input.statePath || "state.json";
  const nowMs = input.nowMs ?? Date.now();

  return {
    project,
    cwd: input.cwd,
    warnings,
    findings: [
      ...buildBlockedIssueFindings(project, issues),
      ...buildStaleInProgressFindings(project, issues, worktrees, nowMs),
      ...buildOrphanWorktreeFindings(project, issues, openPrs, worktrees, gitStatuses),
      ...buildQueueJamFindings(project, issues),
      ...buildStuckReviewClaimFindings(project, openPrs, worktrees, agents),
      ...buildStuckImplementClaimFindings(project, issues, worktrees, agents),
      ...buildAutomationFindings(project, state, automationDir, statePath, nowMs),
      ...buildWorkspaceTrustFindings(project, input.claudeConfig),
    ],
  };
}

function formatConfigSource(project: NormalizedProject): string {
  const source = project.configSource;
  const local = source.localPath || "unknown local projects.json";
  const policy = `${source.repoPolicyBaseBranch}:${source.repoPolicyPath}`;
  const applied = source.repoPolicyAppliedKeys.length ? `; applied=${source.repoPolicyAppliedKeys.join(",")}` : "";
  const error = source.repoPolicyError ? `; error=${source.repoPolicyError}` : "";
  return `local=${local}; repoPolicy=${policy} (${source.repoPolicyStatus}${applied}${error})`;
}

export function formatDoctorReport(snapshot: DoctorSnapshot): string {
  if (!snapshot.project) {
    return [
      `pi-looper doctor: no active project`,
      `cwd: ${snapshot.cwd}`,
      ...snapshot.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n");
  }

  const lines = [
    `pi-looper doctor: ${snapshot.project.id}`,
    `repo: ${snapshot.project.githubRepo || "unknown"}`,
    `cwd: ${snapshot.cwd}`,
    ...snapshot.warnings.map((warning) => `warning: ${warning}`),
    `config: ${formatConfigSource(snapshot.project)}`,
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
