# 既存テストの Cucumber / Vitest / 削除候補分類（Issue #107 承認用ドラフト）

## 目的と前提

この文書は、2026-07-14 時点の `test/**/*.test.ts` 42ファイルを実行して得た399ケースを、人間が移行範囲として承認するための棚卸しである。分類だけを行い、Cucumberへの移行や既存テストの削除はまだ行わない。Issue #102・#105に従い、Cucumber化するときは Feature に保証対象と理由を短く書き、Given=事前状態、When=一つの契機、Then=一つの外部観測結果とする。1シナリオ・1保証・1 Then・1 assertionを必須とし、内部のfixture名、関数名、内部専用列挙値はシナリオ本文へ持ち込まない。

表の「現在のテスト名」は追跡用の原文メタデータであり、将来のシナリオ名や本文へそのまま転載する指示ではない。各行は一つの保証を表し、複数ケースを一行にまとめていない。

## 分類基準

- **Cucumber候補**: deadloopの公開仕様、GitHub Issue/PRや作業領域の利用者観測可能な状態遷移、表示・コメント・終了コード、誤削除・誤push・自動merge防止などの安全契約。現在内部APIを呼んでいても、外部観測結果へ書き換える価値があるものを含む。
- **Vitest継続**: 小さな純粋関数、引数変換、パーサー、実行基盤アダプター、静的ファイル／配布物／プロンプト検査、低レベル統合。受け入れ仕様と重複しても局所的な診断価値がある場合は残す。
- **削除候補**: 廃止済み名称・旧実装方式の「不存在」など、現行契約ではなく移行履歴だけを固定するもの。これは承認後の削除候補であり、このドラフトでは削除しない。迷うケースは削除へ送らずVitest継続とした。

## 件数集計

| 分類 | 件数 | 割合 |
|---|---:|---:|
| Cucumber候補 | 217 | 54.4% |
| Vitest継続 | 173 | 43.4% |
| 削除候補 | 9 | 2.3% |
| **合計** | **399** | **100.0%** |

### ファイル別照合

| 現在のファイル | 総数 | Cucumber候補 | Vitest継続 | 削除候補 |
|---|---:|---:|---:|---:|
| `test/agent-launch-flow.test.ts` | 6 | 6 | 0 | 0 |
| `test/agent-profiles.test.ts` | 13 | 0 | 13 | 0 |
| `test/agent-trust.test.ts` | 3 | 3 | 0 | 0 |
| `test/automation-driver-kit.test.ts` | 6 | 0 | 6 | 0 |
| `test/automation-driver-runner.test.ts` | 14 | 7 | 7 | 0 |
| `test/automation-file-resolution.test.ts` | 4 | 0 | 3 | 1 |
| `test/automation-short-names.test.ts` | 3 | 0 | 2 | 1 |
| `test/blocked-report-format.test.ts` | 4 | 4 | 0 | 0 |
| `test/branding-migration.test.ts` | 4 | 1 | 0 | 3 |
| `test/ci-fallback-decision.test.ts` | 8 | 8 | 0 | 0 |
| `test/ci-workflow.test.ts` | 8 | 0 | 7 | 1 |
| `test/core.test.ts` | 60 | 36 | 24 | 0 |
| `test/doctor.test.ts` | 27 | 27 | 0 | 0 |
| `test/extract-worker-promise.test.ts` | 9 | 0 | 9 | 0 |
| `test/github-operations.test.ts` | 5 | 0 | 5 | 0 |
| `test/herdr-runner.test.ts` | 12 | 0 | 12 | 0 |
| `test/issue-coordinator-cleanup.test.ts` | 22 | 13 | 9 | 0 |
| `test/issue-coordinator-driver.test.ts` | 16 | 10 | 6 | 0 |
| `test/issue-coordinator-flow.test.ts` | 5 | 0 | 5 | 0 |
| `test/issue-coordinator-renderers.test.ts` | 13 | 5 | 8 | 0 |
| `test/issue-coordinator-selection.test.ts` | 8 | 6 | 2 | 0 |
| `test/launch-agent-integration.test.ts` | 4 | 4 | 0 | 0 |
| `test/launch-agent-template.test.ts` | 7 | 0 | 7 | 0 |
| `test/monitor-prompts.test.ts` | 6 | 3 | 3 | 0 |
| `test/package-manifest.test.ts` | 11 | 0 | 11 | 0 |
| `test/pr-branch-update-decision.test.ts` | 6 | 6 | 0 | 0 |
| `test/pr-branch-update-safety.test.ts` | 8 | 5 | 3 | 0 |
| `test/pr-review-repair-dispatch.integration.test.ts` | 1 | 1 | 0 | 0 |
| `test/pr-review-repair.test.ts` | 13 | 10 | 3 | 0 |
| `test/pr-reviewer-driver.test.ts` | 18 | 14 | 4 | 0 |
| `test/pr-reviewer-flow.test.ts` | 6 | 0 | 6 | 0 |
| `test/pr-reviewer-precheck.test.ts` | 18 | 15 | 3 | 0 |
| `test/pr-reviewer-relaunch-integration.test.ts` | 1 | 1 | 0 | 0 |
| `test/pr-reviewer-stale-reclaim.test.ts` | 7 | 7 | 0 | 0 |
| `test/project-check.test.ts` | 9 | 9 | 0 | 0 |
| `test/promise-file-contract.test.ts` | 6 | 3 | 0 | 3 |
| `test/prompt-budget.test.ts` | 2 | 0 | 2 | 0 |
| `test/prompt-template-integrity.test.ts` | 1 | 0 | 1 | 0 |
| `test/skill-package.test.ts` | 4 | 0 | 4 | 0 |
| `test/status-report.test.ts` | 8 | 7 | 1 | 0 |
| `test/watch-polling-break.test.ts` | 4 | 0 | 4 | 0 |
| `test/worker-watch-decision.test.ts` | 9 | 6 | 3 | 0 |
| **合計** | **399** | **217** | **173** | **9** |

## 移行候補の優先グループ

1. **優先A — 破壊操作の安全契約**: ブランチ更新・自動修正・作業領域片付け・プロジェクト検証・信頼確認。古いhead、異なるリポジトリ、追跡ファイル、dirty状態、force push、自動mergeの防止を先に外部観測シナリオへする。各停止理由は独立シナリオにする。
2. **優先B — IssueからPRレビューまでの状態遷移**: Issue選択、契約不足、作業開始、PR選択、CI待機、外部レビュー待機、競合更新、修正再実行、古い占有の回収。GitHubラベルなど公開識別子だけを用い、内部のfixture名や計画値は使わない。
3. **優先C — オペレーター向け観測結果**: `/deadloop-doctor`、`/deadloop-status`、停止コメント、復旧コマンド。表示される一つの結果を各Thenで保証する。
4. **優先D — 公開設定と起動境界**: 設定の既定値・優先順位、CI代替、エージェント起動、監視終了。優先A〜Cで共通ステップの意味が固まった後に移す。

同じ前提表を使える場合も、異なる観測結果を一つのScenario Outlineへ混ぜない。同一保証の入力バリエーションだけをOutline化する。

## 全テストケース分類

### `test/agent-launch-flow.test.ts`（6件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T001 | `test/agent-launch-flow.test.ts` | `opens a PR worktree through the runner, writes prompt and promise paths, and starts the reviewer through the launcher` | **Cucumber候補** | 作業対象に対応するエージェントを重複や誤消去なく、安全な作業ツリーで起動できること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T002 | `test/agent-launch-flow.test.ts` | `retires a finished same-name reviewer before starting its replacement` | **Cucumber候補** | 作業対象に対応するエージェントを重複や誤消去なく、安全な作業ツリーで起動できること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T003 | `test/agent-launch-flow.test.ts` | `refuses to duplicate a working same-name reviewer` | **Cucumber候補** | 作業対象に対応するエージェントを重複や誤消去なく、安全な作業ツリーで起動できること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T004 | `test/agent-launch-flow.test.ts` | `refuses to clean up ambiguous same-name reviewers` | **Cucumber候補** | 作業対象に対応するエージェントを重複や誤消去なく、安全な作業ツリーで起動できること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T005 | `test/agent-launch-flow.test.ts` | `refuses to clean up a same-name reviewer from another worktree` | **Cucumber候補** | 作業対象に対応するエージェントを重複や誤消去なく、安全な作業ツリーで起動できること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T006 | `test/agent-launch-flow.test.ts` | `creates a Worker worktree from the base branch before starting the Worker through the launcher` | **Cucumber候補** | 作業対象に対応するエージェントを重複や誤消去なく、安全な作業ツリーで起動できること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/agent-profiles.test.ts`（13件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T007 | `test/agent-profiles.test.ts` | `derives the supported agent kinds from the profile table` | **Vitest継続** | 設定したエージェント種別を有効な起動引数へ変換し、不正な設定を拒否すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T008 | `test/agent-profiles.test.ts` | `recognizes a profiled agent kind` | **Vitest継続** | 設定したエージェント種別を有効な起動引数へ変換し、不正な設定を拒否すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T009 | `test/agent-profiles.test.ts` | `rejects an unprofiled agent kind` | **Vitest継続** | 設定したエージェント種別を有効な起動引数へ変換し、不正な設定を拒否すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T010 | `test/agent-profiles.test.ts` | `builds the pi argv with a file-reference prompt` | **Vitest継続** | 設定したエージェント種別を有効な起動引数へ変換し、不正な設定を拒否すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T011 | `test/agent-profiles.test.ts` | `approves project trust for unattended pi agents` | **Vitest継続** | 設定したエージェント種別を有効な起動引数へ変換し、不正な設定を拒否すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T012 | `test/agent-profiles.test.ts` | `builds the claude argv with a positional prompt payload` | **Vitest継続** | 設定したエージェント種別を有効な起動引数へ変換し、不正な設定を拒否すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T013 | `test/agent-profiles.test.ts` | `omits the model flag when the model is empty` | **Vitest継続** | 設定したエージェント種別を有効な起動引数へ変換し、不正な設定を拒否すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T014 | `test/agent-profiles.test.ts` | `includes the pi model flag when a model is set` | **Vitest継続** | 設定したエージェント種別を有効な起動引数へ変換し、不正な設定を拒否すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T015 | `test/agent-profiles.test.ts` | `maps the pi level onto the --thinking flag` | **Vitest継続** | 設定したエージェント種別を有効な起動引数へ変換し、不正な設定を拒否すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T016 | `test/agent-profiles.test.ts` | `maps the claude level onto the --effort flag` | **Vitest継続** | 設定したエージェント種別を有効な起動引数へ変換し、不正な設定を拒否すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T017 | `test/agent-profiles.test.ts` | `threads the uuid into the claude session id` | **Vitest継続** | 設定したエージェント種別を有効な起動引数へ変換し、不正な設定を拒否すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T018 | `test/agent-profiles.test.ts` | `throws when the agent kind is unknown` | **Vitest継続** | 設定したエージェント種別を有効な起動引数へ変換し、不正な設定を拒否すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T019 | `test/agent-profiles.test.ts` | `throws when the claude session uuid is missing` | **Vitest継続** | 設定したエージェント種別を有効な起動引数へ変換し、不正な設定を拒否すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |

