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

type IssueWorkerPromptInput = {
  launchReason: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  githubRepo: string;
  workerInstructions: string;
  checkCommand: string;
  validationCommand?: string;
  promiseFile: string;
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

function renderIssuePlanningComment(issueNumber: number): string {
  return [
    "deadloop skipped automated implementation because this issue describes planning work rather than one implementable change.",
    "",
    "## Recovery steps",
    "1. Create a separate implementable issue or split this issue's scope.",
    "2. Give each implementation issue an `## Agent Brief` or `## What to build` section and an `## Acceptance criteria` section.",
    `3. When an implementation issue is ready, add \`agent:implement\` to that issue. Planning issue: #${issueNumber}`,
  ].join("\n");
}

function renderIssueBlockedComment(input: IssueBlockedCommentInput): string {
  const issue = Number(input.issueNumber);
  const promiseFile = optionalValue(input.promiseFile, "<promiseFile>");
  const workspaceId = optionalValue(input.workspaceId, "<workspaceId>");
  const worktreePath = optionalValue(input.worktreePath, "<worktreePath>");
  const branch = optionalValue(input.branch, "<branch>");
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
node ${shellQuoteForRenderer(input.automationDir)}/extract-worker-promise.ts --file ${shellQuoteForRenderer(promiseFile)} || true
herdr agent list
herdr pane list
\`\`\`
2. Inspect leftover worktrees or branches before cleanup.
   Run cleanup only after confirming the target is clean and no longer needed.
   ${optionalCommandNote(input.workspaceId, "Herdr workspace")}${optionalCommandNote(input.worktreePath, "worktree path")}${optionalCommandNote(input.branch, "branch")}` +
    `\`\`\`bash
herdr worktree list --cwd ${shellQuoteForRenderer(input.repoPath)} --json
git -C ${shellQuoteForRenderer(input.repoPath)} worktree list
git -C ${shellQuoteForRenderer(input.repoPath)} branch --list ${shellQuoteForRenderer(branchPattern)}
herdr worktree remove --workspace ${shellQuoteForRenderer(workspaceId)}
git -C ${shellQuoteForRenderer(input.repoPath)} worktree remove ${shellQuoteForRenderer(worktreePath)}
git -C ${shellQuoteForRenderer(input.repoPath)} branch -d ${shellQuoteForRenderer(branch)}
\`\`\`
3. Re-queue the issue after fixing the cause.
   \`\`\`bash
gh issue edit ${issue} -R ${shellQuoteForRenderer(input.githubRepo)} --remove-label ${shellQuoteForRenderer(input.blockedLabel)} --add-label ${shellQuoteForRenderer(input.implementLabel)}
\`\`\``;
}

function renderIssueWorkerPrompt(input: IssueWorkerPromptInput): string {
  const issueTitle = oneLineForRenderer(input.issueTitle);
  const validationCommand = input.validationCommand || input.checkCommand;
  const validationFence = markdownFence(validationCommand);

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
- On success, write \`{"status":"complete","reason":"","summary":"three sentences: what changed, what was verified, remaining risk"}\`.
- If blocked by failure, missing spec, risky change, or uncertainty, write \`{"status":"blocked","reason":"clear reason","summary":"three-sentence summary"}\`.
- Always write the promise file, even on failure. Do not exit silently.`;
}

module.exports = { renderIssueBlockedComment, renderIssuePlanningComment, renderIssueWorkerPrompt };
