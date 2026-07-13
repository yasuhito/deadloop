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

export type ReviewerMonitorPromptInput = MonitorPromptBaseInput & {
  prNumber: number;
  reviewerTabId: string;
  worktreePath: string;
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

function shellQuoteForMonitor(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function projectCheckForMonitor(automationDir: string, worktreePath: string, checkCommand: string): string {
  const helper = `${automationDir.replace(/\/$/, "")}/run-project-check.ts`;
  return `node ${shellQuoteForMonitor(helper)} --cwd ${shellQuoteForMonitor(worktreePath)} --command ${shellQuoteForMonitor(checkCommand)}`;
}

function renderIssueMonitorPrompt(input: IssueMonitorPromptInput): string {
  const projectCheck = projectCheckForMonitor(input.automationDir, input.worktreePath, input.checkCommand);
  return `Deterministic driver launched Worker for Issue #${input.issueNumber}. Do not launch another agent and do not reselect another issue.

${renderPromisePollingRules(input)}

After a \`complete\` promise:
- Inspect \`${input.worktreePath}\` and confirm only Issue #${input.issueNumber} changes are present.
- Run validation through \`${projectCheck}\` before creating any PR.
- Push only the Worker branch \`${input.branch}\` without force-push, create a reviewable PR whose body includes \`Closes #${input.issueNumber}\`, and add \`${input.reviewLabel}\`.
- Do not manually close the issue with GitHub commands, and do not merge the PR.

After a \`blocked\` promise:
- Use the promise reason/summary to report the blocker.
- Move the issue from \`${input.inProgressLabel}\` to \`${input.blockedLabel}\` only when the blocker is actionable.

Report only the resulting action and evidence.`;
}

function renderReviewerMonitorPrompt(input: ReviewerMonitorPromptInput): string {
  const projectCheck = projectCheckForMonitor(input.automationDir, input.worktreePath, input.checkCommand);
  return `Deterministic driver launched reviewer for PR #${input.prNumber}. Do not launch another agent and do not reselect another PR.

${renderPromisePollingRules(input)}

After a \`complete\` promise:
- Re-check GitHub PR state, reviews, and checks before changing labels.
- Run local validation through \`${projectCheck}\` when needed for CI fallback; do not ignore failing checks by guesswork.
- If autoMerge=false, never merge; hand off by moving PR toward \`${input.humanLabel}\` with review evidence.
- If autoMerge=true, merge only after review, CI/fallback, and repository safety gates all pass.

After a \`blocked\` promise:
- Use the promise reason/summary to write the blocked report.
- Move the PR from \`${input.reviewingLabel}\` to \`${input.blockedLabel}\` only when the blocker is actionable.

Reviewer cleanup:
- First persist the review outcome in GitHub comments/labels and confirm the resulting PR state.
- Only after persistence succeeds, close the dedicated reviewer tab with \`herdr tab close ${input.reviewerTabId}\`.
- If outcome persistence fails, keep the tab open and report the failure; never discard the only review evidence.

Report only the resulting action and evidence.`;
}

module.exports = { renderIssueMonitorPrompt, renderPromisePollingRules, renderReviewerMonitorPrompt };
