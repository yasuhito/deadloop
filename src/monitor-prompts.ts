type MonitorPromptBaseInput = {
  automationDir: string;
  promiseFile: string;
  actorName: string;
  projectId?: string;
  repoPath?: string;
  githubRepo?: string;
  stateDir?: string;
  enabledAt?: number;
};

export type IssueMonitorPromptInput = MonitorPromptBaseInput & {
  issueNumber: number;
  worktreePath: string;
  branch: string;
  checkCommand: string;
  readyLabel: string;
  implementLabel?: string;
  reviewLabel: string;
  inProgressLabel: string;
  blockedLabel: string;
  humanLabel?: string;
  needsInfoLabel?: string;
  wontfixLabel?: string;
};

export type BranchUpdateMonitorPromptInput = MonitorPromptBaseInput & {
  prNumber: number;
  expectedHeadOid: string;
  expectedBaseOid: string;
  branch: string;
  reviewLabel: string;
  reviewingLabel: string;
  blockedLabel: string;
};

export type ReviewerMonitorPromptInput = MonitorPromptBaseInput & {
  prNumber: number;
  expectedHeadOid: string;
  branch: string;
  checkCommand: string;
  projectCheckCommand?: string;
  workerAgent?: string;
  workerModel?: string;
  repairRemote?: string;
  humanLabel: string;
  reviewLabel: string;
  reviewingLabel: string;
  blockedLabel: string;
};

export type RepairMonitorPromptInput = MonitorPromptBaseInput & {
  prNumber: number;
  expectedHeadOid: string;
  branch: string;
  reviewLabel: string;
  reviewingLabel: string;
  blockedLabel: string;
};