### `test/agent-trust.test.ts`（3件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T020 | `test/agent-trust.test.ts` | `continues when the workspace is trusted` | **Cucumber候補** | 無人実行前の作業領域の信頼確認で、安全側の起動判断を行うこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T021 | `test/agent-trust.test.ts` | `blocks when the workspace trust is confirmed unaccepted` | **Cucumber候補** | 無人実行前の作業領域の信頼確認で、安全側の起動判断を行うこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T022 | `test/agent-trust.test.ts` | `warns and continues when the trust state cannot be determined` | **Cucumber候補** | 無人実行前の作業領域の信頼確認で、安全側の起動判断を行うこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/automation-driver-kit.test.ts`（6件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T023 | `test/automation-driver-kit.test.ts` | `builds driver result payloads` | **Vitest継続** | 決定論的ドライバーの値整形・引数解析・コマンド実行補助が正しく動くこと | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T024 | `test/automation-driver-kit.test.ts` | `runs commands as text` | **Vitest継続** | 決定論的ドライバーの値整形・引数解析・コマンド実行補助が正しく動くこと | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T025 | `test/automation-driver-kit.test.ts` | `normalizes multiline text` | **Vitest継続** | 決定論的ドライバーの値整形・引数解析・コマンド実行補助が正しく動くこと | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T026 | `test/automation-driver-kit.test.ts` | `quotes shell arguments` | **Vitest継続** | 決定論的ドライバーの値整形・引数解析・コマンド実行補助が正しく動くこと | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T027 | `test/automation-driver-kit.test.ts` | `parses boolean environment values` | **Vitest継続** | 決定論的ドライバーの値整形・引数解析・コマンド実行補助が正しく動くこと | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T028 | `test/automation-driver-kit.test.ts` | `parses fixture arguments` | **Vitest継続** | 決定論的ドライバーの値整形・引数解析・コマンド実行補助が正しく動くこと | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |

### `test/automation-driver-runner.test.ts`（14件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T029 | `test/automation-driver-runner.test.ts` | `clears the current driver error after a recovered launch is queued` | **Vitest継続** | ドライバー結果に応じてプロンプト送信とスケジューラー状態を一意に遷移させること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T030 | `test/automation-driver-runner.test.ts` | `skips sending a prompt when the driver returns skip` | **Cucumber候補** | ドライバー結果に応じてプロンプト送信とスケジューラー状態を一意に遷移させること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T031 | `test/automation-driver-runner.test.ts` | `records the skip driver result` | **Vitest継続** | ドライバー結果に応じてプロンプト送信とスケジューラー状態を一意に遷移させること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T032 | `test/automation-driver-runner.test.ts` | `skips sending a prompt when the driver returns done` | **Cucumber候補** | ドライバー結果に応じてプロンプト送信とスケジューラー状態を一意に遷移させること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T033 | `test/automation-driver-runner.test.ts` | `records the done driver summary` | **Vitest継続** | ドライバー結果に応じてプロンプト送信とスケジューラー状態を一意に遷移させること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T034 | `test/automation-driver-runner.test.ts` | `sends only the driver prompt when the driver returns needs_llm` | **Cucumber候補** | ドライバー結果に応じてプロンプト送信とスケジューラー状態を一意に遷移させること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T035 | `test/automation-driver-runner.test.ts` | `records the needs_llm queue result` | **Vitest継続** | ドライバー結果に応じてプロンプト送信とスケジューラー状態を一意に遷移させること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T036 | `test/automation-driver-runner.test.ts` | `records invalid driver JSON` | **Vitest継続** | ドライバー結果に応じてプロンプト送信とスケジューラー状態を一意に遷移させること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T037 | `test/automation-driver-runner.test.ts` | `skips sending a prompt when the driver returns invalid JSON` | **Cucumber候補** | ドライバー結果に応じてプロンプト送信とスケジューラー状態を一意に遷移させること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T038 | `test/automation-driver-runner.test.ts` | `records a non-zero driver exit` | **Vitest継続** | ドライバー結果に応じてプロンプト送信とスケジューラー状態を一意に遷移させること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T039 | `test/automation-driver-runner.test.ts` | `skips sending a prompt when the driver exits non-zero` | **Cucumber候補** | ドライバー結果に応じてプロンプト送信とスケジューラー状態を一意に遷移させること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T040 | `test/automation-driver-runner.test.ts` | `records a driver error action` | **Vitest継続** | ドライバー結果に応じてプロンプト送信とスケジューラー状態を一意に遷移させること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T041 | `test/automation-driver-runner.test.ts` | `skips sending a prompt when the driver returns error` | **Cucumber候補** | ドライバー結果に応じてプロンプト送信とスケジューラー状態を一意に遷移させること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T042 | `test/automation-driver-runner.test.ts` | `keeps prompt-only automations working when no driver is configured` | **Cucumber候補** | ドライバー結果に応じてプロンプト送信とスケジューラー状態を一意に遷移させること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/automation-file-resolution.test.ts`（4件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T043 | `test/automation-file-resolution.test.ts` | `does not resolve retired generic automation names` | **削除候補** | 設定された自動化ファイル名を存在状態とともに解決すること | 廃止済みの generic 名を解決しないという移行履歴だけを固定しており、現行名の解決契約は別ケースで守られている。 |
| T044 | `test/automation-file-resolution.test.ts` | `marks an unknown automation file as not found` | **Vitest継続** | 設定された自動化ファイル名を存在状態とともに解決すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T045 | `test/automation-file-resolution.test.ts` | `keeps the requested current short name unchanged` | **Vitest継続** | 設定された自動化ファイル名を存在状態とともに解決すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T046 | `test/automation-file-resolution.test.ts` | `marks a current short name as found` | **Vitest継続** | 設定された自動化ファイル名を存在状態とともに解決すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |

### `test/automation-short-names.test.ts`（3件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T047 | `test/automation-short-names.test.ts` | `uses short issue coordinator files in the example project config` | **Vitest継続** | 配布例が現行の短い自動化ファイル名を参照すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T048 | `test/automation-short-names.test.ts` | `uses short PR reviewer files in the example project config` | **Vitest継続** | 配布例が現行の短い自動化ファイル名を参照すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T049 | `test/automation-short-names.test.ts` | `does not ship retired generic automation filenames` | **削除候補** | 配布例が現行の短い自動化ファイル名を参照すること | 廃止済みファイル名が存在しないことだけを固定する改名時の回帰検査で、現行配布契約は先行2ケースで守られている。 |

### `test/blocked-report-format.test.ts`（4件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T050 | `test/blocked-report-format.test.ts` | `requires the issue coordinator blocked report recovery section` | **Cucumber候補** | 停止時の公開コメントに復旧手順と安全な再投入方法が示されること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T051 | `test/blocked-report-format.test.ts` | `requires the issue coordinator blocked report requeue command` | **Cucumber候補** | 停止時の公開コメントに復旧手順と安全な再投入方法が示されること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T052 | `test/blocked-report-format.test.ts` | `requires the PR reviewer blocked report recovery section` | **Cucumber候補** | 停止時の公開コメントに復旧手順と安全な再投入方法が示されること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T053 | `test/blocked-report-format.test.ts` | `requires the PR reviewer blocked report requeue command` | **Cucumber候補** | 停止時の公開コメントに復旧手順と安全な再投入方法が示されること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/branding-migration.test.ts`（4件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T054 | `test/branding-migration.test.ts` | `registers the deadloop status command` | **Cucumber候補** | 公開コマンドと配布物が deadloop という現行製品境界を表すこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T055 | `test/branding-migration.test.ts` | `does not register old pi-looper command aliases` | **削除候補** | 公開コマンドと配布物が deadloop という現行製品境界を表すこと | 旧コマンド別名の不存在を固定する改名履歴であり、現行の公開コマンドは別ケースで守られている。 |
| T056 | `test/branding-migration.test.ts` | `does not read old PI_LOOPER environment variables` | **削除候補** | 公開コマンドと配布物が deadloop という現行製品境界を表すこと | 旧環境変数の不存在を固定する改名履歴であり、現行の DEADLOOP 設定契約を直接保証しない。 |
| T057 | `test/branding-migration.test.ts` | `documents the breaking rename` | **削除候補** | 公開コマンドと配布物が deadloop という現行製品境界を表すこと | 過去の改名文書中の語句を固定するだけで、実行時または現行配布の契約ではない。 |

