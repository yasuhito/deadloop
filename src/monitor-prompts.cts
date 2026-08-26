type MonitorPromptBaseInput = {
  automationDir: string;
  promiseFile: string;
  attemptRecordFile?: string;
  actorName: string;
  projectId?: string;
  repoPath?: string;
  worktreeRoot?: string;
  githubRepo?: string;
  stateDir?: string;
  enabledAt?: number;
};

type ExplorerMonitorPromptInput = MonitorPromptBaseInput & {
  issueNumber: number;
};
type IssueMonitorPromptInput = MonitorPromptBaseInput & {
  issueNumber: number;
  issueTitle?: string;
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

type BranchUpdateMonitorPromptInput = MonitorPromptBaseInput & {
  prNumber: number;
  expectedHeadOid: string;
  expectedBaseOid: string;
  branch: string;
  reviewLabel: string;
  implementLabel?: string;
  updateBranchLabel?: string;
  inProgressLabel: string;
  blockedLabel: string;
};

type ReviewerMonitorPromptInput = MonitorPromptBaseInput & {
  worktreeRoot: string;
  worktreePath?: string;
  autoMerge?: boolean;
  prNumber: number;
  expectedHeadOid: string;
  requestEventId?: string;
  branch: string;
  checkCommand: string;
  projectCheckCommand?: string;
  workerAgent?: string;
  workerModel?: string;
  repairRemote?: string;
  remote?: string;
  reviewLabel: string;
  implementLabel: string;
  updateBranchLabel: string;
  inProgressLabel: string;
  blockedLabel: string;
};

function shellQuotePrompt(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function renderPromisePollingRules(
  input: MonitorPromptBaseInput,
  targetKind: "issue" | "pull-request",
  mutationAuthority = true,
): string {
  const prInput = input as Partial<ReviewerMonitorPromptInput & BranchUpdateMonitorPromptInput>;
  const attempt = targetKind === "pull-request"
    ? ` --attempt-record ${shellQuotePrompt(input.attemptRecordFile || `${input.promiseFile.replace(/\/[^/]+$/, "")}/attempt.json`)} --in-progress-label ${shellQuotePrompt(prInput.inProgressLabel || "agent:in-progress")} --blocked-label ${shellQuotePrompt(prInput.blockedLabel || "agent:blocked")}`
    : "";
  const guardedOperation = `node ${shellQuotePrompt(`${input.automationDir}/guarded-operation.cts`)} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))} --target-kind ${targetKind}${attempt} --`;
  const mutationRules = mutationAuthority
    ? `- Run only approved non-merge GitHub mutations through this prefix: \`${guardedOperation}\`. Approved forms are \`gh issue edit\` for labels, \`gh issue comment\`, \`gh pr edit\` for label removal, and \`gh pr comment\`; every command must explicitly use \`-R ${input.githubRepo || "<githubRepo>"}\`.
- Never run those mutations directly. Each guarded operation is synchronized with \`/deadloop-disable\`; if it reports that deadloop is disabled, stop without that mutation. Re-evaluate only on a later scheduler cycle after re-enable.
- Never pass merge, push, branch deletion, \`gh api\`, or arbitrary commands through \`guarded-operation.cts\`. Automatic merge must use \`merge-reviewed-pr.cts\`, and issue-worker pushes use the destination-bound command below.`
    : "- This attempt has no mutation authority. Do not comment on the PR or change its labels from the monitor; retain the workspace and report the terminal evidence for a later workflow.";
  return `Monitor only this promise file. It is the only completion authority:
- ${input.promiseFile}

Polling rules:
- Use \`node ${input.automationDir}/extract-worker-promise.cts --file ${input.promiseFile}\`.
- If the promise status is \`complete\` or \`blocked\`, break polling immediately. Do not use Herdr status as completion authority.
- If the promise is missing while the agent is idle/done, ask the ${input.actorName} to write the promise file instead of guessing completion.

Enablement guard:
${mutationRules}`;
}

function renderAttemptPersistence(input: MonitorPromptBaseInput): string {
  const reviewLabel = (input as Partial<IssueMonitorPromptInput & BranchUpdateMonitorPromptInput>).reviewLabel;
  if (!reviewLabel) throw new Error("attempt persistence rendering requires the configured review label");
  return `node ${shellQuotePrompt(`${input.automationDir}/persist-attempt-result.cts`)} --attempt-record ${shellQuotePrompt(input.attemptRecordFile || `${input.promiseFile.replace(/\/[^/]+$/, "")}/attempt.json`)} --project-id ${shellQuotePrompt(input.projectId || "<projectId>")} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))} --review-label ${shellQuotePrompt(reviewLabel)}`;
}

function renderWorkspaceCompletion(input: MonitorPromptBaseInput, expectedLabels: string[] = []): string {
  const labels = expectedLabels.flatMap((label) => ["--expected-label", shellQuotePrompt(label)]).join(" ");
  const reviewer = input as Partial<ReviewerMonitorPromptInput>;
  const managedLabels = [
    reviewer.reviewLabel, reviewer.implementLabel, reviewer.updateBranchLabel,
    reviewer.inProgressLabel, reviewer.blockedLabel,
  ].filter((label): label is string => Boolean(label));
  const managed = managedLabels.flatMap((label) => ["--managed-label", shellQuotePrompt(label)]).join(" ");
  const worker = input as Partial<IssueMonitorPromptInput>;
  const workerLabels = worker.readyLabel && worker.implementLabel && worker.reviewLabel
    ? [
        "--worker-ready-label", shellQuotePrompt(worker.readyLabel),
        "--worker-implement-label", shellQuotePrompt(worker.implementLabel),
        "--worker-review-label", shellQuotePrompt(worker.reviewLabel),
      ].join(" ")
    : "";
  const policy = "autoMerge" in input ? `--auto-merge ${input.autoMerge ? "true" : "false"}` : "";
  const extras = [workerLabels, policy, labels, managed].filter(Boolean).join(" ");
  return `node ${shellQuotePrompt(`${input.automationDir}/complete-attempt-workspace.cts`)} --attempt-record ${shellQuotePrompt(input.attemptRecordFile || `${input.promiseFile.replace(/\/[^/]+$/, "")}/attempt.json`)} --project-id ${shellQuotePrompt(input.projectId || "<projectId>")} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))}${extras ? ` ${extras}` : ""}`;
}

function renderIssueMonitorPrompt(input: IssueMonitorPromptInput): string {
  const attemptRecord = input.attemptRecordFile || `${input.promiseFile.replace(/\/[^/]+$/, "")}/attempt.json`;
  const verify = `node ${shellQuotePrompt(`${input.automationDir}/run-worker-required-verification.cts`)} --attempt-record ${shellQuotePrompt(attemptRecord)} --project-id ${shellQuotePrompt(input.projectId || "<projectId>")} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))} --worktree ${shellQuotePrompt(input.worktreePath)} --quarantine-root ${shellQuotePrompt(`${input.stateDir || "<stateDir>"}/check-quarantine`)}`;
  const guardedPush = `node ${shellQuotePrompt(`${input.automationDir}/guarded-push.cts`)} --project-id ${shellQuotePrompt(input.projectId || "<projectId>")} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --worktree ${shellQuotePrompt(input.worktreePath)} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))} --remote origin --branch ${shellQuotePrompt(input.branch)} --attempt-record ${shellQuotePrompt(attemptRecord)}`;
  const createPr = `node ${shellQuotePrompt(`${input.automationDir}/guarded-worker-pr.cts`)} --attempt-record ${shellQuotePrompt(attemptRecord)} --project-id ${shellQuotePrompt(input.projectId || "<projectId>")} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))} --title ${shellQuotePrompt(input.issueTitle || `Issue #${input.issueNumber}`)} --review-label ${shellQuotePrompt(input.reviewLabel)}`;
  return `Deterministic driver launched Worker for Issue #${input.issueNumber}. Do not launch another agent and do not reselect another issue.

${renderPromisePollingRules(input, "issue")}

After a \`complete\` promise:
- Inspect \`${input.worktreePath}\` and confirm only Issue #${input.issueNumber} changes are present.
- Run the fixed required-verification contract through run-project-check.ts isolation before creating any PR, and persist its output-commit-bound record by running exactly \`${verify}\`. Agent-reported additional validations never replace this record. If it reports \`status=blocked\`, it has deterministically removed the in-progress claim, added the blocked label, and posted idempotent recovery guidance; stop without another comment or label mutation. A new attempt must adopt the restored policy.
- Only after that command reports \`status=passed\`, push only the Worker branch \`${input.branch}\` without force-push by running exactly \`${guardedPush}\`. The guarded push independently requires the same passed record and current policy.
- Only after that push succeeds, create a reviewable PR whose body includes \`Closes #${input.issueNumber}\`, or recover that exact PR, and add \`${input.reviewLabel}\` by running exactly \`${createPr}\`. This dedicated command independently requires the verified output commit; do not run \`gh pr create\` or success label mutations directly.
- Do not manually close the issue with GitHub commands, and do not merge the PR.
- After the PR, closing reference, exact pushed head, labels, and Issue state are persisted, run \`${renderAttemptPersistence(input)}\` to bind that existing result. Only after it reports result_persisted, run the deterministic workspace completion command exactly once: \`${renderWorkspaceCompletion(input)}\`. A pending cleanup result must not replay the push, PR creation, comment, or labels.

After a \`blocked\` promise:
- Use the promise reason/summary to report the blocker.
- Move the issue from \`${input.inProgressLabel}\` to \`${input.blockedLabel}\` only when the blocker is actionable.

Report only the resulting action and evidence.`;
}

function renderExplorerMonitorPrompt(input: ExplorerMonitorPromptInput): string {
  return `A read-only explorer is running for Issue #${input.issueNumber}.
Monitor only the promise file at ${input.promiseFile}. Do not launch another agent.
Do not mutate the repository or GitHub. The deterministic completion path will validate and persist the result.`;
}

type PendingMonitorHandoff =
  | { kind: "issue"; input: IssueMonitorPromptInput }
  | { kind: "explorer"; input: ExplorerMonitorPromptInput };

function renderPendingMonitorHandoff(handoff: PendingMonitorHandoff, enabledAt?: number): string {
  if (!handoff.input || typeof handoff.input !== "object") throw new Error("unsupported pending monitor handoff");
  if (handoff.kind === "issue") {
    return renderIssueMonitorPrompt({ ...handoff.input, enabledAt: enabledAt ?? handoff.input.enabledAt });
  }
  if (handoff.kind === "explorer") {
    return renderExplorerMonitorPrompt({ ...handoff.input, enabledAt: enabledAt ?? handoff.input.enabledAt });
  }
  throw new Error("unsupported pending monitor handoff");
}

module.exports = {
  renderExplorerMonitorPrompt,
  renderIssueMonitorPrompt,
  renderPendingMonitorHandoff,
  renderPromisePollingRules,
};
