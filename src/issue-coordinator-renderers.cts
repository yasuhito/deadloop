const path = require("node:path") as typeof import("node:path");

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
  automationDir: string;
  workerInstructions: string;
  promiseFile: string;
};

type IssueWorkerPromptInput = {
  launchReason: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  githubRepo: string;
  automationDir: string;
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
  const writerCommand = `node ${shellQuoteForRenderer(`${input.automationDir.replace(/\/$/, "")}/write-explorer-report.cts`)} --attempt-record ${shellQuoteForRenderer(attemptRecordForPromise(input.promiseFile))} <<'JSON'`;
  const writerFence = markdownFence(writerCommand);
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
- Do not write the promise file yourself. Decide the result, then hand its semantic payload to the report writer from the launch code snapshot:
  ${writerFence}bash
  ${writerCommand}
  {"status":"complete","summary":"<three sentences>","result":{"difficulty":"low|medium|high","relevantFiles":["path"],"verifiedClaims":["claim"],"disprovedClaims":[],"openQuestions":[],"approach":"optional approach"},"evidence":{"commands":["command and result"]}}
  JSON
  ${writerFence}
- On success the writer prints the written report file and exits 0; confirm that before stopping.
- If blocked, hand the writer this payload instead:
  {"status":"blocked","summary":"<three sentences>","result":{"reason":"add_request|free_storage|fix_environment|fix_verification_policy","explanation":"what failed","recovery":"safe next step"}}
- The writer injects the report identity from the attempt record. Supply only status, summary, and the investigation meaning; a payload that names identity, revision, worktree, workspace, run-directory, or output-path fields is refused and names them.
- Always hand a report to the writer before stopping, even on failure. If the writer refuses, fix the field it names and run it again.`;
}

function renderIssueWorkerPrompt(input: IssueWorkerPromptInput): string {
  const issueTitle = oneLineForRenderer(input.issueTitle);
  const validationCommand = input.validationCommand || `node ${shellQuoteForRenderer(pathForProjectCheck(input.automationDir))} --command ${shellQuoteForRenderer(input.checkCommand)}`;
  const validationFence = markdownFence(validationCommand);
  const writerCommand = `node ${shellQuoteForRenderer(`${input.automationDir.replace(/\/$/, "")}/write-worker-report.cts`)} --attempt-record ${shellQuoteForRenderer(attemptRecordForPromise(input.promiseFile))} <<'JSON'`;
  const writerFence = markdownFence(writerCommand);

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
- Do not write the promise file yourself. Decide the result, then hand its semantic payload to the report writer from the launch code snapshot:
  ${writerFence}bash
  ${writerCommand}
  {"status":"complete","summary":"<three sentences>","evidence":{"validations":["<command and result>"]}}
  JSON
  ${writerFence}
- On success the writer prints the written report file and exits 0; confirm that before stopping.
- If blocked by failure, missing spec, risky change, or uncertainty, hand the writer this payload instead:
  {"status":"blocked","summary":"<three sentences>","result":{"reason":"add_request|free_storage|fix_environment|fix_verification_policy","explanation":"what is unsafe","recovery":"safe next step"}}
- The writer injects the report identity and the worktree HEAD revision itself. Supply only status, summary, and the meaning of the result; a payload that names identity, target, revision, worktree, or output-path fields is refused and names them.
- Always hand a report to the writer before stopping, even on failure. If the writer refuses, fix the field it names and run it again.`;
}

function pathForProjectCheck(automationDir: string): string {
  return `${automationDir.replace(/\/$/, "")}/run-project-check.ts`;
}

/** The attempt record sits beside the promise file in the attempt's run directory. */
function attemptRecordForPromise(promiseFile: string): string {
  return path.join(path.dirname(promiseFile), "attempt.json");
}

module.exports = { renderIssueBlockedComment, renderIssueExplorerPrompt, renderIssuePlanningComment, renderIssueWorkerPrompt };