function shellQuotePrompt(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function renderPromisePollingRules(input: MonitorPromptBaseInput): string {
  const guardedOperation = `node ${shellQuotePrompt(`${input.automationDir}/guarded-operation.ts`)} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))} --`;
  return `Monitor only this promise file. It is the only completion authority:
- ${input.promiseFile}

Polling rules:
- Use \`node ${input.automationDir}/extract-worker-promise.ts --file ${input.promiseFile}\`.
- If the promise status is \`complete\` or \`blocked\`, break polling immediately. Do not use Herdr status as completion authority.
- If the promise is missing while the agent is idle/done, ask the ${input.actorName} to write the promise file instead of guessing completion.

Enablement guard:
- Run only approved non-merge GitHub mutations through this prefix: \`${guardedOperation}\`. Approved forms are \`gh issue edit\` for labels, \`gh issue comment\`, \`gh pr create\`, \`gh pr edit\` for labels, and \`gh pr comment\`; every command must explicitly use \`-R ${input.githubRepo || "<githubRepo>"}\`.
- Never run those mutations directly. Each guarded operation is synchronized with \`/deadloop-disable\`; if it reports that deadloop is disabled, stop without that mutation. Re-evaluate only on a later scheduler cycle after re-enable.
- Never pass merge, push, branch deletion, \`gh api\`, or arbitrary commands through \`guarded-operation.ts\`. Automatic merge must use \`merge-reviewed-pr.ts\`, and issue-worker pushes use the destination-bound command below.`;
}

function renderIssueMonitorPrompt(input: IssueMonitorPromptInput): string {
  const guardedPush = `node ${shellQuotePrompt(`${input.automationDir}/guarded-push.ts`)} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --worktree ${shellQuotePrompt(input.worktreePath)} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))} --remote origin --branch ${shellQuotePrompt(input.branch)}`;
  return `Deterministic driver launched Worker for Issue #${input.issueNumber}. Do not launch another agent and do not reselect another issue.

${renderPromisePollingRules(input)}

After a \`complete\` promise:
- Inspect \`${input.worktreePath}\` and confirm only Issue #${input.issueNumber} changes are present.
- Run validation including \`${input.checkCommand}\` before creating any PR.
- Push only the Worker branch \`${input.branch}\` without force-push by running exactly \`${guardedPush}\`. This resolves and verifies the repository, then pushes to that explicit destination rather than mutable remote configuration; create a reviewable PR whose body includes \`Closes #${input.issueNumber}\`, and add \`${input.reviewLabel}\`.
- Do not manually close the issue with GitHub commands, and do not merge the PR.

After a \`blocked\` promise:
- Use the promise reason/summary to report the blocker.
- Move the issue from \`${input.inProgressLabel}\` to \`${input.blockedLabel}\` only when the blocker is actionable.

Report only the resulting action and evidence.`;
}

function renderBranchUpdateMonitorPrompt(input: BranchUpdateMonitorPromptInput): string {
  return `Deterministic driver launched one branch-update worker for PR #${input.prNumber}. Monitor only this attempt; never launch or select an agent, push a branch, review the PR, or merge it.

Attempt binding:
- Existing PR branch: ${input.branch}
- Expected PR head: ${input.expectedHeadOid}
- Selected base head: ${input.expectedBaseOid}
- Keep ${input.reviewLabel} and ${input.reviewingLabel} while the update is running.

${renderPromisePollingRules(input)}

Terminal handling:
- status=complete, reason=branch_updated: re-read the PR and confirm its head changed. Do not change labels; normal PR review resumes on the next automation cycle.
- status=complete, reason=stale_head: stop without any push, comment, or label change. Keep both review labels so the next cycle re-evaluates the new head.
- status=blocked: write a concise failure comment, remove ${input.reviewingLabel}, and add ${input.blockedLabel}. This is the only terminal path that may add the blocked label; keep ${input.reviewLabel}.
- Any malformed completion or unsafe/inconclusive update result is a failed update: report it and add ${input.blockedLabel}; never guess success.

Prohibited in every path: force-push, any monitor-side push, label changes on success/stale, PR creation, PR merge, issue close, branch deletion, or retrying this exact head/base pair.

Report only the terminal action and evidence.`;
}

function renderReviewerDispatcherCommand(input: ReviewerMonitorPromptInput): string {
  const environment = [
    ["DEADLOOP_GITHUB_REPO", input.githubRepo || "<githubRepo>"],
    ["DEADLOOP_ENABLED_AT", String(input.enabledAt ?? "<enabledAt>")],
    ["DEADLOOP_PROJECT_ID", input.projectId || "<projectId>"],
    ["DEADLOOP_REPO_PATH", input.repoPath || "<projectRepo>"],
    ["DEADLOOP_STATE_DIR", input.stateDir || "<stateDir>"],
    ["DEADLOOP_CHECK_COMMAND", input.projectCheckCommand || input.checkCommand],
    ["DEADLOOP_WORKER_AGENT", input.workerAgent || "pi"],
    ["DEADLOOP_WORKER_MODEL", input.workerModel || ""],
    ["DEADLOOP_REVIEW_REPAIR_REMOTE", input.repairRemote || "origin"],
    ["DEADLOOP_REVIEW_LABEL", input.reviewLabel],
    ["DEADLOOP_REVIEWING_LABEL", input.reviewingLabel],
    ["DEADLOOP_BLOCKED_LABEL", input.blockedLabel],
  ].map(([name, value]) => `${name}=${shellQuotePrompt(value)}`).join(" ");
  return `${environment} node ${shellQuotePrompt(`${input.automationDir}/pr-review-repair-dispatch.ts`)} --promise ${shellQuotePrompt(input.promiseFile)} --pr ${input.prNumber} --expected-head ${shellQuotePrompt(input.expectedHeadOid)} --branch ${shellQuotePrompt(input.branch)}`;
}

function renderReviewerMonitorPrompt(input: ReviewerMonitorPromptInput): string {
  const guardedMerge = `node ${shellQuotePrompt(`${input.automationDir}/merge-reviewed-pr.ts`)} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))} --pr ${input.prNumber} --expected-head ${shellQuotePrompt(input.expectedHeadOid)} --review-promise ${shellQuotePrompt(input.promiseFile)} --review-label ${shellQuotePrompt(input.reviewLabel)} --reviewing-label ${shellQuotePrompt(input.reviewingLabel)} --blocked-label ${shellQuotePrompt(input.blockedLabel)}`;
  return `Deterministic driver launched reviewer for PR #${input.prNumber}. Do not launch another agent and do not reselect another PR.

Review binding:
- Expected PR head: ${input.expectedHeadOid}
- Existing PR branch: ${input.branch}

${renderPromisePollingRules(input)}

Completion handling:
- Read the validated promise payload. Only an explicit head-bound \`outcome=approved\` result may enter the automatic merge path; legacy complete promises may be handed to a human but cannot authorize a merge.
- A successful review with actionable defects is status=complete, outcome=changes_requested, never status=blocked.
- For outcome=changes_requested, outcome=human_required, or status=blocked, run the deterministic dispatcher and follow only its returned action/prompt:
  \`${renderReviewerDispatcherCommand(input)}\`
- The dispatcher keeps ${input.reviewLabel} and ${input.reviewingLabel} during repair. It adds ${input.blockedLabel} only for human-required or bounded failure paths.
- For outcome=approved or a legacy complete promise, re-check GitHub PR state, reviews, and checks before changing labels.
- Run local validation including \`${input.checkCommand}\` when needed for CI fallback; do not ignore failing checks by guesswork. A local fallback may support human handoff, but it does not authorize automatic merge while GitHub reports missing, pending, failed, or ambiguous checks.
- If autoMerge=false, never merge; hand off by moving PR toward \`${input.humanLabel}\` with review evidence.
- If autoMerge=true, merge only after the head-bound review approval, reported GitHub CI checks, and repository mergeability gates all pass. Perform the merge only by running exactly \`${guardedMerge}\`; never run \`gh pr merge\` directly. This binds GitHub's mutation to the reviewed head while holding the enablement guard.

Report only the resulting action and evidence.`;
}

function renderRepairMonitorPrompt(input: RepairMonitorPromptInput): string {
  return `Deterministic dispatcher launched one review-repair worker for PR #${input.prNumber}. Monitor only this attempt; never launch another agent or widen the findings contract.

Attempt binding:
- Existing PR branch: ${input.branch}
- Expected PR head: ${input.expectedHeadOid}
- Keep ${input.reviewLabel} and ${input.reviewingLabel} while repair is running.

${renderPromisePollingRules(input)}

Terminal handling:
- status=complete, reason=repair_pushed: re-read the PR and confirm its head changed. Do not change labels; the changed head starts a new review cycle.
- status=complete, reason=stale_head: stop without push, comment, or label changes. Keep both review labels for next-cycle re-evaluation.
- status=blocked: the exact head/review result used its bounded attempt. Write recovery guidance, remove ${input.reviewingLabel}, and add ${input.blockedLabel}.
- Malformed or inconclusive completion is unsafe and follows the same bounded human-blocked path.

Prohibited in every path: force-push, monitor-side push, label changes on success/stale, PR creation, merge, issue close, branch deletion, or a second attempt for this exact review result.

Report only the terminal action and evidence.`;
}

type PendingMonitorHandoff =
  | { kind: "issue"; input: IssueMonitorPromptInput }
  | { kind: "reviewer"; input: ReviewerMonitorPromptInput }
  | { kind: "branch-update"; input: BranchUpdateMonitorPromptInput }
  | { kind: "repair"; input: RepairMonitorPromptInput };

function renderPendingMonitorHandoff(handoff: PendingMonitorHandoff, enabledAt?: number): string {
  if (!handoff.input || typeof handoff.input !== "object") throw new Error("unsupported pending monitor handoff");
  if (handoff.kind === "issue") {
    return renderIssueMonitorPrompt({ ...handoff.input, enabledAt: enabledAt ?? handoff.input.enabledAt });
  }
  if (handoff.kind === "reviewer") {
    return renderReviewerMonitorPrompt({ ...handoff.input, enabledAt: enabledAt ?? handoff.input.enabledAt });
  }
  if (handoff.kind === "branch-update") {
    return renderBranchUpdateMonitorPrompt({ ...handoff.input, enabledAt: enabledAt ?? handoff.input.enabledAt });
  }
  if (handoff.kind === "repair") {
    return renderRepairMonitorPrompt({ ...handoff.input, enabledAt: enabledAt ?? handoff.input.enabledAt });
  }
  throw new Error("unsupported pending monitor handoff");
}

module.exports = {
  renderBranchUpdateMonitorPrompt,
  renderIssueMonitorPrompt,
  renderPendingMonitorHandoff,
  renderPromisePollingRules,
  renderRepairMonitorPrompt,
  renderReviewerMonitorPrompt,
};