### `test/ci-fallback-decision.test.ts`（8件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T058 | `test/ci-fallback-decision.test.ts` | `keeps fallback disabled unless explicitly enabled` | **Cucumber候補** | CI代替検証を明示設定かつインフラ障害にだけ限定し、通常失敗を迂回しないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T059 | `test/ci-fallback-decision.test.ts` | `allows fallback for qorraq-style immediate all-job infrastructure failures` | **Cucumber候補** | CI代替検証を明示設定かつインフラ障害にだけ限定し、通常失敗を迂回しないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T060 | `test/ci-fallback-decision.test.ts` | `classifies qorraq-style immediate all-job failures as CI infrastructure failure` | **Cucumber候補** | CI代替検証を明示設定かつインフラ障害にだけ限定し、通常失敗を迂回しないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T061 | `test/ci-fallback-decision.test.ts` | `does not allow fallback for ordinary test failures` | **Cucumber候補** | CI代替検証を明示設定かつインフラ障害にだけ限定し、通常失敗を迂回しないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T062 | `test/ci-fallback-decision.test.ts` | `classifies ordinary test failures separately` | **Cucumber候補** | CI代替検証を明示設定かつインフラ障害にだけ限定し、通常失敗を迂回しないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T063 | `test/ci-fallback-decision.test.ts` | `allows fallback when logs explicitly mention billing limits` | **Cucumber候補** | CI代替検証を明示設定かつインフラ障害にだけ限定し、通常失敗を迂回しないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T064 | `test/ci-fallback-decision.test.ts` | `does not allow fallback when only one check fails immediately and another check passed` | **Cucumber候補** | CI代替検証を明示設定かつインフラ障害にだけ限定し、通常失敗を迂回しないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T065 | `test/ci-fallback-decision.test.ts` | `does not allow fallback when an immediate failure has executed job steps` | **Cucumber候補** | CI代替検証を明示設定かつインフラ障害にだけ限定し、通常失敗を迂回しないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/ci-workflow.test.ts`（8件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T066 | `test/ci-workflow.test.ts` | `runs on pull requests` | **Vitest継続** | リポジトリのCIが現行の検証コマンドと起動条件を静的に備えること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T067 | `test/ci-workflow.test.ts` | `runs on pushes to main` | **Vitest継続** | リポジトリのCIが現行の検証コマンドと起動条件を静的に備えること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T068 | `test/ci-workflow.test.ts` | `runs npm test` | **Vitest継続** | リポジトリのCIが現行の検証コマンドと起動条件を静的に備えること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T069 | `test/ci-workflow.test.ts` | `runs lint checks` | **Vitest継続** | リポジトリのCIが現行の検証コマンドと起動条件を静的に備えること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T070 | `test/ci-workflow.test.ts` | `runs TypeScript type checks` | **Vitest継続** | リポジトリのCIが現行の検証コマンドと起動条件を静的に備えること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T071 | `test/ci-workflow.test.ts` | `runs shell syntax checks` | **Vitest継続** | リポジトリのCIが現行の検証コマンドと起動条件を静的に備えること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T072 | `test/ci-workflow.test.ts` | `does not require Python automation compile checks` | **削除候補** | リポジトリのCIが現行の検証コマンドと起動条件を静的に備えること | Python製だった旧自動化の検査が無いことを固定するだけで、現行CIが必要な検査を実行する契約ではない。 |
| T073 | `test/ci-workflow.test.ts` | `runs npm pack dry run` | **Vitest継続** | リポジトリのCIが現行の検証コマンドと起動条件を静的に備えること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |

### `test/core.test.ts`（60件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T074 | `test/core.test.ts` | `identifies a linked worktree whose common git directory belongs to another checkout` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T075 | `test/core.test.ts` | `does not identify a primary checkout as a linked worktree` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T076 | `test/core.test.ts` | `uses DEADLOOP_CONFIG before default config paths` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T077 | `test/core.test.ts` | `uses the deadloop user state config before package-local config` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T078 | `test/core.test.ts` | `falls back to package-local config when user state config is missing` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T079 | `test/core.test.ts` | `normalizes project configuration defaults from public config fields` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T080 | `test/core.test.ts` | `uses standard automations when project configuration omits them` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T081 | `test/core.test.ts` | `keeps explicit empty automations disabled` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T082 | `test/core.test.ts` | `parses the supported every-N-minutes cron form` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T083 | `test/core.test.ts` | `ignores leading and trailing whitespace in supported cron schedules` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T084 | `test/core.test.ts` | `rejects unsupported cron schedules` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T085 | `test/core.test.ts` | `rejects zero-minute intervals` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T086 | `test/core.test.ts` | `returns no due slot outside the grace window` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T087 | `test/core.test.ts` | `records missed slots outside the grace window` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T088 | `test/core.test.ts` | `calculates the current cron slot` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T089 | `test/core.test.ts` | `uses the next last-scheduled slot when it is still in the future` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T090 | `test/core.test.ts` | `uses the next cron slot when the last-scheduled candidate is stale` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T091 | `test/core.test.ts` | `renders prompt templates from public template values` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T092 | `test/core.test.ts` | `builds automation script environment from the shared runtime values` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T093 | `test/core.test.ts` | `builds worker instructions from custom instruction files` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T094 | `test/core.test.ts` | `keeps explicit worker instructions above instruction files` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T095 | `test/core.test.ts` | `defaults the worker agent to pi` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T096 | `test/core.test.ts` | `preserves the pi worker agent selection` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T097 | `test/core.test.ts` | `preserves the claude worker agent selection` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T098 | `test/core.test.ts` | `rejects invalid worker agent values` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T099 | `test/core.test.ts` | `defaults the reviewer agent to pi` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T100 | `test/core.test.ts` | `preserves the claude reviewer agent selection` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T101 | `test/core.test.ts` | `rejects invalid reviewer agent values` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T102 | `test/core.test.ts` | `keeps the default worker launch policy independent of pi thinking flags` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T103 | `test/core.test.ts` | `preserves the operator-designated worker model verbatim` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T104 | `test/core.test.ts` | `preserves the operator-designated reviewer model verbatim` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T105 | `test/core.test.ts` | `exposes worker and reviewer models to prompt templates` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T106 | `test/core.test.ts` | `exposes the worker agent to prompt templates` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T107 | `test/core.test.ts` | `exposes the reviewer agent to prompt templates` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T108 | `test/core.test.ts` | `defaults auto merge to disabled` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T109 | `test/core.test.ts` | `preserves explicitly enabled auto merge` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T110 | `test/core.test.ts` | `defaults CI fallback to disabled billing-only mode` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T111 | `test/core.test.ts` | `defaults external review to disabled` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T112 | `test/core.test.ts` | `normalizes CI fallback local commands for prompt templates` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T113 | `test/core.test.ts` | `exposes auto merge state to prompt templates` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T114 | `test/core.test.ts` | `exposes external review state to prompt templates` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T115 | `test/core.test.ts` | `preserves an automation driver file from project config` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T116 | `test/core.test.ts` | `uses reloaded project settings during tick resolution` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T117 | `test/core.test.ts` | `keeps existing behavior when the trusted repo policy is absent` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T118 | `test/core.test.ts` | `uses the trusted repo policy worker model when local config omits it` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T119 | `test/core.test.ts` | `allows trusted repo policy to provide worker instruction files` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T120 | `test/core.test.ts` | `keeps the local worker model above the trusted repo policy` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T121 | `test/core.test.ts` | `accepts this repository's shared policy file` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T122 | `test/core.test.ts` | `keeps trusted repo policy explicit empty automations disabled` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T123 | `test/core.test.ts` | `allows trusted repo policy to provide locally omitted automations` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T124 | `test/core.test.ts` | `allows trusted repo policy to provide automation driver files` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T125 | `test/core.test.ts` | `uses trusted repo policy external review settings` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T126 | `test/core.test.ts` | `rejects forbidden trusted repo policy keys` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T127 | `test/core.test.ts` | `asks the repo policy provider for the configured base branch` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T128 | `test/core.test.ts` | `returns a status reason when project config cannot be parsed` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T129 | `test/core.test.ts` | `does not run a project that differs from the scheduler lock owner` | **Cucumber候補** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T130 | `test/core.test.ts` | `warns when extension source mtime is newer than module load time` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T131 | `test/core.test.ts` | `sanitizes display identifiers to lowercase slugs` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T132 | `test/core.test.ts` | `sanitizes punctuation-only identifiers to the project fallback` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T133 | `test/core.test.ts` | `sanitizes empty identifiers to the project fallback` | **Vitest継続** | 公開設定の既定値・優先順位・スケジュール・安全設定を決定論的に解釈すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |

