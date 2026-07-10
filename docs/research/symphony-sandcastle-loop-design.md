# Symphony / Sandcastle のループ設計調査

- 調査日: 2026-07-10
- 対象: [`openai/symphony`](https://github.com/openai/symphony/tree/4cbe3a9699a73b862466c0b157ceca0c1985d6d7)、[`mattpocock/sandcastle`](https://github.com/mattpocock/sandcastle/tree/e99f832f26dc9d245c019a9ddd19fa5dee792427)
- 問い: [deadloop issue #83](https://github.com/yasuhito/deadloop/issues/83)

## エグゼクティブサマリー

Symphony は「課題トラッカーを真実の源とする常駐スケジューラ」であり、課題ごとの永続 workspace、単一のオーケストレータ状態、指数バックオフ、状態再照合を中核にする。一方、CI、レビュー、承認、マージの具体策はエンジンではなくリポジトリ所有の `WORKFLOW.md` のプロンプトに置く。実例では、CI と全レビュー指摘を解消して `Human Review` へ渡し、人間が `Merging` に移した後だけ land する。[仕様: 境界とゴール](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L19-L56) [実例 workflow: 状態マップ](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L103-L124)

Sandcastle は「呼び出し側が組み立てる、エージェント実行・sandbox・worktree のライブラリ」であり、CI やレビューは一級の状態機械ではない。実装→検証→レビューのような処理を TypeScript で構成し、branch strategy と sandbox provider を差し替える。失敗時の dirty worktree 保存、セッション再開、`idleTimeoutSeconds` と `completionTimeoutSeconds` は有用だが、`head` への直接書き込みや `merge-to-head` は deadloop の GitHub PR 中心の安全境界には適さない。[README: 目的と API](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L9-L24) [README: branch strategy](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L548-L558)

したがって deadloop は、Symphony から **単一権威の再照合、分類済み失敗、上限付き再試行、永続 workspace の明示的回収**を、Sandcastle から **runner/provider 境界、ハンドルの所有権、dirty 状態の保全、無活動と完了後のプロセス残留の区別**を採るべきである。一方、GitHub 状態遷移を Worker のプロンプトへ委譲する Symphony の境界、sandbox 呼び出しと branch strategy を結び付ける既定構成、暗黙の host merge、画面出力やセッションを完了の権威にする設計は意図的に採らない。deadloop は既に、決定論的 driver、runner 境界、専用 promise、既定 `autoMerge: false` を持つため、この方向は現行設計の強化であって置換ではない。[deadloop extension internals](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/extensions/deadloop/README.md#L30-L40) [deadloop README: 段階導入](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/README.md#L76-L83)

## 1. 調査の読み方

比較対象は抽象度が違う。Symphony はサービス仕様と参照実装、Sandcastle はプログラム可能な実行ライブラリである。そのため「機能の有無」だけでなく、**どの層が責任を負うか**を比較した。根拠は対象リポジトリの commit 固定資料・source・workflow のみに限定した。

## 2. Symphony の証拠

### 2.1 CI・外部レビュー・人間承認・自動マージ

- Symphony core はスケジューラ兼 runner と課題トラッカーの読み取り手であり、課題の状態変更、PR 操作、成功条件はワークフローのプロンプトとエージェントのツール群に委ねる。成功は `Done` ではなく `Human Review` のような引き渡しでもよい。[SPEC §1](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L33-L45) [SPEC §11.5](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L765-L778)
- 参照 `WORKFLOW.md` は、PR の全体コメント、行コメント、レビュー状態を全て収集し、人・bot を問わず対応が必要な指摘を停止条件とする。変更または根拠付き反論の後に再検証する。[WORKFLOW: PR feedback sweep](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L177-L194)
- `Human Review` へ進める前に最新 commit の必須チェックが成功し、未解決コメントがなく、要求された検証が完了していることを求める。[WORKFLOW: handoff gate](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L244-L264)
- 人間承認は tracker の状態遷移で表す。`Human Review` 中は変更せず、人間が `Merging` に移して初めて land loop を実行する。つまり auto-land は可能だが、人間の明示的状態変更の後段に限定される。[WORKFLOW: Human Review / merge](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L267-L277)
- これは Symphony engine の必須方針ではない。仕様は approval/sandbox/operator-confirmation policy を implementation-defined とし、高信頼環境と厳格環境の双方を許す。[SPEC §10.5](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L682-L716)

### 2.2 workspace / Worker lifecycle

- オーケストレータが dispatch、retry、reconciliation の唯一の可変状態所有者で、`running`、`claimed`、`retry_attempts` を管理する。[SPEC §3.1, §4.1.8](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L76-L108)
- workspace は sanitized issue identifier から決定的に作り、同一 issue の run 間で再利用する。成功時にも自動削除せず、terminal issue の startup sweep または reconciliation 時に回収する。[SPEC §9.1–9.2](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L568-L596) [SPEC §8.6](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L550-L560)
- lifecycle hook は `after_create`、各 attempt 前の `before_run`、各 attempt 後の `after_run`、削除前の `before_remove`。作成・実行前の失敗は attempt を止めるが、実行後・削除前の失敗は記録して本処理を継続する。[SPEC §5.3.4](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L199-L225)
- Worker は同じ app-server process/thread と workspace で複数 turn を続ける。tracker が active の間は continuation prompt を送り、上限到達後も短い continuation retry で再確認する。[SPEC §7.1](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L399-L428)
- 安全 invariant は、agent の cwd が issue workspace と一致すること、workspace が root 配下であること、key が sanitize 済みであること。ただし仕様自身が、これは強い sandbox の代替ではないと明記する。[SPEC §9.5](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L628-L649) [SPEC §15.1](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L900-L915)

### 2.3 設定とプロンプトの責務

- リポジトリ所有の `WORKFLOW.md` を YAML front matter（tracker、polling、workspace、hooks、agent、Codex）と Markdown/Liquid プロンプトに分ける。型付き設定層が既定値、環境変数参照、検証を担い、プロンプトは issue ごとの判断と作業規約を担う。[SPEC §5.2–5.4](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L148-L248)
- 課題の適格性、並行数、timeout、sandbox/approval、hook は設定である。一方、CI の確認、レビュー指摘の扱い、状態変更、land 手順は参照ワークフローのプロンプトである。[WORKFLOW front matter](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L1-L36) [WORKFLOW instructions](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L37-L103)
- 設定は動的に再読み込みし、不正な更新では直近の有効な設定を維持する。実行中のセッションの再起動までは要求しない。[SPEC §6.2](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L304-L326)

### 2.4 失敗・再試行・復旧

- attempt は preparing workspace から succeeded / failed / timed out / stalled / canceled by reconciliation まで理由を区別する。[SPEC §7.2](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L430-L446)
- 異常終了は `min(10s × 2^(attempt-1), max_retry_backoff)`、正常終了後の継続確認は 1 秒。retry 発火時に対象を再取得し、非 eligible なら claim を解放する。[SPEC §8.4](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L505-L533)
- 毎 tick、stall と tracker state を再照合する。terminal なら Worker を止めて workspace を削除し、非 active なら削除せず停止する。state refresh failure では既存 Worker を止めない。[SPEC §8.5](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L535-L548)
- スケジューラの状態はメモリ上だけにある。再起動で timer/session は復元せず、課題トラッカーの再取得と残存 workspace の再利用で復旧する。[SPEC §14.3](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L872-L889)

## 3. Sandcastle の証拠

### 3.1 CI・外部レビュー・人間承認・auto-merge

- Sandcastle core は CI、レビュー、承認の状態機械を持たず、`run()`、`createSandbox()`、`sandbox.exec()` を呼び出し側が組み合わせる。README の実装→検証→レビュー例では、検証の非ゼロ終了コードを harness が gate にして次のエージェント呼び出しを止める。[README: reusable sandbox pipeline](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L261-L340)
- レビューは雛形または利用側処理の一段であり、同じ branch/container 上でレビューエージェントが修正もできる。これは「独立した外部レビュー」ではなく、構成可能なエージェント処理である。[README: multi-run implement/review](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L286-L309)
- リポジトリ自身の `agent-review.yml` は `agent:review` label を起点に PR branch を取得し、レビューエージェント、push、GitHub review 投稿を行い、失敗時は `agent:blocked` と再実行方法を残す。これは Sandcastle library の保証ではなく、同リポジトリが同じ基本機能で構成した運用例である。[agent-review workflow](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-review.yml#L1-L129)
- 同リポジトリの CI は main push の build/test のみで、PR の必須チェック、人間承認、自動マージを Sandcastle API が統合する証拠はない。[CI workflow](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/ci.yml#L1-L18)
- branch strategy の `merge-to-head` は agent 終了後に local HEAD へ merge するが、GitHub PR の required checks や人間承認を待つ auto-merge ではない。[README: branch strategies](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L542-L565)

### 3.2 sandbox / worktree / agent lifecycle

- sandbox provider は bind-mount、isolated、no-sandbox の差し替え境界であり、agent provider も別に差し替える。branch strategy は `head`、`merge-to-head`、named `branch` の三つ。[README: providers](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L66-L104) [CONTEXT: core concepts](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/CONTEXT.md#L1-L63)
- 最上位の `run()` は一回のライフサイクルを所有する。`createSandbox()` は container と branch を複数回の実行で温存し、`await using` / `close()` が回収する。dirty なら worktree を保存し、clean なら container と worktree を削除する。[README: cleanup](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L343-L357)
- `createWorktree()` を別ハンドルにすると所有権が分かれ、`sandbox.close()` は container のみ、`worktree.close()` が worktree を回収する。明示的なハンドル所有権が二重削除を避ける。[README: split ownership](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L419-L472)
- 同じ named branch の clean worktree は再利用時に origin へ安全に fast-forward するが、dirty/diverged/offline なら現状を保つ。この保守的再利用は変更履歴にも明記される。[CHANGELOG 0.7.0](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/CHANGELOG.md#L70-L83)

### 3.3 設定とプロンプトの責務

- sandbox、agent、branch strategy、iteration、timeout、hook、logging は型付き TypeScript オプションである。プロンプトは inline または file のどちらか一つで、ワークフローやタスク管理には意見を持たない。[README: options](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L124-L257) [README: prompts](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L560-L578)
- ファイル由来のプロンプトだけが `{{KEY}}` と sandbox 内のシェル式を展開する。`promptArgs` の値に含まれるシェル記号はデータとして扱い、外部入力からの command injection を避ける。[README: prompt expansion](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L579-L637) [CHANGELOG: injection fix](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/CHANGELOG.md#L252-L258)
- lifecycle hook は host と sandbox を型で分け、実行位置と順序を明示する。hook の失敗は設定処理を直ちに失敗させる。[README: hooks](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L1354-L1386)

### 3.4 失敗・再試行・復旧

- エージェントが無出力のときは `idleTimeoutSeconds` で失敗させる。completion signal 検出後にプロセスだけ残る場合は別の `completionTimeoutSeconds` を用い、期限後も commits と signal を保持して成功扱いにする。[README: completion timeout](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L666-L683)
- 構造化出力の解析または schema 検証の失敗に限って `maxRetries` があり、同じ再開可能なセッションに短いエラーを返して再出力させる。一般的な実行失敗に対するスケジューラの指数バックオフ再試行ではない。[README: structured output retry](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L685-L747)
- 再開可能な provider はセッションファイルを host に保存し、次の sandbox に転送して provider 固有の方法で再開できる。これは会話の復旧であり、branch/worktree/sandbox の復旧とは別である。[README: session capture/resume](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L885-L927)
- dirty worktree は失敗・中断時に保存される。sandbox 起動後の設定失敗で新規 worktree が孤児化する問題は修正されており、変更履歴はライフサイクルの各段階に回収責務が必要なことを示す。[CHANGELOG: orphan cleanup fix](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/CHANGELOG.md#L167-L174)

## 4. 比較

| 観点 | Symphony | Sandcastle | deadloop への意味 |
|---|---|---|---|
| 主抽象 | 課題トラッカー駆動の常駐スケジューラ | sandbox 内エージェント呼び出しライブラリ | deadloop core は Symphony 側、runner 境界は Sandcastle 側に近い |
| CI | プロンプトが PR の必須チェック成功を要求 | 呼び出し側が `exec()` などで条件を構成 | 判定は決定論的な core/driver に置く |
| 外部レビュー | プロンプトが人・bot の全経路を確認 | レビューは任意のエージェント処理。リポジトリのワークフローは label 起点 | 結果の取得と待機は決定論的な条件、評価だけをレビューエージェントに任せる |
| 人間承認 | `Human Review`→人間が`Merging` | 中核概念ではない | `autoMerge:false` の引き渡しを既定に維持 |
| マージ | 人間承認後にプロンプトの land loop | `merge-to-head` または呼び出し側の実装 | GitHub 側の条件通過後にだけ明示操作する |
| workspace | issue key ごとに永続、終端時に回収 | ハンドルと branch strategy ごとに管理し、dirty なら保全 | issue/PR と runner workspace の識別子を対応付け、所有者を一つにする |
| 継続 | 同一 thread の複数 turn とスケジューラ再試行 | warm sandbox、session resume/fork | promise は一回の試行完了を表し、core が再試行を新しい試行として管理 |
| 設定 | `WORKFLOW.md` front matter | 型付き TypeScript オプション | リポジトリ方針とローカル運用者設定を型付きで解決 |
| プロンプト | 課題の状態変更を含む業務規約まで広い | エージェントの作業だけで、エンジンはワークフローに中立 | deadloop は両者より狭くし、決定論的状態遷移をプロンプトに置かない |
| 復旧 | 課題トラッカーとファイルシステムを再照合し、メモリ上の再試行は消失 | artifacts/session/worktree の保存と再利用 | 永続化する最小状態と GitHub/runner の再取得を組み合わせる |

## 5. deadloop の現行境界

- この wayfinding map は、deadloop core が GitHub Issue/PR 状態遷移と安全 gate を担い、runner が worktree/tab/agent のライフサイクルを担うことを前提にする。リポジトリの設計方針も、Herdr 固有処理を実行基盤境界へ寄せ、Issue/PR 状態管理を実行基盤から独立させる。[wayfinding map](https://github.com/yasuhito/deadloop/issues/82) [AGENTS: 設計方針](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/AGENTS.md#L37-L42) [Herdr runner](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/docs/herdr-runner.md#L1-L21) [runner interface](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/src/runner.ts#L1-L52)
- issue coordinator driver が回収、候補選定条件、label 遷移、Worker 起動を行い、PR reviewer driver が CI 待機、外部レビュー、draft、レビューエージェント起動を扱う。LLM プロンプトは driver が返した限定経路だけを実行する。[issue coordinator driver](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/extensions/deadloop/automations/issue-coordinator-driver.ts#L170-L232) [PR reviewer driver](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/extensions/deadloop/automations/pr-reviewer-driver.ts#L193-L253)
- 完了判定の唯一の権威は起動ごとの構造化 promise で、session/画面出力は使わない。[CONTEXT: promise](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/CONTEXT.md#L39-L41)
- 共有リポジトリ方針は信頼済み base branch の `deadloop.json` から読み、ローカル上書きを優先する。PR branch の方針を信頼しない。[extension README](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/extensions/deadloop/README.md#L11-L25)
- 自動マージは明示的な有効化が必要で、推奨する段階導入は issue coordination → `autoMerge:false` での自動レビュー → 安全策の実証後に任意で自動マージ、の順である。[README: safety](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/README.md#L15-L25) [README: rollout](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/README.md#L76-L83)

## 6. 採用する設計

1. **単一権威による状態変更と毎 tick の再照合**（Symphony）。
   - 候補の確保、実行中・再試行中の状態、GitHub 状態、runner の一覧を一つのスケジューラ所有者が突き合わせる。
   - 理由: 再起動や外部操作を「記憶」ではなく GitHub/runner の現在値から回復でき、重複起動を防げる。現行の driver 優先方針と一致する。

2. **失敗を段階・理由別に正規化し、再試行方針をコード化**（Symphony + Sandcastle）。
   - 少なくとも設定、起動、無活動、エージェントの遮断、promise の不正または欠落、CI の待機または失敗、外部レビュー待機、回収失敗を分ける。
   - 一時的な失敗だけを上限回数・最大遅延付きで指数バックオフし、方針・設定・仕様の失敗は再試行せず人間確認または遮断状態へ送る。正常完了後の継続確認と異常時の再試行を分ける。
   - 理由: 無制限なプロンプトループと同じ失敗の高速反復を避ける。

3. **workspace のライフサイクル所有権と回収責務を型で明示**（Sandcastle）。
   - create/open、agent/tab、close/remove の所有者を runner handle に結び、各段階の部分失敗にも補償処理を定義する。
   - dirty/unpushed/uncommitted の可能性がある workspace は自動破棄せず、場所と確認・回収コマンドを遮断報告に残す。
   - 理由: 現行の決定論的な回収を、起動途中の失敗にも一貫して適用できる。

4. **issue/PR と workspace の決定的な対応、および安全な再利用**（Symphony + Sandcastle）。
   - 再試行では同じ issue branch/worktree を開き、再作成前に GitHub、git、runner の一覧を照合する。
   - clean かつ fast-forward の安全性を証明できる場合だけ同期し、dirty/diverged は保存して運用者判断へ送る。

5. **無活動・停滞と、完了後のプロセス残留を別状態にする**（Sandcastle）。
   - promise 未作成かつ無活動なら失敗候補とし、有効な promise があるのに process/tab だけ残る場合は成果を失敗扱いせず回収対象とする。
   - 理由: 「仕事が止まった」と「仕事は終わったが process が閉じない」は復旧策が逆である。

6. **試行と復旧の証拠を構造化する**（両者、ただし deadloop の promise を維持）。
   - attempt id、issue/PR/head SHA、workspace id/path、agent id、開始・最終活動時刻、失敗分類、次回再試行時刻、promise path を status に載せる。
   - 再起動後も GitHub/runner/filesystem から再構成できる最小限の永続メタデータを、ロードマップの候補にする。

7. **設定とプロンプトを責務で分離する**。
   - 設定: 適格性、labels、CI・レビュー・承認・マージの条件、並行数、timeout、再試行、runner/agent profile、workspace 方針。
   - プロンプト: diff の意味評価、仕様適合、曖昧さの説明、遮断理由の要約。
   - shell command、状態遷移、再試行式、マージ可否は TypeScript/helper のままにする。これは Symphony の一体ファイル形式ではなく、その型付き設定層の考え方だけを採る。

8. **人間承認を独立した、観測可能な条件にする**（Symphony の実例）。
   - `autoMerge:false` は `ready-for-human` で停止する。
   - `autoMerge:true` でも CI、外部レビュー、内部レビュー、draft/head SHA、branch protection を再取得してからマージする。将来、手動承認方式を追加するなら、プロンプトの文章ではなく GitHub label/check またはローカル運用者の操作として表す。

## 7. 意図的に採用しない設計

1. **GitHub 状態遷移を Worker のプロンプトに全面委譲しない**（Symphony core の境界を不採用）。
   - Symphony の課題書き込み委譲は柔軟だが、deadloop では label/comment/merge の副作用を決定論的な core が安全に制御する方が重要である。Worker の push、label、PR、close 権限を広げない。

2. **`WORKFLOW.md` 一枚に実行時設定と自由形式プロンプトを同居させない**。
   - 信頼済み base branch の `deadloop.json`、ローカル運用者の上書き、package のプロンプトを維持する。理由は、secret/local path、共有方針、LLM 指示では信頼境界と更新時期が異なるためである。

3. **`head` 直接書き込みと暗黙 `merge-to-head` を採らない**（Sandcastle）。
   - Worker は専用 worktree/branch を使い、統合は GitHub PR とサーバー側の条件を通す。main workspace の直接変更やエージェント終了を根拠にしたローカルマージは、branch protection とレビュー証拠を迂回する。

4. **Sandcastle の provider 抽象を deadloop core の Issue/PR 契約へ持ち込まない**（deadloop 固有の境界判断）。
   - container/VM isolation は将来 runner capability として追加できるが、Issue/PR の意味論は runner から独立させる。これは Sandcastle に状態機械があるという批判ではなく、Herdr を Sandcastle に置換する結論でもない。

5. **エージェントセッションを完了の権威やスケジューラ状態にしない**。
   - Sandcastle の session capture/resume は会話継続に有用だが、deadloop の promise だけによる完了判定を維持する。session は任意の復旧補助と可観測性に限定する。

6. **全失敗を同じ workspace で無制限に再試行しない**（Symphony の再試行をそのまま採らない）。
   - 再試行上限と失敗分類ごとの条件を必須にし、繰り返す設定・方針・権限の失敗は停止する。再試行のたびに head SHA と適格性を再検証する。

7. **レビューエージェントに修正・push を許す同一 sandbox 内レビューを既定にしない**（Sandcastle の雛形とワークフロー）。
   - deadloop のレビューエージェントは読み取り・レビュー・検証専用のままとする。独立性を保ち、修正は再び Worker の管理経路へ戻す。

8. **自動承認を安全既定にしない**。
   - Symphony の高信頼環境向け例や Sandcastle agent provider の承認回避オプションは移植しない。公開 package として最小権限と明示的な有効化を優先する。

## 8. downstream architecture / roadmap への具体化

この調査から将来ロードマップへ載せられる候補施策は、次の単位である。

1. **実行試行と失敗分類のモデル**: 型、status 表示、driver result、fixture tests。
2. **上限付き再試行スケジューラ**: 分類ごとの再試行可否、試行回数上限、待機上限、次回時刻、手動での再投入。
3. **起動時・tick 時の再照合**: GitHub labels/PR head、promise、Herdr agents/worktrees の再取得と重複 claim 防止。
4. **ライフサイクル所有権と補償処理**: create/open/tab/start の各部分失敗、孤児の回収、dirty 状態の保全報告。
5. **無活動と完了後のプロセス残留の識別**: 有効な promise を境に監視と回収を分ける。
6. **マージ条件一覧**: CI、外部レビュー、deadloop レビュー、人間承認または自動マージ方針、head SHA を一つの決定論的入力にする。
7. **Runner capability の拡張（別途設計）**: sandbox/isolation capability は任意とし、GitHub 状態の意味論を変更しない。

既存の downstream ticket へは、次の最小契約を引き渡す。

- [deadloopの抽象化契約を確定する](https://github.com/yasuhito/deadloop/issues/88): core が選定・再照合・再試行・GitHub 副作用を所有し、runner handle が workspace のライフサイクルと型付き失敗証拠を所有し、promise だけを完了の権威とする。
- [レビュー方針の最小モデルを決める](https://github.com/yasuhito/deadloop/issues/91): 必須チェック、GitHub 必須レビュー、外部レビューの要求と結果、deadloop レビュー、人間承認を別々の能力として入力化する。既定は `autoMerge:false` とし、未知・古い結果・head 不一致では安全側に停止する。製品別 adapter は実例が得られるまで追加しない。

将来ロードマップへ載せる場合の実装順は 1 → 2 → 3 → 4 → 5 → 6 を推奨する。7 は v0 の Herdr loop の信頼性とは独立で、先に置換プロジェクトへ広げない。

## 9. 不確実性・限界

- Symphony の `SPEC.md` は Draft v1 で、承認と sandbox 方針は意図的に実装定義である。参照 `WORKFLOW.md` の人間承認条件は有力な運用例だが、Symphony 全利用者の必須動作ではない。
- Sandcastle は 0.x で変更が速い。ここでは 2026-06-29 の `0.12.0` commit を固定した。雛形の具体的な生成物は core API より安定性が低いため、設計根拠は README、CONTEXT、CHANGELOG、ワークフローを優先した。
- Sandcastle リポジトリの CI は main push のみであり、一般利用者の CI・マージ方針は規定しない。「組み込み自動マージがない」は調査 commit の公開 API と資料で確認できる範囲の結論である。
- 実運用の障害率、再試行成功率、workspace 容量、CI 待ち時間の定量比較は両リポジトリの一次資料から得られなかった。再試行上限の具体値は、試験利用者の同意を得て手動収集した障害・再試行記録に基づいて決めるべきであり、自動テレメトリーは前提にしない。
- この文書は設計調査であり、上記 roadmap の実装、設定 schema 変更、runner 置換は行っていない。

## 10. 一次資料一覧

### OpenAI Symphony

- [Service specification (`SPEC.md`, commit fixed)](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md)
- [Reference workflow (`elixir/WORKFLOW.md`, commit fixed)](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md)
- [Elixir implementation README](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/README.md)

### Matt Pocock Sandcastle

- [README / API and lifecycle (`0.12.0` commit fixed)](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md)
- [CONTEXT / terminology and abstraction boundaries](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/CONTEXT.md)
- [CHANGELOG / failure and recovery fixes](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/CHANGELOG.md)
- [Repository agent-review workflow](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-review.yml)
- [Repository CI workflow](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/ci.yml)

### deadloop current architecture

- [README](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/README.md)
- [CONTEXT](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/CONTEXT.md)
- [AGENTS.md](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/AGENTS.md)
- [Herdr runner boundary](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/docs/herdr-runner.md)
- [Issue coordinator driver](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/extensions/deadloop/automations/issue-coordinator-driver.ts)
- [PR reviewer driver](https://github.com/yasuhito/deadloop/blob/26c274dfd73eab1cf5e209eea35bb18a58fe2b03/extensions/deadloop/automations/pr-reviewer-driver.ts)
