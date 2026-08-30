type IssuePlanningCommentInput = {
  githubRepo: string;
  blockedLabel: string;
  readyLabel: string;
  implementLabel: string;
};

type IssueBlockedCommentInput = {
  issueNumber: number;
  githubRepo: string;
  repoPath: string;
  automationDir: string;
  blockedLabel: string;
  implementLabel: string;
  summary: string;
  confirmed?: string[];
  nextDecision?: string;
  promiseFile?: string;
  workspaceId?: string;
  worktreePath?: string;
  branch?: string;
};

type IssueExplorerPromptInput = {
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  githubRepo: string;
  workerInstructions: string;
  promiseFile: string;
  reportIdentity: { attemptId: string; inputRevision: { head: string } };
};

type IssueWorkerPromptInput = {
  launchReason: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  githubRepo: string;
  automationDir?: string;
  workerInstructions: string;
  checkCommand: string;
  validationCommand?: string;
  promiseFile: string;
  reportIdentity?: { attemptId: string; inputRevision: { head: string; base?: string } };
};

function oneLineForRenderer(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function bulletLines(values: string[] | undefined, fallback: string): string[] {
  const lines = (values || []).map((value) => oneLineForRenderer(value)).filter(Boolean);
  return lines.length ? lines.map((line) => `- ${line}`) : [`- ${fallback}`];
}

function shellQuoteForRenderer(value: string | number): string {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function optionalValue(value: string | undefined, placeholder: string): string {
  return value && value.trim() ? value : placeholder;
}

function optionalCommandNote(value: string | undefined, label: string): string {
  return value && value.trim() ? "" : `   Not applicable: ${label} is missing or unknown.\n`;
}

function longestRun(value: string, character: "`" | "~"): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    if (char === character) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function markdownFence(value: string): string {
  const backticks = longestRun(value, "`");
  if (backticks < 3) return "```";
  const tildes = longestRun(value, "~");
  if (tildes < 3) return "~~~";
  return "`".repeat(backticks + 1);
}

function markdownCode(value: string): string {
  return oneLineForRenderer(value).replace(/`/g, "\\`");
}

function renderIssuePlanningComment(input: IssuePlanningCommentInput): string {
  return [
    "Skipped automated implementation because this looks like a PRD, design, or parent issue.",
    "",
    "## Recovery steps",
    "1. Create a separate implementable issue or split this issue's scope.",
    "2. Give each implementation issue an `## Agent Brief` or `## What to build` section and an `## Acceptance criteria` section.",
    "3. Note the number of the implementation issue you created or split out, then re-queue that issue safely (replace `123` below):",
    "```bash",
    "implementable_issue_number=123",
    `gh issue edit "$implementable_issue_number" -R ${shellQuoteForRenderer(input.githubRepo)} --remove-label ${shellQuoteForRenderer(input.blockedLabel)} --add-label ${shellQuoteForRenderer(input.readyLabel)} --add-label ${shellQuoteForRenderer(input.implementLabel)}`,
    "```",
  ].join("\n");
}

function renderIssueBlockedComment(input: IssueBlockedCommentInput): string {
  const issue = Number(input.issueNumber);
  const promiseFile = optionalValue(input.promiseFile, "<promiseFile>");
  const worktreePath = optionalValue(input.worktreePath, "<worktreePath>");
  const branchPattern = input.branch ? input.branch : `agent/issue-${issue}-*`;
  const confirmed = bulletLines(input.confirmed, "No additional facts confirmed yet.").join("\n");
  const nextDecision = oneLineForRenderer(input.nextDecision || "Inspect the cause and decide whether the issue is safe to re-queue.");

  return `## What happened
- ${oneLineForRenderer(input.summary)}
- Confirmed facts:
${confirmed}
- Next decision: ${nextDecision}

## Recovery steps
1. Inspect the cause.
   ${optionalCommandNote(input.promiseFile, "promise file")}` +
    `\`\`\`bash
gh issue view ${issue} -R ${shellQuoteForRenderer(input.githubRepo)} --comments
node ${shellQuoteForRenderer(input.automationDir)}/extract-worker-promise.cts --file ${shellQuoteForRenderer(promiseFile)} || true
herdr agent list
herdr pane list
\`\`\`
2. Inspect the retained attempt workspace and linked worktree.
   Preserve them while the result is blocked or ownership is unclear. Only a bound V1 success plus confirmed GitHub persistence may close the attempt workspace; linked-worktree removal remains reserved for the merged/closed-PR safety gate.
   ${optionalCommandNote(input.workspaceId, "Herdr workspace")}${optionalCommandNote(input.worktreePath, "worktree path")}${optionalCommandNote(input.branch, "branch")}` +
    `\`\`\`bash
herdr workspace list
herdr worktree list --cwd ${shellQuoteForRenderer(input.repoPath)} --json
git -C ${shellQuoteForRenderer(input.repoPath)} worktree list
git -C ${shellQuoteForRenderer(input.repoPath)} branch --list ${shellQuoteForRenderer(branchPattern)}
git -C ${shellQuoteForRenderer(worktreePath)} status --short --untracked-files=all
\`\`\`
3. Re-queue the issue after fixing the cause.
   \`\`\`bash
gh issue edit ${issue} -R ${shellQuoteForRenderer(input.githubRepo)} --remove-label ${shellQuoteForRenderer(input.blockedLabel)} --add-label ${shellQuoteForRenderer(input.implementLabel)}
\`\`\``;
}

function renderIssueExplorerPrompt(input: IssueExplorerPromptInput): string {
  const reportBase = JSON.stringify({
    schemaVersion: 1,
    attemptId: input.reportIdentity.attemptId,
    role: "explorer",
    target: { repository: input.githubRepo, kind: "issue", number: input.issueNumber },
    inputRevision: input.reportIdentity.inputRevision,
  });
  return `Explore Issue #${input.issueNumber}: ${oneLineForRenderer(input.issueTitle)}

Target:
- GitHub repo: ${input.githubRepo}
- Issue URL: ${input.issueUrl}

Read the Issue body and all comments, CONTEXT.md when present, relevant ADRs and repository standards, source, tests, and useful git history. ${oneLineForRenderer(input.workerInstructions)}
You may run read-only inspection and verification commands such as focused tests, typecheck, git log, and git blame.

Hard limits:
- Do not edit, create, delete, rename, or format repository files.
- Do not commit or push.
- Do not create, edit, or close pull requests.
- Do not edit labels or post GitHub comments.
- Do not run destructive commands. The Automation host alone validates and posts the result.

Promise report:
- Write one JSON object to \`${markdownCode(input.promiseFile)}\` before stopping.
- Start with this exact identity: \`${markdownCode(reportBase)}\`.
- Every report must also include the summary field beside the identity: \`"summary":"<three sentences>"\`. A report without it is invalid and discarded.
- On success add \`"status":"complete"\`, \`"result":{"difficulty":"low|medium|high","relevantFiles":["path"],"verifiedClaims":["claim"],"disprovedClaims":[],"openQuestions":[],"approach":"optional approach"}\`, and \`"evidence":{"commands":["command and result"]}\`.
- On failure add \`"status":"blocked"\`, \`"result":{"reason":"add_request|free_storage|fix_environment|fix_verification_policy","explanation":"what failed","recovery":"safe next step"}\`, and \`"evidence":{}\`.
- Always write the promise file; do not exit silently.`;
}

function renderIssueWorkerPrompt(input: IssueWorkerPromptInput): string {
  const issueTitle = oneLineForRenderer(input.issueTitle);
  const validationCommand = input.validationCommand || (input.automationDir
    ? `node ${shellQuoteForRenderer(pathForProjectCheck(input.automationDir))} --command ${shellQuoteForRenderer(input.checkCommand)}`
    : input.checkCommand);
  const validationFence = markdownFence(validationCommand);
  const identity = input.reportIdentity || { attemptId: "<attemptId>", inputRevision: { head: "<baseRevision>" } };
  const reportBase = JSON.stringify({
    schemaVersion: 1,
    attemptId: identity.attemptId,
    role: "worker",
    target: { repository: input.githubRepo, kind: "issue", number: input.issueNumber },
    inputRevision: identity.inputRevision,
  });

  return `Launch reason: ${oneLineForRenderer(input.launchReason)}

Implement Issue #${input.issueNumber}.

Target:
- GitHub repo: ${input.githubRepo}
- Issue: #${input.issueNumber} ${issueTitle}
- Issue URL: ${input.issueUrl}

Contract:
- Treat the issue's \`Agent Brief\` or \`What to build\` plus \`Acceptance criteria\` as the implementation contract.
- Respect any \`Out of scope\` section.
- ${oneLineForRenderer(input.workerInstructions)}
- Prefer a red-green-refactor loop when practical.
- Run relevant validation and at minimum pass this check command:
  ${validationFence}bash
  ${validationCommand}
  ${validationFence}
- Create at least one conventional commit.

Hard limits:
- Do not push.
- Do not edit labels.
- Do not comment on issues or PRs.
- Do not create PRs.
- Do not close issues.
- Do not revert unrelated changes.

Promise report:
- Before stopping, write JSON to the orchestrator promise file: \`${markdownCode(input.promiseFile)}\`.
- Every report must start with this exact V1 identity: \`${markdownCode(reportBase)}\`.
- Every report must also include the summary field beside the identity: \`"summary":"<three sentences>"\`. A report without it is invalid and discarded.
- On success, add \`"status":"complete"\`, \`"result":{"outputRevision":"<commit SHA>"}\`, and \`"evidence":{"validations":["<command and result>"]}\`.
- If blocked by failure, missing spec, risky change, or uncertainty, add \`"status":"blocked"\`, \`"result":{"reason":"add_request|free_storage|fix_environment|fix_verification_policy","explanation":"what is unsafe","recovery":"safe next step"}\`, and \`"evidence":{}\`.
- Write one complete JSON object; do not nest the identity JSON as a string.
- Always write the promise file, even on failure. Do not exit silently.`;
}

function pathForProjectCheck(automationDir: string): string {
  return `${automationDir.replace(/\/$/, "")}/run-project-check.ts`;
}

module.exports = { renderIssueBlockedComment, renderIssueExplorerPrompt, renderIssuePlanningComment, renderIssueWorkerPrompt };
