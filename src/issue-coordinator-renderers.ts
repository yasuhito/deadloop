export type IssueBlockedCommentInput = {
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

export type IssueWorkerPromptInput = {
  launchReason: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  githubRepo: string;
  workerInstructions: string;
  checkCommand: string;
  promiseFile: string;
};

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function bulletLines(values: string[] | undefined, fallback: string): string[] {
  const lines = (values || []).map((value) => oneLine(value)).filter(Boolean);
  return lines.length ? lines.map((line) => `- ${line}`) : [`- ${fallback}`];
}

function shellQuote(value: string | number): string {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function optionalValue(value: string | undefined, placeholder: string): string {
  return value && value.trim() ? value : placeholder;
}

function optionalCommandNote(value: string | undefined, label: string): string {
  return value && value.trim() ? "" : `   該当なし: ${label} が未作成または未特定です。\n`;
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
  return oneLine(value).replace(/`/g, "\\`");
}

export function renderIssueBlockedComment(input: IssueBlockedCommentInput): string {
  const issue = Number(input.issueNumber);
  const promiseFile = optionalValue(input.promiseFile, "<promiseFile>");
  const workspaceId = optionalValue(input.workspaceId, "<workspaceId>");
  const worktreePath = optionalValue(input.worktreePath, "<worktreePath>");
  const branch = optionalValue(input.branch, "<branch>");
  const branchPattern = input.branch ? input.branch : `agent/issue-${issue}-*`;
  const confirmed = bulletLines(input.confirmed, "追加の確認事項はまだありません。").join("\n");
  const nextDecision = oneLine(input.nextDecision || "原因を確認し、再 queue してよい状態か operator が判断してください。");

  return `## 何が起きたか
- ${oneLine(input.summary)}
- 確認済み事項:
${confirmed}
- 次に必要な判断: ${nextDecision}

## 復旧手順
1. 原因を確認する。
   ${optionalCommandNote(input.promiseFile, "promise ファイル")}` +
    `\`\`\`bash
gh issue view ${issue} -R ${shellQuote(input.githubRepo)} --comments
python3 ${shellQuote(input.automationDir)}/extract-worker-promise.py --file ${shellQuote(promiseFile)} || true
herdr agent list
herdr pane list
\`\`\`
2. 残骸（worktree / branch）を確認し、安全に掃除する。
   掃除コマンドは対象が clean / 不要であることを確認してから実行する。
   ${optionalCommandNote(input.workspaceId, "Herdr workspace")}${optionalCommandNote(input.worktreePath, "worktree path")}${optionalCommandNote(input.branch, "branch")}` +
    `\`\`\`bash
herdr worktree list --cwd ${shellQuote(input.repoPath)} --json
git -C ${shellQuote(input.repoPath)} worktree list
git -C ${shellQuote(input.repoPath)} branch --list ${shellQuote(branchPattern)}
herdr worktree remove --workspace ${shellQuote(workspaceId)}
git -C ${shellQuote(input.repoPath)} worktree remove ${shellQuote(worktreePath)}
git -C ${shellQuote(input.repoPath)} branch -d ${shellQuote(branch)}
\`\`\`
3. 原因を解消したあと、issue を再 queue する。
   \`\`\`bash
gh issue edit ${issue} -R ${shellQuote(input.githubRepo)} --remove-label ${shellQuote(input.blockedLabel)} --add-label ${shellQuote(input.implementLabel)}
\`\`\``;
}

export function renderIssueWorkerPrompt(input: IssueWorkerPromptInput): string {
  const issueTitle = oneLine(input.issueTitle);

  const validationFence = markdownFence(input.checkCommand);

  return `起動判断: ${oneLine(input.launchReason)}

Issue #${input.issueNumber} を実装してください。

対象:
- GitHub repo: ${input.githubRepo}
- Issue: #${input.issueNumber} ${issueTitle}
- Issue URL: ${input.issueUrl}

契約:
- この issue の \`Agent Brief\` または \`What to build\` と \`Acceptance criteria\` を実装契約として扱ってください。
- \`Out of scope\` / \`対象外\` があれば必ず守ってください。
- ${oneLine(input.workerInstructions)}
- 可能なら red-green-refactor で進めてください。
- 関連する検証を実行し、最低限次の検証コマンドを通してください。
  ${validationFence}bash
  ${input.checkCommand}
  ${validationFence}
- conventional commit で1つ以上 commit してください。

禁止事項:
- push しない。
- label を編集しない。
- issue / PR にコメントしない。
- PR を作らない。
- issue を閉じない。
- unrelated な変更を戻さない。

完了報告:
- 作業終了時は、オーケストレータが指定した promise ファイル \`${markdownCode(input.promiseFile)}\` に必ず JSON を書いてください。
- 成功時は \`{"status":"complete","reason":"","summary":"3文要約(何をした・何が分かった・何が残っている)"}\` を書いてください。
- 失敗、仕様不足、危険変更、または判断不能なら \`{"status":"blocked","reason":"日本語の理由","summary":"3文要約(何をした・何が分かった・何が残っている)"}\` を書いてください。
- 失敗時も必ず promise ファイルを書いてください。黙って終了しないでください。`;
}