### `test/doctor.test.ts`（27件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T134 | `test/doctor.test.ts` | `reports the blocked issue requeue command` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T135 | `test/doctor.test.ts` | `summarizes the latest blocked comment` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T136 | `test/doctor.test.ts` | `reports git status command for stale in-progress issues` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T137 | `test/doctor.test.ts` | `does not report fresh in-progress issues` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T138 | `test/doctor.test.ts` | `reports cleanup command for clean orphan linked worktrees` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T139 | `test/doctor.test.ts` | `reports confirmation command for dirty orphan linked worktrees` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T140 | `test/doctor.test.ts` | `ignores linked worktrees with an open PR` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T141 | `test/doctor.test.ts` | `reports implement label command for ready-only issues` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T142 | `test/doctor.test.ts` | `reports triage confirmation command for needs-triage issues` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T143 | `test/doctor.test.ts` | `reports full requeue command for needs-triage issues` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T144 | `test/doctor.test.ts` | `reports the precheck file check command for precheck_skipped:127` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T145 | `test/doctor.test.ts` | `reports unavailable precheck when the scheduler records a missing precheck file` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T146 | `test/doctor.test.ts` | `reports a spinning-loop finding for repeated identical failures` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T147 | `test/doctor.test.ts` | `does not report normal no-work precheck skips as spinning failures` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T148 | `test/doctor.test.ts` | `reports a stalled-coordinator finding when attempts stop for 3 slots` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T149 | `test/doctor.test.ts` | `does not report a healthy automation that just ran` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T150 | `test/doctor.test.ts` | `reports the claude workspace trust acceptance command for untrusted repos` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T151 | `test/doctor.test.ts` | `does not report workspace trust findings for trusted claude repos` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T152 | `test/doctor.test.ts` | `reports workspace trust for a claude reviewer even when the worker is pi` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T153 | `test/doctor.test.ts` | `does not report workspace trust findings for pi projects` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T154 | `test/doctor.test.ts` | `reports an inspection command when the claude config is unreadable` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T155 | `test/doctor.test.ts` | `reports a stuck reviewing claim when no reviewer agent is running` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T156 | `test/doctor.test.ts` | `does not report a reviewing claim when the reviewer agent is working` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T157 | `test/doctor.test.ts` | `reports a stuck implement claim with a worktree confirmation command when no worker is running` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T158 | `test/doctor.test.ts` | `does not report stuck claims when no claim labels are present` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T159 | `test/doctor.test.ts` | `prints no-problem message when there are no findings` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T160 | `test/doctor.test.ts` | `prints the layered config source` | **Cucumber候補** | 診断コマンドが実際の停滞・不整合を検出し、オペレーター向け復旧情報を表示すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/extract-worker-promise.test.ts`（9件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T161 | `test/extract-worker-promise.test.ts` | `accepts complete promise files` | **Vitest継続** | 作業完了ファイルの形式と状態を低レベルの抽出器が正しく検証すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T162 | `test/extract-worker-promise.test.ts` | `accepts reviewer changes_requested with structured findings` | **Vitest継続** | 作業完了ファイルの形式と状態を低レベルの抽出器が正しく検証すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T163 | `test/extract-worker-promise.test.ts` | `keeps legacy complete promises compatible` | **Vitest継続** | 作業完了ファイルの形式と状態を低レベルの抽出器が正しく検証すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T164 | `test/extract-worker-promise.test.ts` | `rejects changes_requested without findings` | **Vitest継続** | 作業完了ファイルの形式と状態を低レベルの抽出器が正しく検証すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T165 | `test/extract-worker-promise.test.ts` | `accepts blocked promise files` | **Vitest継続** | 作業完了ファイルの形式と状態を低レベルの抽出器が正しく検証すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T166 | `test/extract-worker-promise.test.ts` | `accepts argparse-style equals file arguments` | **Vitest継続** | 作業完了ファイルの形式と状態を低レベルの抽出器が正しく検証すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T167 | `test/extract-worker-promise.test.ts` | `reports none for missing promise files` | **Vitest継続** | 作業完了ファイルの形式と状態を低レベルの抽出器が正しく検証すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T168 | `test/extract-worker-promise.test.ts` | `reports invalid for malformed JSON` | **Vitest継続** | 作業完了ファイルの形式と状態を低レベルの抽出器が正しく検証すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T169 | `test/extract-worker-promise.test.ts` | `reports invalid when status is missing` | **Vitest継続** | 作業完了ファイルの形式と状態を低レベルの抽出器が正しく検証すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |

### `test/github-operations.test.ts`（5件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T170 | `test/github-operations.test.ts` | `builds label transition args` | **Vitest継続** | GitHub境界が意図した対象と引数だけで読み書きコマンドを組み立てること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T171 | `test/github-operations.test.ts` | `lists open issues` | **Vitest継続** | GitHub境界が意図した対象と引数だけで読み書きコマンドを組み立てること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T172 | `test/github-operations.test.ts` | `requests live PR merge state for conflict recovery` | **Vitest継続** | GitHub境界が意図した対象と引数だけで読み書きコマンドを組み立てること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T173 | `test/github-operations.test.ts` | `moves issue labels` | **Vitest継続** | GitHub境界が意図した対象と引数だけで読み書きコマンドを組み立てること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T174 | `test/github-operations.test.ts` | `comments on PRs` | **Vitest継続** | GitHub境界が意図した対象と引数だけで読み書きコマンドを組み立てること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |

### `test/herdr-runner.test.ts`（12件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T175 | `test/herdr-runner.test.ts` | `creates a Worker worktree through Herdr` | **Vitest継続** | Herdr実行基盤とのアダプターがコマンドと応答形式を正規化すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T176 | `test/herdr-runner.test.ts` | `normalizes a created worktree result` | **Vitest継続** | Herdr実行基盤とのアダプターがコマンドと応答形式を正規化すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T177 | `test/herdr-runner.test.ts` | `rejects a worktree result without a workspace id` | **Vitest継続** | Herdr実行基盤とのアダプターがコマンドと応答形式を正規化すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T178 | `test/herdr-runner.test.ts` | `creates a tab through Herdr` | **Vitest継続** | Herdr実行基盤とのアダプターがコマンドと応答形式を正規化すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T179 | `test/herdr-runner.test.ts` | `ignores Herdr command ids when parsing created tab ids` | **Vitest継続** | Herdr実行基盤とのアダプターがコマンドと応答形式を正規化すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T180 | `test/herdr-runner.test.ts` | `starts an agent through Herdr` | **Vitest継続** | Herdr実行基盤とのアダプターがコマンドと応答形式を正規化すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T181 | `test/herdr-runner.test.ts` | `lists normalized worktrees` | **Vitest継続** | Herdr実行基盤とのアダプターがコマンドと応答形式を正規化すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T182 | `test/herdr-runner.test.ts` | `parses JSON from the supplied text runner` | **Vitest継続** | Herdr実行基盤とのアダプターがコマンドと応答形式を正規化すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T183 | `test/herdr-runner.test.ts` | `normalizes agent lifecycle fields` | **Vitest継続** | Herdr実行基盤とのアダプターがコマンドと応答形式を正規化すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T184 | `test/herdr-runner.test.ts` | `removes a finished agent through Herdr` | **Vitest継続** | Herdr実行基盤とのアダプターがコマンドと応答形式を正規化すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T185 | `test/herdr-runner.test.ts` | `removes a worktree through Herdr` | **Vitest継続** | Herdr実行基盤とのアダプターがコマンドと応答形式を正規化すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |
| T186 | `test/herdr-runner.test.ts` | `normalizes fixture worktree records` | **Vitest継続** | Herdr実行基盤とのアダプターがコマンドと応答形式を正規化すること | 小さな変換・解析・コマンド境界の低レベル契約であり、失敗箇所を絞れるVitestの単体／統合テストが適する。 |

### `test/issue-coordinator-cleanup.test.ts`（22件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T187 | `test/issue-coordinator-cleanup.test.ts` | `selects a clean matching worktree for a merged PR` | **Cucumber候補** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T188 | `test/issue-coordinator-cleanup.test.ts` | `does not select a dirty matching worktree` | **Cucumber候補** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T189 | `test/issue-coordinator-cleanup.test.ts` | `ignores generated deadloop artifacts when selecting cleanup candidates` | **Cucumber候補** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T190 | `test/issue-coordinator-cleanup.test.ts` | `does not delete a tracked .deadloop file during cleanup` | **Cucumber候補** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T191 | `test/issue-coordinator-cleanup.test.ts` | `does not delete a tracked .pi-subagents file during cleanup` | **Cucumber候補** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T192 | `test/issue-coordinator-cleanup.test.ts` | `reports why tracked runtime-named files block cleanup` | **Cucumber候補** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T193 | `test/issue-coordinator-cleanup.test.ts` | `does not remove the workspace when tracked runtime-named files block cleanup` | **Cucumber候補** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T194 | `test/issue-coordinator-cleanup.test.ts` | `removes a workspace after deleting only untracked runtime artifacts` | **Cucumber候補** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T195 | `test/issue-coordinator-cleanup.test.ts` | `does not select a Herdr worktree without a workspace id` | **Cucumber候補** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T196 | `test/issue-coordinator-cleanup.test.ts` | `does not select the main workspace for cleanup` | **Cucumber候補** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T197 | `test/issue-coordinator-cleanup.test.ts` | `does not select a worktree outside the configured root` | **Cucumber候補** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T198 | `test/issue-coordinator-cleanup.test.ts` | `wakes the coordinator for cleanup when no issue is required` | **Cucumber候補** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T199 | `test/issue-coordinator-cleanup.test.ts` | `passes a unique worker agent name to deterministic launch` | **Vitest継続** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T200 | `test/issue-coordinator-cleanup.test.ts` | `creates a dedicated tab before monitoring a worker` | **Vitest継続** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T201 | `test/issue-coordinator-cleanup.test.ts` | `keeps worker launch out of the monitoring prompt` | **Vitest継続** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T202 | `test/issue-coordinator-cleanup.test.ts` | `does not document workspace split startup for workers` | **Vitest継続** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T203 | `test/issue-coordinator-cleanup.test.ts` | `creates a dedicated tab before starting a review worker` | **Vitest継続** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T204 | `test/issue-coordinator-cleanup.test.ts` | `forwards the dedicated tab to the launcher for review agents` | **Vitest継続** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T205 | `test/issue-coordinator-cleanup.test.ts` | `does not document workspace split startup for review workers` | **Vitest継続** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T206 | `test/issue-coordinator-cleanup.test.ts` | `hands the shared session uuid to the promise path` | **Vitest継続** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T207 | `test/issue-coordinator-cleanup.test.ts` | `keeps the promise file as the worker completion authority` | **Cucumber候補** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T208 | `test/issue-coordinator-cleanup.test.ts` | `documents dedicated tab startup for branch update workers` | **Vitest継続** | 完了済み作業領域だけを選び、追跡対象や汚れた作業を消さずに安全に片付けること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |

