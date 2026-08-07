# Acceptance specification glossary

This glossary defines the English terms used when translating the executable acceptance specification. Public identifiers and literal product output are not translated.

| Japanese source concept | English term | Usage note |
| --- | --- | --- |
| 受け入れ仕様 | acceptance specification | The executable Gherkin specification. |
| 機能 | Feature | Gherkin keyword. |
| シナリオ | Scenario | Gherkin keyword. |
| シナリオアウトライン | Scenario Outline | Gherkin keyword. |
| 前提 / もし / ならば / かつ | Given / When / Then / And | Gherkin step keywords. |
| Issue | Issue | Preserve capitalization and numbers. |
| pull request | pull request | Use “PR” only where the source uses `PR`. |
| 担当 / エージェント | agent | Use Worker, Reviewer, repair agent, or branch-update agent when the role is explicit. |
| 作業ツリー / 作業場所 | worktree | A Git/Herdr worktree containing the checkout. |
| 実行場所 | workspace | A disposable Herdr workspace for one attempt. |
| 実行画面 / 担当画面 | pane | The root terminal pane used by an agent. |
| 試行 | attempt | One journaled agent launch lifecycle. |
| 完了報告 / 完了ファイル | completion report / promise file | Use “promise file” when referring to the concrete file contract. |
| 停止中 / 遮断 | blocked | Preserve the literal label `agent:blocked`. |
| 再投入 | requeue | Returning an Issue or pull request to selection. |
| 占有 | claim | Ownership represented by live attempt evidence and labels. |
| 回収 | reclaim | Recovering a stale claim or completed resource. |
| 片付け | cleanup | Guarded removal of completed resources. |
| 必須検証 | required verification | The resolved repository check contract. |
| 自動チェック | project check | The configured check run by deadloop. |
| 共有方針 | shared policy | Repository-owned policy from `deadloop.json`. |
| ローカル設定 | local configuration | Operator-local settings. |
| 外部レビュー | external review | Optional review performed outside the built-in Reviewer. |
| 競合回復 | conflict recovery | Guarded merge of the selected base into a pull request branch. |
| 修正担当 | repair agent | The bounded agent that addresses review findings. |
| ブランチ更新担当 | branch-update agent | The guarded conflict-recovery agent. |
| 安全停止 | fail closed | Stop without unsafe mutation when proof is missing. |
