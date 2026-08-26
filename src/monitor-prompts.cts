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

type RepairMonitorPromptInput = MonitorPromptBaseInput & {
  prNumber: number;
  expectedHeadOid: string;
  branch: string;
  attemptKey?: string;
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
  const prInput = input as Partial<ReviewerMonitorPromptInput & RepairMonitorPromptInput & BranchUpdateMonitorPromptInput>;
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

function renderBranchUpdateCompletionCommand(input: BranchUpdateMonitorPromptInput): string {
  const attemptRecord = input.attemptRecordFile || `${input.promiseFile.replace(/\/[^/]+$/, "")}/attempt.json`;
  return `node ${shellQuotePrompt(`${input.automationDir}/pr-branch-update-complete.cts`)} --promise ${shellQuotePrompt(input.promiseFile)} --attempt-record ${shellQuotePrompt(attemptRecord)} --project-id ${shellQuotePrompt(input.projectId || "<projectId>")} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))} --pr ${input.prNumber} --expected-head ${shellQuotePrompt(input.expectedHeadOid)} --review-label ${shellQuotePrompt(input.reviewLabel)} --implement-label ${shellQuotePrompt(input.implementLabel)} --update-branch-label ${shellQuotePrompt(input.updateBranchLabel)} --in-progress-label ${shellQuotePrompt(input.inProgressLabel)} --blocked-label ${shellQuotePrompt(input.blockedLabel)}`;
}

function renderBranchUpdateMonitorPrompt(input: BranchUpdateMonitorPromptInput): string {
  return `Deterministic driver launched one branch-update worker for PR #${input.prNumber}. Monitor only this attempt; never launch or select an agent, push a branch, review the PR, or merge it.

Attempt binding:
- Existing PR branch: ${input.branch}
- Expected PR head: ${input.expectedHeadOid}
- Selected base head: ${input.expectedBaseOid}
- The branch-update request is already consumed; ${input.inProgressLabel} is the active workflow state while the update runs.

${renderPromisePollingRules(input, "pull-request", false)}

Terminal handling:
- status=complete, reason=branch_update_pushed: run this deterministic completion handler exactly once and follow its result:
  \`${renderBranchUpdateCompletionCommand(input)}\`
  It re-observes the pushed head and replaces ${input.inProgressLabel} with a new ${input.reviewLabel} request. Only after it reports branch_update_review_requested, run \`${renderAttemptPersistence(input)}\` and then \`${renderWorkspaceCompletion(input)}\` after result_persisted.
- status=complete, reason=stale_head: run \`${renderWorkspaceCompletion(input)}\`; it closes only after confirming the PR head changed and makes no comment or label change. Keep the active workflow state so the next cycle re-evaluates the new head.
- status=blocked: retain the workspace and report a concise failure with the evidence needed for a later deterministic recovery workflow. Do not comment or change labels.
- Any malformed completion or unsafe/inconclusive update result is a failed update: retain the workspace and report it; never guess success or mutate GitHub state.

Prohibited in every path: force-push, any monitor-side push, label changes on success/stale, PR creation, PR merge, issue close, branch deletion, or retrying this exact head/base pair.

Report only the terminal action and evidence.`;

}
function renderExplorerMonitorPrompt(input: ExplorerMonitorPromptInput): string {
  return `A read-only explorer is running for Issue #${input.issueNumber}.
Monitor only the promise file at ${input.promiseFile}. Do not launch another agent.
Do not mutate the repository or GitHub. The deterministic completion path will validate and persist the result.`;
}

function renderReviewerDispatcherCommand(input: ReviewerMonitorPromptInput): string {
  const environment = [
    ["DEADLOOP_GITHUB_REPO", input.githubRepo || "<githubRepo>"],
    ["DEADLOOP_ENABLED_AT", String(input.enabledAt ?? "<enabledAt>")],
    ["DEADLOOP_PROJECT_ID", input.projectId || "<projectId>"],
    ["DEADLOOP_REPO_PATH", input.repoPath || "<projectRepo>"],
    ["DEADLOOP_WORKTREE_ROOT", input.worktreeRoot || "<worktreeRoot>"],
    ["DEADLOOP_STATE_DIR", input.stateDir || "<stateDir>"],
    ["DEADLOOP_CHECK_COMMAND", input.projectCheckCommand || input.checkCommand],
    ["DEADLOOP_WORKER_AGENT", input.workerAgent || "pi"],
    ["DEADLOOP_WORKER_MODEL", input.workerModel || ""],
    ["DEADLOOP_REVIEW_REPAIR_REMOTE", input.remote || input.repairRemote || "origin"],
    ["DEADLOOP_REVIEW_LABEL", input.reviewLabel],
    ["DEADLOOP_BLOCKED_LABEL", input.blockedLabel],
    ["DEADLOOP_IMPLEMENT_LABEL", input.implementLabel],
    ["DEADLOOP_UPDATE_BRANCH_LABEL", input.updateBranchLabel],
    ["DEADLOOP_IN_PROGRESS_LABEL", input.inProgressLabel || "agent:in-progress"],
  ].map(([name, value]) => `${name}=${shellQuotePrompt(value)}`).join(" ");
  const argumentsWithConfig = [
    "--promise", shellQuotePrompt(input.promiseFile),
    "--attempt-record", shellQuotePrompt(input.attemptRecordFile || `${input.promiseFile.replace(/\/[^/]+$/, "")}/attempt.json`),
    "--request-event-id", shellQuotePrompt(input.requestEventId || "<requestEventId>"),
    "--pr", String(input.prNumber),
    "--expected-head", shellQuotePrompt(input.expectedHeadOid),
    "--branch", shellQuotePrompt(input.branch),
    "--github-repo", shellQuotePrompt(input.githubRepo || "<githubRepo>"),
    "--repo-path", shellQuotePrompt(input.repoPath || "<projectRepo>"),
    "--worktree-root", shellQuotePrompt(input.worktreeRoot || "<worktreeRoot>"),
    "--project-id", shellQuotePrompt(input.projectId || "<projectId>"),
    "--state-dir", shellQuotePrompt(input.stateDir || "<stateDir>"),
    "--check-command", shellQuotePrompt(input.projectCheckCommand || input.checkCommand),
    "--worker-agent", shellQuotePrompt(input.workerAgent || "pi"),
    ...(input.workerModel ? ["--worker-model", shellQuotePrompt(input.workerModel)] : []),
    "--remote", shellQuotePrompt(input.remote || input.repairRemote || "origin"),
    "--review-label", shellQuotePrompt(input.reviewLabel),
    "--blocked-label", shellQuotePrompt(input.blockedLabel),
    "--implement-label", shellQuotePrompt(input.implementLabel),
    "--update-branch-label", shellQuotePrompt(input.updateBranchLabel),
    "--in-progress-label", shellQuotePrompt(input.inProgressLabel || "agent:in-progress"),
  ].join(" ");
  return `${environment} node ${shellQuotePrompt(`${input.automationDir}/pr-review-repair-dispatch.cts`)} ${argumentsWithConfig}`;
}

function renderReviewerMonitorPrompt(input: ReviewerMonitorPromptInput): string {
  const attemptRecord = input.attemptRecordFile || `${input.promiseFile.replace(/\/[^/]+$/, "")}/attempt.json`;
  const verifyApproval = `node ${shellQuotePrompt(`${input.automationDir}/run-worker-required-verification.cts`)} --attempt-record ${shellQuotePrompt(attemptRecord)} --project-id ${shellQuotePrompt(input.projectId || "<projectId>")} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))} --worktree ${shellQuotePrompt(input.worktreePath || "<worktreePath>")} --quarantine-root ${shellQuotePrompt(`${input.stateDir || "<stateDir>"}/check-quarantine`)} --role reviewer`;
  // With automatic merge off the approved pull request keeps no agent workflow label at all.
  const approvedLabels = input.autoMerge ? [input.inProgressLabel || "agent:in-progress"] : [];
  const acceptedHistory = `${input.promiseFile.replace(/\/[^/]+$/, "")}/pr-review-history-accepted.json`;
  const guardedMerge = `node ${shellQuotePrompt(`${input.automationDir}/merge-reviewed-pr.cts`)} --attempt-record ${shellQuotePrompt(input.attemptRecordFile || `${input.promiseFile.replace(/\/[^/]+$/, "")}/attempt.json`)} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))} --pr ${input.prNumber} --expected-head ${shellQuotePrompt(input.expectedHeadOid)} --review-promise ${shellQuotePrompt(input.promiseFile)} --history-observation ${shellQuotePrompt(acceptedHistory)} --in-progress-label ${shellQuotePrompt(input.inProgressLabel || "agent:in-progress")} --blocked-label ${shellQuotePrompt(input.blockedLabel)}`;
  const guardedReadyHandoff = `node ${shellQuotePrompt(`${input.automationDir}/handoff-reviewed-pr.cts`)} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))} --pr ${input.prNumber} --expected-head ${shellQuotePrompt(input.expectedHeadOid)} --review-promise ${shellQuotePrompt(input.promiseFile)} --history-observation ${shellQuotePrompt(acceptedHistory)} --review-label ${shellQuotePrompt(input.reviewLabel)} --implement-label ${shellQuotePrompt(input.implementLabel)} --update-branch-label ${shellQuotePrompt(input.updateBranchLabel)} --in-progress-label ${shellQuotePrompt(input.inProgressLabel || "agent:in-progress")} --blocked-label ${shellQuotePrompt(input.blockedLabel)}`;
  return `Deterministic driver launched reviewer for PR #${input.prNumber}. Do not launch another agent and do not reselect another PR.

Review binding:
- Expected PR head: ${input.expectedHeadOid}
- Existing PR branch: ${input.branch}

${renderPromisePollingRules(input, "pull-request")}

Completion handling:
- Read the validated promise payload. Only an explicit head-bound V1 \`outcome=approved\` result may enter approved handoff or automatic merge processing; only strongly-bound V1 reports can authorize a ready handoff or merge.
- Legacy complete promises are inspection-only evidence: do not dispatch, comment, change labels, or report successful handoff for them.
- A successful review with actionable defects is status=complete, outcome=changes_requested, never status=blocked.
- For outcome=approved, first run the fixed, attempt-bound required verification exactly once: \`${verifyApproval}\`. A missing, failed, stale-head, or stale-policy record must not enter approved handoff or merge processing. Agent-reported \`evidence.validations\` remains display-only additional evidence.
- For every validated V1 completion, run the deterministic dispatcher so it can record the public review result exactly once:
  \`${renderReviewerDispatcherCommand(input)}\`
- Follow the dispatcher's returned repair or human-block action. When it returns driverAction=review_approved, continue the approved path below; do not stop merely because comment recording is done.
- The dispatcher keeps ${input.inProgressLabel} as the active repair state. A human-required result is a completed review: the dispatcher records it, marks a draft ready, and removes every agent workflow label, so no request is left waiting. It adds ${input.blockedLabel} only for bounded failure paths, where deadloop could not finish safely.
- For outcome=approved, re-check GitHub PR state, reviews, and checks before changing labels.
- Run local validation including \`${input.checkCommand}\` when needed for CI fallback; do not ignore failing checks by guesswork. A local fallback may support human handoff, but it does not authorize automatic merge while GitHub reports missing, pending, failed, or ambiguous checks.
- The deterministic policy for this monitor is \`autoMerge=${input.autoMerge ? "true" : "false"}\`; do not infer or change it during monitoring or restart cleanup.
- If autoMerge=false, never merge or change review labels directly; run exactly \`${guardedReadyHandoff}\`. This command re-observes the accepted history and revalidates the live head, current policy, and authenticated host verification under the enablement guard before marking the pull request ready and removing every agent workflow label. It never adds a human handoff label to a PR.
- If that command returns action=stale_history, do not hand off as reviewed. It returns the PR to review by replacing ${input.inProgressLabel || "agent:in-progress"} with ${input.reviewLabel}; then close the reviewer workspace with \`${renderWorkspaceCompletion(input, [input.reviewLabel])}\`.
- After an approved result and its policy-specific final labels are confirmed, run \`${renderWorkspaceCompletion(input, approvedLabels)}\`. For changes_requested with reported repair progress the deterministic dispatcher closes the reviewer workspace with ${input.inProgressLabel || "agent:in-progress"} before it opens the separate repair workspace; without repair progress it hands the result to a human instead.
- If autoMerge=true, retain exactly ${input.inProgressLabel || "agent:in-progress"} while applying unchanged merge gates. Merge only after the head-bound review approval, reported GitHub CI checks, and repository mergeability gates all pass. Perform the merge only by running exactly \`${guardedMerge}\`; never run \`gh pr merge\` directly. This binds GitHub's mutation to the reviewed head while holding the enablement guard.

Report only the resulting action and evidence.`;
}

function renderRepairMonitorPrompt(input: RepairMonitorPromptInput): string {
  return `Deterministic dispatcher launched one review-repair worker for PR #${input.prNumber}. Monitor only this attempt; never launch another agent or widen the findings contract.

Attempt binding:
- Existing PR branch: ${input.branch}
- Expected PR head: ${input.expectedHeadOid}
- Keep ${input.inProgressLabel} as the active managed state while repair is running.

${renderPromisePollingRules(input, "pull-request")}

Terminal handling:
- As soon as validation returns complete or blocked, run this deterministic completion handler exactly once and follow its result:
  \`node ${shellQuotePrompt(`${input.automationDir}/pr-review-repair-complete.cts`)} --promise ${shellQuotePrompt(input.promiseFile)} --attempt-record ${shellQuotePrompt(input.attemptRecordFile || `${input.promiseFile.replace(/\/[^/]+$/, "")}/attempt.json`)} --project-id ${shellQuotePrompt(input.projectId || "<projectId>")} --result ${shellQuotePrompt(`${input.promiseFile.replace(/\/[^/]+$/, "")}/finalizer-result.json`)} --contract ${shellQuotePrompt(`${input.promiseFile.replace(/\/[^/]+$/, "")}/review-contract.json`)} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))} --pr ${input.prNumber} --branch ${shellQuotePrompt(input.branch)} --expected-head ${shellQuotePrompt(input.expectedHeadOid)} --attempt-key ${shellQuotePrompt(input.attemptKey || "<attemptKey>")} --review-label ${shellQuotePrompt(input.reviewLabel)} --implement-label ${shellQuotePrompt(input.implementLabel)} --update-branch-label ${shellQuotePrompt(input.updateBranchLabel)} --in-progress-label ${shellQuotePrompt(input.inProgressLabel || "agent:in-progress")} --blocked-label ${shellQuotePrompt(input.blockedLabel)}\`
- The handler posts a success comment only when the structured promise, finalizer receipt, and live new head agree. It posts idempotent recovery guidance for blocked or inconclusive completion and posts nothing for stale_head.
- After a repair_pushed or stale_head result is confirmed by the handler, run \`${renderWorkspaceCompletion(input)}\`. Never close a blocked or inconclusive repair workspace.
- Do not independently render comments, infer changes from git diffs or logs, or change labels.

Prohibited in every path: force-push, monitor-side push, label changes outside the completion handler, PR creation, merge, issue close, branch deletion, or a second attempt for this exact review result.

Report only the terminal action and evidence.`;
}

type PendingMonitorHandoff =
  | { kind: "issue"; input: IssueMonitorPromptInput }
  | { kind: "explorer"; input: ExplorerMonitorPromptInput }
  | { kind: "reviewer"; input: ReviewerMonitorPromptInput }
  | { kind: "branch-update"; input: BranchUpdateMonitorPromptInput }
  | { kind: "repair"; input: RepairMonitorPromptInput };

function renderPendingMonitorHandoff(handoff: PendingMonitorHandoff, enabledAt?: number): string {
  if (!handoff.input || typeof handoff.input !== "object") throw new Error("unsupported pending monitor handoff");
  if (handoff.kind === "issue") {
    return renderIssueMonitorPrompt({ ...handoff.input, enabledAt: enabledAt ?? handoff.input.enabledAt });
  }
  if (handoff.kind === "explorer") {
    return renderExplorerMonitorPrompt({ ...handoff.input, enabledAt: enabledAt ?? handoff.input.enabledAt });
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
  renderExplorerMonitorPrompt,
  renderIssueMonitorPrompt,
  renderPendingMonitorHandoff,
  renderPromisePollingRules,
  renderRepairMonitorPrompt,
  renderReviewerMonitorPrompt,
};