### `test/issue-coordinator-driver.test.ts`（16件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T209 | `test/issue-coordinator-driver.test.ts` | `skips candidate-free runs` | **Cucumber候補** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T210 | `test/issue-coordinator-driver.test.ts` | `completes cleanup-only runs deterministically` | **Cucumber候補** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T211 | `test/issue-coordinator-driver.test.ts` | `handles contract-missing issues without an LLM prompt` | **Cucumber候補** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T212 | `test/issue-coordinator-driver.test.ts` | `renders contract-missing guidance` | **Cucumber候補** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T213 | `test/issue-coordinator-driver.test.ts` | `renders blocked comments for planning issues` | **Cucumber候補** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T214 | `test/issue-coordinator-driver.test.ts` | `does not block implementable issues that only reference a PRD document path` | **Cucumber候補** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T215 | `test/issue-coordinator-driver.test.ts` | `launches ready issues deterministically before monitoring` | **Cucumber候補** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T216 | `test/issue-coordinator-driver.test.ts` | `reports the deterministic Worker name` | **Vitest継続** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T217 | `test/issue-coordinator-driver.test.ts` | `does not ask the LLM to run launch-agent` | **Vitest継続** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T218 | `test/issue-coordinator-driver.test.ts` | `keeps promise files as the worker completion authority` | **Cucumber候補** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T219 | `test/issue-coordinator-driver.test.ts` | `reports the deterministic worker promise path outside the worktree` | **Vitest継続** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T220 | `test/issue-coordinator-driver.test.ts` | `isolates runtime artifacts during monitor validation` | **Cucumber候補** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T221 | `test/issue-coordinator-driver.test.ts` | `preserves the validation gate before PR creation` | **Cucumber候補** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T222 | `test/issue-coordinator-driver.test.ts` | `receives worker agent settings from the shared automation environment` | **Vitest継続** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T223 | `test/issue-coordinator-driver.test.ts` | `receives worker model settings from the shared automation environment` | **Vitest継続** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T224 | `test/issue-coordinator-driver.test.ts` | `uses the TypeScript renderer for blocked comments` | **Vitest継続** | Issueの状態に応じて停止・案内・作業開始・監視へ一意に遷移すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |

### `test/issue-coordinator-flow.test.ts`（5件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T225 | `test/issue-coordinator-flow.test.ts` | `plans no-candidate when the decision has no selected issue` | **Vitest継続** | Issue調整の入力状態を内部の計画結果へ変換すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T226 | `test/issue-coordinator-flow.test.ts` | `plans contract-missing before Worker launch` | **Vitest継続** | Issue調整の入力状態を内部の計画結果へ変換すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T227 | `test/issue-coordinator-flow.test.ts` | `plans planning issues as blocked before Worker launch` | **Vitest継続** | Issue調整の入力状態を内部の計画結果へ変換すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T228 | `test/issue-coordinator-flow.test.ts` | `plans Worker launch for implementable issues` | **Vitest継続** | Issue調整の入力状態を内部の計画結果へ変換すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T229 | `test/issue-coordinator-flow.test.ts` | `does not block implementable issues that only reference a PRD document path` | **Vitest継続** | Issue調整の入力状態を内部の計画結果へ変換すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |

### `test/issue-coordinator-renderers.test.ts`（13件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T230 | `test/issue-coordinator-renderers.test.ts` | `renders the blocked issue incident section` | **Cucumber候補** | Issueコメントと作業指示の表示内容を安全に組み立てること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T231 | `test/issue-coordinator-renderers.test.ts` | `renders the blocked issue recovery section` | **Cucumber候補** | Issueコメントと作業指示の表示内容を安全に組み立てること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T232 | `test/issue-coordinator-renderers.test.ts` | `orders the blocked incident section before recovery` | **Cucumber候補** | Issueコメントと作業指示の表示内容を安全に組み立てること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T233 | `test/issue-coordinator-renderers.test.ts` | `quotes blocked comment shell arguments that contain spaces` | **Cucumber候補** | Issueコメントと作業指示の表示内容を安全に組み立てること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T234 | `test/issue-coordinator-renderers.test.ts` | `renders the blocked issue requeue command` | **Cucumber候補** | Issueコメントと作業指示の表示内容を安全に組み立てること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T235 | `test/issue-coordinator-renderers.test.ts` | `renders the worker issue target` | **Vitest継続** | Issueコメントと作業指示の表示内容を安全に組み立てること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T236 | `test/issue-coordinator-renderers.test.ts` | `renders the worker implementation contract` | **Vitest継続** | Issueコメントと作業指示の表示内容を安全に組み立てること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T237 | `test/issue-coordinator-renderers.test.ts` | `renders worker prohibitions` | **Vitest継続** | Issueコメントと作業指示の表示内容を安全に組み立てること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T238 | `test/issue-coordinator-renderers.test.ts` | `renders the worker validation command` | **Vitest継続** | Issueコメントと作業指示の表示内容を安全に組み立てること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T239 | `test/issue-coordinator-renderers.test.ts` | `renders the isolated project validation command when provided` | **Vitest継続** | Issueコメントと作業指示の表示内容を安全に組み立てること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T240 | `test/issue-coordinator-renderers.test.ts` | `uses a safe worker validation fence for longer backtick runs` | **Vitest継続** | Issueコメントと作業指示の表示内容を安全に組み立てること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T241 | `test/issue-coordinator-renderers.test.ts` | `renders the worker promise file contract` | **Vitest継続** | Issueコメントと作業指示の表示内容を安全に組み立てること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T242 | `test/issue-coordinator-renderers.test.ts` | `keeps the prompt-based coordinator pointed at the deterministic renderers` | **Vitest継続** | Issueコメントと作業指示の表示内容を安全に組み立てること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |

### `test/issue-coordinator-selection.test.ts`（8件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T243 | `test/issue-coordinator-selection.test.ts` | `selects an issue labeled ready-for-agent and agent:implement` | **Cucumber候補** | 公開ラベルと依存関係から着手可能なIssueだけを選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T244 | `test/issue-coordinator-selection.test.ts` | `skips issues with the in-progress label` | **Cucumber候補** | 公開ラベルと依存関係から着手可能なIssueだけを選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T245 | `test/issue-coordinator-selection.test.ts` | `skips issues with an open dependency from the body` | **Cucumber候補** | 公開ラベルと依存関係から着手可能なIssueだけを選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T246 | `test/issue-coordinator-selection.test.ts` | `selects issues once the body dependency is closed` | **Cucumber候補** | 公開ラベルと依存関係から着手可能なIssueだけを選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T247 | `test/issue-coordinator-selection.test.ts` | `skips issues with an open GitHub relationship dependency` | **Cucumber候補** | 公開ラベルと依存関係から着手可能なIssueだけを選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T248 | `test/issue-coordinator-selection.test.ts` | `skips issues with an open final dependency section` | **Cucumber候補** | 公開ラベルと依存関係から着手可能なIssueだけを選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T249 | `test/issue-coordinator-selection.test.ts` | `shows CLI help without requiring a repo` | **Vitest継続** | 公開ラベルと依存関係から着手可能なIssueだけを選ぶこと | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T250 | `test/issue-coordinator-selection.test.ts` | `rejects unknown CLI flags` | **Vitest継続** | 公開ラベルと依存関係から着手可能なIssueだけを選ぶこと | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |

### `test/launch-agent-integration.test.ts`（4件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T251 | `test/launch-agent-integration.test.ts` | `passes the pi launch argv to herdr without a shell` | **Cucumber候補** | 入力をシェル展開せず保持し、信頼確認に従って実行基盤への起動を許可すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T252 | `test/launch-agent-integration.test.ts` | `delivers a prompt containing shell metacharacters as one intact argument` | **Cucumber候補** | 入力をシェル展開せず保持し、信頼確認に従って実行基盤への起動を許可すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T253 | `test/launch-agent-integration.test.ts` | `does not start herdr when claude workspace trust is confirmed unaccepted` | **Cucumber候補** | 入力をシェル展開せず保持し、信頼確認に従って実行基盤への起動を許可すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T254 | `test/launch-agent-integration.test.ts` | `starts herdr anyway when claude workspace trust cannot be determined` | **Cucumber候補** | 入力をシェル展開せず保持し、信頼確認に従って実行基盤への起動を許可すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/launch-agent-template.test.ts`（7件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T255 | `test/launch-agent-template.test.ts` | `launches workers deterministically before issue coordinator monitoring` | **Vitest継続** | 自動化テンプレートが現行の起動経路だけを静的に参照すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T256 | `test/launch-agent-template.test.ts` | `launches the review agent through launch-agent in the pr reviewer` | **Vitest継続** | 自動化テンプレートが現行の起動経路だけを静的に参照すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T257 | `test/launch-agent-template.test.ts` | `selects the review agent kind from the reviewerAgent template value` | **Vitest継続** | 自動化テンプレートが現行の起動経路だけを静的に参照すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T258 | `test/launch-agent-template.test.ts` | `keeps no hard-coded pi agent kind in the pr reviewer launch` | **Vitest継続** | 自動化テンプレートが現行の起動経路だけを静的に参照すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T259 | `test/launch-agent-template.test.ts` | `keeps no raw agent-start launch branch in the issue coordinator` | **Vitest継続** | 自動化テンプレートが現行の起動経路だけを静的に参照すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T260 | `test/launch-agent-template.test.ts` | `keeps no raw agent-start launch branch in the pr reviewer` | **Vitest継続** | 自動化テンプレートが現行の起動経路だけを静的に参照すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T261 | `test/launch-agent-template.test.ts` | `keeps issue coordinator fallback focused on the driver` | **Vitest継続** | 自動化テンプレートが現行の起動経路だけを静的に参照すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |

