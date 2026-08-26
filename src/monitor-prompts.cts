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

function renderWorkspaceCompletion(input: MonitorPromptBaseInput, expectedLabels: string[] = []): string {
  const labels = expectedLabels.flatMap((label) => ["--expected-label", shellQuotePrompt(label)]).join(" ");
  const reviewer = input as Partial<ReviewerMonitorPromptInput>;
  const managedLabels = [
    reviewer.reviewLabel, reviewer.implementLabel, reviewer.updateBranchLabel,
    reviewer.inProgressLabel, reviewer.blockedLabel,
  ].filter((label): label is string => Boolean(label));
  const managed = managedLabels.flatMap((label) => ["--managed-label", shellQuotePrompt(label)]).join(" ");
  const workerLabels = "reviewLabel" in input && input.reviewLabel
    ? ["--worker-review-label", shellQuotePrompt(String(input.reviewLabel))].join(" ")
    : "";

  const policy = "autoMerge" in input ? `--auto-merge ${input.autoMerge ? "true" : "false"}` : "";
  const extras = [workerLabels, policy, labels, managed].filter(Boolean).join(" ");
  return `node ${shellQuotePrompt(`${input.automationDir}/complete-attempt-workspace.cts`)} --attempt-record ${shellQuotePrompt(input.attemptRecordFile || `${input.promiseFile.replace(/\/[^/]+$/, "")}/attempt.json`)} --project-id ${shellQuotePrompt(input.projectId || "<projectId>")} --project-repo ${shellQuotePrompt(input.repoPath || "<projectRepo>")} --github-repo ${shellQuotePrompt(input.githubRepo || "<githubRepo>")} --state-dir ${shellQuotePrompt(input.stateDir || "<stateDir>")} --enabled-at ${shellQuotePrompt(String(input.enabledAt ?? "<enabledAt>"))}${extras ? ` ${extras}` : ""}`;
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

type PendingMonitorHandoff = { kind: "repair"; input: RepairMonitorPromptInput };

function renderPendingMonitorHandoff(handoff: PendingMonitorHandoff, enabledAt?: number): string {
  if (!handoff.input || typeof handoff.input !== "object") throw new Error("unsupported pending monitor handoff");
  if (handoff.kind === "repair") {
    return renderRepairMonitorPrompt({ ...handoff.input, enabledAt: enabledAt ?? handoff.input.enabledAt });
  }
  throw new Error("unsupported pending monitor handoff");
}

module.exports = {
  renderPendingMonitorHandoff,
  renderPromisePollingRules,
  renderRepairMonitorPrompt,
};
