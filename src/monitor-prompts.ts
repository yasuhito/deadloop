type MonitorPromptBaseInput = {
  automationDir: string;
  promiseFile: string;
  actorName: string;
};

export type IssueMonitorPromptInput = MonitorPromptBaseInput & {
  issueNumber: number;
  worktreePath: string;
  branch: string;
  checkCommand: string;
  reviewLabel: string;
  inProgressLabel: string;
  blockedLabel: string;
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
  checkCommand: string;
  humanLabel: string;
  reviewingLabel: string;
  blockedLabel: string;
};

function renderPromisePollingRules(input: MonitorPromptBaseInput): string {
  return `Monitor only this promise file. It is the only completion authority:
- ${input.promiseFile}

Polling rules:
- Use \`node ${input.automationDir}/extract-worker-promise.ts --file ${input.promiseFile}\`.
- If the promise status is \`complete\` or \`blocked\`, break polling immediately. Do not use Herdr status as completion authority.
- If the promise is missing while the agent is idle/done, ask the ${input.actorName} to write the promise file instead of guessing completion.`;
}

function renderIssueMonitorPrompt(input: IssueMonitorPromptInput): string {
  return `Deterministic driver launched Worker for Issue #${input.issueNumber}. Do not launch another agent and do not reselect another issue.

${renderPromisePollingRules(input)}

After a \`complete\` promise:
- Inspect \`${input.worktreePath}\` and confirm only Issue #${input.issueNumber} changes are present.
- Run validation including \`${input.checkCommand}\` before creating any PR.
- Push only the Worker branch \`${input.branch}\` without force-push, create a reviewable PR whose body includes \`Closes #${input.issueNumber}\`, and add \`${input.reviewLabel}\`.
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

function renderReviewerMonitorPrompt(input: ReviewerMonitorPromptInput): string {
  return `Deterministic driver launched reviewer for PR #${input.prNumber}. Do not launch another agent and do not reselect another PR.

${renderPromisePollingRules(input)}

After a \`complete\` promise:
- Re-check GitHub PR state, reviews, and checks before changing labels.
- Run local validation including \`${input.checkCommand}\` when needed for CI fallback; do not ignore failing checks by guesswork.
- If autoMerge=false, never merge; hand off by moving PR toward \`${input.humanLabel}\` with review evidence.
- If autoMerge=true, merge only after review, CI/fallback, and repository safety gates all pass.

After a \`blocked\` promise:
- Use the promise reason/summary to write the blocked report.
- Move the PR from \`${input.reviewingLabel}\` to \`${input.blockedLabel}\` only when the blocker is actionable.

Report only the resulting action and evidence.`;
}

module.exports = { renderBranchUpdateMonitorPrompt, renderIssueMonitorPrompt, renderPromisePollingRules, renderReviewerMonitorPrompt };