### `test/monitor-prompts.test.ts`（6件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T262 | `test/monitor-prompts.test.ts` | `renders shared promise polling rules for Worker monitoring` | **Vitest継続** | 監視指示がIssue・PRの安全な完了、修正、ラベル維持を要求すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T263 | `test/monitor-prompts.test.ts` | `renders issue-specific completion instructions` | **Vitest継続** | 監視指示がIssue・PRの安全な完了、修正、ラベル維持を要求すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T264 | `test/monitor-prompts.test.ts` | `keeps manual issue close forbidden` | **Cucumber候補** | 監視指示がIssue・PRの安全な完了、修正、ラベル維持を要求すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T265 | `test/monitor-prompts.test.ts` | `renders reviewer-specific completion instructions` | **Vitest継続** | 監視指示がIssue・PRの安全な完了、修正、ラベル維持を要求すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T266 | `test/monitor-prompts.test.ts` | `routes reviewer changes_requested through the repair dispatcher` | **Cucumber候補** | 監視指示がIssue・PRの安全な完了、修正、ラベル維持を要求すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T267 | `test/monitor-prompts.test.ts` | `keeps review labels through successful repair monitoring` | **Cucumber候補** | 監視指示がIssue・PRの安全な完了、修正、ラベル維持を要求すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/package-manifest.test.ts`（11件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T268 | `test/package-manifest.test.ts` | `uses the deadloop package name` | **Vitest継続** | npm/Pi配布物の名前、検証コマンド、収録ファイルが現行パッケージ定義に一致すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T269 | `test/package-manifest.test.ts` | `describes the public product name` | **Vitest継続** | npm/Pi配布物の名前、検証コマンド、収録ファイルが現行パッケージ定義に一致すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T270 | `test/package-manifest.test.ts` | `defines a local lint command` | **Vitest継続** | npm/Pi配布物の名前、検証コマンド、収録ファイルが現行パッケージ定義に一致すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T271 | `test/package-manifest.test.ts` | `defines a conventional check command` | **Vitest継続** | npm/Pi配布物の名前、検証コマンド、収録ファイルが現行パッケージ定義に一致すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T272 | `test/package-manifest.test.ts` | `defines a no-emit typecheck command` | **Vitest継続** | npm/Pi配布物の名前、検証コマンド、収録ファイルが現行パッケージ定義に一致すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T273 | `test/package-manifest.test.ts` | `uses Biome for lightweight static and formatting checks` | **Vitest継続** | npm/Pi配布物の名前、検証コマンド、収録ファイルが現行パッケージ定義に一致すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T274 | `test/package-manifest.test.ts` | `uses TypeScript for type checking` | **Vitest継続** | npm/Pi配布物の名前、検証コマンド、収録ファイルが現行パッケージ定義に一致すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T275 | `test/package-manifest.test.ts` | `includes public setup documentation` | **Vitest継続** | npm/Pi配布物の名前、検証コマンド、収録ファイルが現行パッケージ定義に一致すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T276 | `test/package-manifest.test.ts` | `includes README image assets` | **Vitest継続** | npm/Pi配布物の名前、検証コマンド、収録ファイルが現行パッケージ定義に一致すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T277 | `test/package-manifest.test.ts` | `includes the example project config` | **Vitest継続** | npm/Pi配布物の名前、検証コマンド、収録ファイルが現行パッケージ定義に一致すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T278 | `test/package-manifest.test.ts` | `does not include package-local project config` | **Vitest継続** | npm/Pi配布物の名前、検証コマンド、収録ファイルが現行パッケージ定義に一致すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |

### `test/pr-branch-update-decision.test.ts`（6件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T279 | `test/pr-branch-update-decision.test.ts` | `does not update a head that already contains the base` | **Cucumber候補** | PRのhead/base状態に応じ、安全な機械更新・委譲・停止を選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T280 | `test/pr-branch-update-decision.test.ts` | `updates mechanically when the head can fast-forward to the base` | **Cucumber候補** | PRのhead/base状態に応じ、安全な機械更新・委譲・停止を選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T281 | `test/pr-branch-update-decision.test.ts` | `updates mechanically when a diverged head merges cleanly` | **Cucumber候補** | PRのhead/base状態に応じ、安全な機械更新・委譲・停止を選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T282 | `test/pr-branch-update-decision.test.ts` | `delegates one worker when the branch update conflicts` | **Cucumber候補** | PRのhead/base状態に応じ、安全な機械更新・委譲・停止を選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T283 | `test/pr-branch-update-decision.test.ts` | `blocks mechanical updates from a dirty worktree` | **Cucumber候補** | PRのhead/base状態に応じ、安全な機械更新・委譲・停止を選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T284 | `test/pr-branch-update-decision.test.ts` | `blocks mechanical updates from a stale head` | **Cucumber候補** | PRのhead/base状態に応じ、安全な機械更新・委譲・停止を選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/pr-branch-update-safety.test.ts`（8件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T285 | `test/pr-branch-update-safety.test.ts` | `derives the same retry key for the same exact pair` | **Vitest継続** | ブランチ更新が検証と直前head確認を経て、対象ブランチへ非強制でだけ送信されること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T286 | `test/pr-branch-update-safety.test.ts` | `recognizes a persisted exact-pair attempt marker` | **Vitest継続** | ブランチ更新が検証と直前head確認を経て、対象ブランチへ非強制でだけ送信されること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T287 | `test/pr-branch-update-safety.test.ts` | `allows a new attempt when the base head changes` | **Vitest継続** | ブランチ更新が検証と直前head確認を経て、対象ブランチへ非強制でだけ送信されること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T288 | `test/pr-branch-update-safety.test.ts` | `stops a stale PR head without authorizing push` | **Cucumber候補** | ブランチ更新が検証と直前head確認を経て、対象ブランチへ非強制でだけ送信されること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T289 | `test/pr-branch-update-safety.test.ts` | `treats a cross-repository target as unsafe` | **Cucumber候補** | ブランチ更新が検証と直前head確認を経て、対象ブランチへ非強制でだけ送信されること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T290 | `test/pr-branch-update-safety.test.ts` | `runs the configured check before querying the PR head` | **Cucumber候補** | ブランチ更新が検証と直前head確認を経て、対象ブランチへ非強制でだけ送信されること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T291 | `test/pr-branch-update-safety.test.ts` | `pushes only the selected existing branch without force` | **Cucumber候補** | ブランチ更新が検証と直前head確認を経て、対象ブランチへ非強制でだけ送信されること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T292 | `test/pr-branch-update-safety.test.ts` | `does not push when the immediate PR-head check is stale` | **Cucumber候補** | ブランチ更新が検証と直前head確認を経て、対象ブランチへ非強制でだけ送信されること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/pr-review-repair-dispatch.integration.test.ts`（1件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T293 | `test/pr-review-repair-dispatch.integration.test.ts` | `launches a dedicated repair worker and returns its bounded monitor` | **Cucumber候補** | 構造化された指摘を専用の有界な修正作業へ引き渡し、監視へ戻すこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/pr-review-repair.test.ts`（13件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T294 | `test/pr-review-repair.test.ts` | `selects a first repair for an exact head and review result` | **Cucumber候補** | 自動修正を一回に制限し、反復・技術失敗・古いheadでは人間対応または安全停止すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T295 | `test/pr-review-repair.test.ts` | `persists the exact head and review fingerprint attempt` | **Vitest継続** | 自動修正を一回に制限し、反復・技術失敗・古いheadでは人間対応または安全停止すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T296 | `test/pr-review-repair.test.ts` | `requires a human when the same findings recur after repair` | **Cucumber候補** | 自動修正を一回に制限し、反復・技術失敗・古いheadでは人間対応または安全停止すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T297 | `test/pr-review-repair.test.ts` | `retries the first technical reviewer failure without human blocking` | **Cucumber候補** | 自動修正を一回に制限し、反復・技術失敗・古いheadでは人間対応または安全停止すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T298 | `test/pr-review-repair.test.ts` | `human-blocks only after the bounded technical retry is exhausted` | **Cucumber候補** | 自動修正を一回に制限し、反復・技術失敗・古いheadでは人間対応または安全停止すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T299 | `test/pr-review-repair.test.ts` | `counts only technical failures for the exact PR head` | **Vitest継続** | 自動修正を一回に制限し、反復・技術失敗・古いheadでは人間対応または安全停止すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T300 | `test/pr-review-repair.test.ts` | `passes #243-style lint findings as the repair worker's bounded contract` | **Vitest継続** | 自動修正を一回に制限し、反復・技術失敗・古いheadでは人間対応または安全停止すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T301 | `test/pr-review-repair.test.ts` | `forbids scope widening in the repair worker prompt` | **Cucumber候補** | 自動修正を一回に制限し、反復・技術失敗・古いheadでは人間対応または安全停止すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T302 | `test/pr-review-repair.test.ts` | `forbids direct pushes from the repair worker` | **Cucumber候補** | 自動修正を一回に制限し、反復・技術失敗・古いheadでは人間対応または安全停止すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T303 | `test/pr-review-repair.test.ts` | `stops a stale repair without authorizing push` | **Cucumber候補** | 自動修正を一回に制限し、反復・技術失敗・古いheadでは人間対応または安全停止すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T304 | `test/pr-review-repair.test.ts` | `runs configured checks before the immediate PR head recheck` | **Cucumber候補** | 自動修正を一回に制限し、反復・技術失敗・古いheadでは人間対応または安全停止すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T305 | `test/pr-review-repair.test.ts` | `pushes only the exact existing branch without force` | **Cucumber候補** | 自動修正を一回に制限し、反復・技術失敗・古いheadでは人間対応または安全停止すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T306 | `test/pr-review-repair.test.ts` | `does not push after a stale immediate head recheck` | **Cucumber候補** | 自動修正を一回に制限し、反復・技術失敗・古いheadでは人間対応または安全停止すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/pr-reviewer-driver.test.ts`（18件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T307 | `test/pr-reviewer-driver.test.ts` | `skips candidate-free runs` | **Cucumber候補** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T308 | `test/pr-reviewer-driver.test.ts` | `skips pending CI without sending a review prompt` | **Cucumber候補** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T309 | `test/pr-reviewer-driver.test.ts` | `launches reviewer by default without external review` | **Cucumber候補** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T310 | `test/pr-reviewer-driver.test.ts` | `waits for fresh external review when external review is enabled` | **Cucumber候補** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T311 | `test/pr-reviewer-driver.test.ts` | `requests external review deterministically when external review is enabled` | **Cucumber候補** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T312 | `test/pr-reviewer-driver.test.ts` | `renders a blocked comment for draft PRs` | **Cucumber候補** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T313 | `test/pr-reviewer-driver.test.ts` | `launches stale external-review fallback deterministically before monitoring` | **Cucumber候補** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T314 | `test/pr-reviewer-driver.test.ts` | `reports the deterministic reviewer promise path outside the worktree` | **Vitest継続** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T315 | `test/pr-reviewer-driver.test.ts` | `isolates runtime artifacts during reviewer monitor validation` | **Cucumber候補** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T316 | `test/pr-reviewer-driver.test.ts` | `preserves autoMerge=false safety after deterministic reviewer launch` | **Cucumber候補** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T317 | `test/pr-reviewer-driver.test.ts` | `does not ask the LLM to run launch-agent` | **Vitest継続** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T318 | `test/pr-reviewer-driver.test.ts` | `routes a merge conflict to one dedicated branch-update worker` | **Cucumber候補** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T319 | `test/pr-reviewer-driver.test.ts` | `uses a deterministic retry-key worker name for the exact head/base pair` | **Vitest継続** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T320 | `test/pr-reviewer-driver.test.ts` | `preserves both review labels during branch update` | **Cucumber候補** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T321 | `test/pr-reviewer-driver.test.ts` | `bounds branch update push through the deterministic finalizer` | **Cucumber候補** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T322 | `test/pr-reviewer-driver.test.ts` | `returns an updated conflict branch to normal review` | **Cucumber候補** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T323 | `test/pr-reviewer-driver.test.ts` | `blocks a second attempt for the exact same head/base pair` | **Cucumber候補** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T324 | `test/pr-reviewer-driver.test.ts` | `reports the deterministic reviewer name` | **Vitest継続** | PR・CI・外部レビュー・競合の状態から、安全なレビュー処理へ遷移すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |

### `test/pr-reviewer-flow.test.ts`（6件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T325 | `test/pr-reviewer-flow.test.ts` | `plans no-candidate when no PR is selectable` | **Vitest継続** | PRレビュー入力を内部の計画結果へ変換すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T326 | `test/pr-reviewer-flow.test.ts` | `plans waiting when checks are pending` | **Vitest継続** | PRレビュー入力を内部の計画結果へ変換すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T327 | `test/pr-reviewer-flow.test.ts` | `plans draft gate before review launch` | **Vitest継続** | PRレビュー入力を内部の計画結果へ変換すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T328 | `test/pr-reviewer-flow.test.ts` | `plans reviewer launch by default without external review` | **Vitest継続** | PRレビュー入力を内部の計画結果へ変換すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T329 | `test/pr-reviewer-flow.test.ts` | `plans external review request when external review is enabled` | **Vitest継続** | PRレビュー入力を内部の計画結果へ変換すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T330 | `test/pr-reviewer-flow.test.ts` | `plans reviewer launch after stale external review` | **Vitest継続** | PRレビュー入力を内部の計画結果へ変換すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |

### `test/pr-reviewer-precheck.test.ts`（18件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T331 | `test/pr-reviewer-precheck.test.ts` | `selects a PR labeled agent:review` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T332 | `test/pr-reviewer-precheck.test.ts` | `skips ready-for-human-only PRs when auto merge is disabled` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T333 | `test/pr-reviewer-precheck.test.ts` | `selects ready-for-human-only PRs when auto merge is enabled` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T334 | `test/pr-reviewer-precheck.test.ts` | `skips PRs while checks are pending` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T335 | `test/pr-reviewer-precheck.test.ts` | `selects PRs after the external-review marker is stale` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T336 | `test/pr-reviewer-precheck.test.ts` | `selects PRs with fresh external review markers when external review is disabled` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T337 | `test/pr-reviewer-precheck.test.ts` | `skips PRs while a Copilot review request is fresh when external review is enabled` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T338 | `test/pr-reviewer-precheck.test.ts` | `skips PRs while CodeRabbit is processing when external review is enabled` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T339 | `test/pr-reviewer-precheck.test.ts` | `starts the automation for draft PRs so the draft gate can block them` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T340 | `test/pr-reviewer-precheck.test.ts` | `requests external review when the marker is missing` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T341 | `test/pr-reviewer-precheck.test.ts` | `waits for external review while the marker is fresh` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T342 | `test/pr-reviewer-precheck.test.ts` | `falls back after the external-review marker is stale` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T343 | `test/pr-reviewer-precheck.test.ts` | `rejects invalid decision modes` | **Vitest継続** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T344 | `test/pr-reviewer-precheck.test.ts` | `rejects invalid external review wait seconds` | **Vitest継続** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T345 | `test/pr-reviewer-precheck.test.ts` | `rejects non-ISO now timestamps` | **Vitest継続** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T346 | `test/pr-reviewer-precheck.test.ts` | `reclaims a stale reviewing PR when no reviewer agent is running` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T347 | `test/pr-reviewer-precheck.test.ts` | `skips a reviewing PR while its reviewer agent is working` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T348 | `test/pr-reviewer-precheck.test.ts` | `skips PRs with the blocked label` | **Cucumber候補** | レビュー可能なPRだけを選び、待機・下書き・停止中の対象を安全に除外すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/pr-reviewer-relaunch-integration.test.ts`（1件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T349 | `test/pr-reviewer-relaunch-integration.test.ts` | `retires the finished reviewer before relaunching the same PR after it is requeued` | **Cucumber候補** | 再投入されたPRで完了済みレビュー担当を片付けてから一度だけ再起動すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/pr-reviewer-stale-reclaim.test.ts`（7件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T350 | `test/pr-reviewer-stale-reclaim.test.ts` | `reclaims a reviewing PR when no reviewer agent is running` | **Cucumber候補** | 実働担当がいない古いレビュー占有だけを回収し、稼働中または停止中のPRを奪わないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T351 | `test/pr-reviewer-stale-reclaim.test.ts` | `marks the reclaimed reviewing PR as a stale reclaim` | **Cucumber候補** | 実働担当がいない古いレビュー占有だけを回収し、稼働中または停止中のPRを奪わないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T352 | `test/pr-reviewer-stale-reclaim.test.ts` | `skips a reviewing PR while its reviewer agent is working` | **Cucumber候補** | 実働担当がいない古いレビュー占有だけを回収し、稼働中または停止中のPRを奪わないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T353 | `test/pr-reviewer-stale-reclaim.test.ts` | `skips a reviewing PR while its branch-update worker is working` | **Cucumber候補** | 実働担当がいない古いレビュー占有だけを回収し、稼働中または停止中のPRを奪わないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T354 | `test/pr-reviewer-stale-reclaim.test.ts` | `reclaims a reviewing PR when its reviewer agent is present but idle` | **Cucumber候補** | 実働担当がいない古いレビュー占有だけを回収し、稼働中または停止中のPRを奪わないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T355 | `test/pr-reviewer-stale-reclaim.test.ts` | `keeps skipping blocked PRs regardless of reviewer agents` | **Cucumber候補** | 実働担当がいない古いレビュー占有だけを回収し、稼働中または停止中のPRを奪わないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T356 | `test/pr-reviewer-stale-reclaim.test.ts` | `does not flag an ordinary review PR as a stale reclaim` | **Cucumber候補** | 実働担当がいない古いレビュー占有だけを回収し、稼働中または停止中のPRを奪わないこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/project-check.test.ts`（9件、移行済み）

| ID | 現在のテスト名 | 移行先シナリオ |
|---:|---|---|
| T357 | `does not expose deadloop runtime artifacts to recursive JSON validation` | `未追跡の実行時成果物を隔離して再帰的な検証を成功させる` |
| T358 | `still fails recursive JSON validation for a tracked product file` | `Git 管理された製品ファイルは再帰的な検証で失敗する` |
| T359 | `fails closed instead of hiding a tracked file in a runtime directory` | 「`.deadloop` に Git 管理ファイルがある場合は安全停止する」 |
| T360 | `restores promise evidence after a failed check` | `失敗した自動チェック後に完了報告を復元する` |
| T361 | `restores subagent diagnostics after a timed-out check` | `時間切れの自動チェック後に診断情報を復元する` |
| T362 | `bounds a timed-out check that ignores SIGTERM` | `終了要求を無視した時間切れの自動チェックを停止する` |
| T363 | `restores artifacts after forcing a timed-out check to stop` | `強制停止した時間切れの自動チェック後に診断情報を復元する` |
| T364 | `restores runtime artifacts when the CLI is interrupted` | `CLI を中断した後に診断情報を復元する` |
| T365 | `reports an interrupted check without losing restoration control` | `中断した自動チェックは中断として報告する` |

#### T357-T365 の移行確認記録

2026-07-23 に、削除前の `test/project-check.test.ts` を残した状態で `npm test` を実行し、Vitest の対象9件を含む496件と Cucumber の11シナリオ（55ステップ）がすべて成功した（Vitest 2.05秒、Cucumber 0.473秒）。

続いて `完了報告は元の内容で復元される` の期待値だけを一時的に `intentionally broken` へ変更し、`npx cucumber-js --name '^失敗した自動チェック後に完了報告を復元する$'` を実行した。対象シナリオは終了コード1となり、`acceptance/features/project-check-safety.feature.md:41` とステップ定義の位置、および実際値 `pending` と誤った期待値 `intentionally broken` の差を表示して失敗した。期待値を元へ戻した後に同じコマンドを再実行し、1シナリオ、5ステップが成功した（0.72秒）。この確認後に、置換済みのVitest 9件を削除した。

### `test/promise-file-contract.test.ts`（6件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T366 | `test/promise-file-contract.test.ts` | `removes the legacy promise text tag` | **削除候補** | 作業完了の正本を一意な作業完了ファイルに限定すること | 廃止したテキストタグの不存在だけを固定する移行履歴で、現行の完了ファイル契約は別ケースで守られている。 |
| T367 | `test/promise-file-contract.test.ts` | `removes JSONL session extraction` | **削除候補** | 作業完了の正本を一意な作業完了ファイルに限定すること | 廃止したセッション抽出方式の不存在だけを固定する移行履歴で、現行の完了判定を直接保証しない。 |
| T368 | `test/promise-file-contract.test.ts` | `removes pane-id based helper input` | **削除候補** | 作業完了の正本を一意な作業完了ファイルに限定すること | 廃止したpane識別子入力の不存在だけを固定する移行履歴で、現行の完了判定を直接保証しない。 |
| T369 | `test/promise-file-contract.test.ts` | `documents unique promise file allocation outside the worktree` | **Cucumber候補** | 作業完了の正本を一意な作業完了ファイルに限定すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T370 | `test/promise-file-contract.test.ts` | `requires blocked workers to write a promise file` | **Cucumber候補** | 作業完了の正本を一意な作業完了ファイルに限定すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T371 | `test/promise-file-contract.test.ts` | `uses the promise file as the completion authority` | **Cucumber候補** | 作業完了の正本を一意な作業完了ファイルに限定すること | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/prompt-budget.test.ts`（2件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T372 | `test/prompt-budget.test.ts` | `issue-coordinator.prompt.md stays within its prompt budget (current approx 1.6k chars)` | **Vitest継続** | 自動化プロンプトを定めた文字数上限内に保つこと | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T373 | `test/prompt-budget.test.ts` | `pr-reviewer.prompt.md stays within its prompt budget (current approx 3.0k chars)` | **Vitest継続** | 自動化プロンプトを定めた文字数上限内に保つこと | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |

### `test/prompt-template-integrity.test.ts`（1件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T374 | `test/prompt-template-integrity.test.ts` | `provides template values for every prompt placeholder` | **Vitest継続** | 全プロンプトの置換項目に対応する値が静的に提供されること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |

### `test/skill-package.test.ts`（4件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T375 | `test/skill-package.test.ts` | `declares bundled Pi skills in the package manifest` | **Vitest継続** | Agent Skillsとして必要なメタデータと導入案内をパッケージに収録すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T376 | `test/skill-package.test.ts` | `includes skills in the npm package file list` | **Vitest継続** | Agent Skillsとして必要なメタデータと導入案内をパッケージに収録すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T377 | `test/skill-package.test.ts` | `provides Agent Skills frontmatter` | **Vitest継続** | Agent Skillsとして必要なメタデータと導入案内をパッケージに収録すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T378 | `test/skill-package.test.ts` | `makes the Pi package activation step explicit` | **Vitest継続** | Agent Skillsとして必要なメタデータと導入案内をパッケージに収録すること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |

### `test/status-report.test.ts`（8件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T379 | `test/status-report.test.ts` | `resolves the active project from the configured repository path` | **Vitest継続** | 状態表示が対象Issue、PR、作業領域、警告、設定元をオペレーターへ示すこと | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T380 | `test/status-report.test.ts` | `shows when there are no eligible issues` | **Cucumber候補** | 状態表示が対象Issue、PR、作業領域、警告、設定元をオペレーターへ示すこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T381 | `test/status-report.test.ts` | `shows the review target PR` | **Cucumber候補** | 状態表示が対象Issue、PR、作業領域、警告、設定元をオペレーターへ示すこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T382 | `test/status-report.test.ts` | `shows the cleanup candidate worktree` | **Cucumber候補** | 状態表示が対象Issue、PR、作業領域、警告、設定元をオペレーターへ示すこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T383 | `test/status-report.test.ts` | `shows active Herdr worker worktrees with workspace ids` | **Cucumber候補** | 状態表示が対象Issue、PR、作業領域、警告、設定元をオペレーターへ示すこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T384 | `test/status-report.test.ts` | `shows extension code freshness warnings` | **Cucumber候補** | 状態表示が対象Issue、PR、作業領域、警告、設定元をオペレーターへ示すこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T385 | `test/status-report.test.ts` | `shows the automation driver summary` | **Cucumber候補** | 状態表示が対象Issue、PR、作業領域、警告、設定元をオペレーターへ示すこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T386 | `test/status-report.test.ts` | `shows the layered config source` | **Cucumber候補** | 状態表示が対象Issue、PR、作業領域、警告、設定元をオペレーターへ示すこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |

### `test/watch-polling-break.test.ts`（4件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T387 | `test/watch-polling-break.test.ts` | `tells issue-coordinator watch to break polling once the promise settles` | **Vitest継続** | 完了ファイル確定後に監視を打ち切る指示がプロンプトへ静的に含まれること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T388 | `test/watch-polling-break.test.ts` | `tells pr-reviewer watch to break polling once the promise settles` | **Vitest継続** | 完了ファイル確定後に監視を打ち切る指示がプロンプトへ静的に含まれること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T389 | `test/watch-polling-break.test.ts` | `shows issue-coordinator watch a break-early instruction` | **Vitest継続** | 完了ファイル確定後に監視を打ち切る指示がプロンプトへ静的に含まれること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |
| T390 | `test/watch-polling-break.test.ts` | `shows pr-reviewer watch a break-early loop example` | **Vitest継続** | 完了ファイル確定後に監視を打ち切る指示がプロンプトへ静的に含まれること | ファイル内容・配布一覧・プロンプト文字列を直接検査する静的テストであり、受け入れシナリオよりVitestの局所検査が適する。 |

### `test/worker-watch-decision.test.ts`（9件）

| ID | 現在のファイル名 | 現在のテスト名 | 分類 | 守る契約 | 根拠 |
|---:|---|---|---|---|---|
| T391 | `test/worker-watch-decision.test.ts` | `keeps waiting for a worker with recent tool activity and no worktree diff` | **Cucumber候補** | 作業者の活動・完了ファイル・猶予時間から、待機・催促・観測・終了を安全に選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T392 | `test/worker-watch-decision.test.ts` | `keeps waiting during the post-nudge grace period` | **Cucumber候補** | 作業者の活動・完了ファイル・猶予時間から、待機・催促・観測・終了を安全に選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T393 | `test/worker-watch-decision.test.ts` | `asks for a promise before any pane close is considered` | **Cucumber候補** | 作業者の活動・完了ファイル・猶予時間から、待機・催促・観測・終了を安全に選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T394 | `test/worker-watch-decision.test.ts` | `allows pane close only after inactivity and grace have both elapsed` | **Cucumber候補** | 作業者の活動・完了ファイル・猶予時間から、待機・催促・観測・終了を安全に選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T395 | `test/worker-watch-decision.test.ts` | `requires pane output inspection before pane close` | **Cucumber候補** | 作業者の活動・完了ファイル・猶予時間から、待機・催促・観測・終了を安全に選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T396 | `test/worker-watch-decision.test.ts` | `returns settled when the promise is complete` | **Cucumber候補** | 作業者の活動・完了ファイル・猶予時間から、待機・催促・観測・終了を安全に選ぶこと | GitHub状態、実行結果、表示、または破壊操作の可否として外部観測できる。移行時は内部名を本文へ出さず、この1保証だけを1つの Then と1 assertionで表す。 |
| T397 | `test/worker-watch-decision.test.ts` | `treats timezone-less timestamps as UTC` | **Vitest継続** | 作業者の活動・完了ファイル・猶予時間から、待機・催促・観測・終了を安全に選ぶこと | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T398 | `test/worker-watch-decision.test.ts` | `rejects missing input flag values` | **Vitest継続** | 作業者の活動・完了ファイル・猶予時間から、待機・催促・観測・終了を安全に選ぶこと | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |
| T399 | `test/worker-watch-decision.test.ts` | `rejects missing now flag values` | **Vitest継続** | 作業者の活動・完了ファイル・猶予時間から、待機・催促・観測・終了を安全に選ぶこと | 内部状態、純粋な計画関数、または低レベルの呼出順を直接検査しており、公開結果へ書き換えるまではVitestで維持する。 |

## 人間が判断すべき論点

1. **削除候補9件の承認**: いずれも改名・旧方式の不存在を固定する履歴テストである。互換性を公開契約として残す方針なら、削除せずVitest継続へ戻す。
2. **完了ファイルの旧形式互換**: `extract-worker-promise.test.ts` の `keeps legacy complete promises compatible` は「legacy」と明記されるが、現行コードが受理する互換動作でもあるため推測で削除せずVitest継続とした。互換期限を別途決める必要がある。
3. **公開設定をどこまで受け入れ仕様にするか**: `core.test.ts` の設定既定値・優先順位はCucumber候補、cron計算・文字列整形はVitest継続とした。CLIまたは拡張を端から端まで起動して観測できない設定は、無理にCucumber化せずVitestへ戻す。
4. **プロンプト安全文言と実際の安全動作の重複**: 手動Issue close禁止、修正時のラベル維持などは安全契約としてCucumber候補にした。一方、単なる文言・テンプレート構造の検査はVitestに残した。移行時はプロンプト文字列ではなくGitHub上の結果を観測できるか確認する。
5. **低レベル統合の二重保持**: Herdr/GitHubアダプター、引数エスケープ、完了ファイル解析はVitest継続とした。上位のCucumberシナリオを追加しても、障害局所化の価値があるため原則削除しない。
6. **分類は移行後のテスト数を意味しない**: 1行は現行の追跡単位である。Cucumber化で既存Vitestを置換するか併存するかは、同じ保証の重複と診断価値を移行PRごとに人間が判断する。
7. **現在一ケースに束ねられた観測の分割**: たとえば T001 は作業領域、指示ファイル、完了ファイル、起動を一つの複合値で検査している。移行時は現行ケースをそのまま一シナリオにせず、利用者にとって独立した観測結果なら別シナリオへ分け、各シナリオを1 Then・1 assertionにする。

## 決定論的照合

- `npm test -- --reporter=json --outputFile=/tmp/deadloop-vitest.json` の実行結果: 42ファイル、399テスト、全件成功。
- JSONレポートの `numTotalTests`（399）と、この文書の分類行 T001〜T399（399行）を生成時に比較し、不一致なら生成を失敗させた。
- 分類合計: 217 + 173 + 9 = 399。ファイル別総数の合計も399。
