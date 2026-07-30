---
status: accepted
---

# Define minimum contracts between deadloop core and its adapters

[deadloopの抽象化契約を確定する](https://github.com/yasuhito/deadloop/issues/88) で、deadloop core、Automation host、実行基盤、Agent program、レビュー方針の最小契約を決めた。この判断は、[Use case workflows as deadloop's primary module seams](./0005-deadloop-module-seams.md) で採用した目的別ワークフローを具体化する。

## Context

deadloop はGitHub上の副作用と、作業領域・エージェントのライフサイクルをまたぐ。通信のタイムアウト、hostの再起動、PR headの更新、dirty workspace、遅れて届いた完了報告が同時に起こり得るため、単にPi、Herdr、Claude、Codexを差し替えられるだけでは安全な境界にならない。

一方、全処理を汎用effect engineや永続job基盤へ抽象化すると、現在のPi + Herdr経路を改善する前に大きな基盤を作ることになる。契約は、目的別ワークフローを保ったまま、所有権、鮮度、失敗、安全停止を表現できる最小限に留める。

## Decision

### 1. deadloop core owns workflow meaning and GitHub side effects

`coordinateIssue`、`advanceImplementation`、`reviewPullRequest`、`advanceReview`は、GitHubの現在状態を観測し、安全条件を評価し、許可された副作用を目的別ポートから実行する深いワークフローとする。

GitHubの汎用CRUDや、hostが解釈する副作用一覧は公開しない。`claimForImplementation`、`commentOnce`、`mergeIfCurrent`のように、期待ラベル、決定的marker、期待head SHAを含む目的別操作を使う。

Automation host、実行基盤、Agent programには、Issue close、ラベル変更、mergeなどのGitHub変更権限を渡さない。coreの結果は次に実行するコマンド列ではなく、reason codeと試行の同一性を持つ、相互排他的な型付き結果である。

- `done` — 処理が終端した。試行回数を増やさない。
- `wait` — 外部条件を待つ。同じ対象を後で再観測し、新しい試行を作らない。
- `reobserve` — 結果不明または競合を解決するため、同じattempt IDの現在状態を再取得する。
- `retry` — coreが明確に失敗したattempt ID、reason code、`notBefore`を示し、その時刻以降の新しい試行を1回だけ許可する。
- `blocked` — 自動実行を終え、理由と復旧手順を持って人間へ渡す。

### 2. Automation host owns scheduling, not policy

Automation hostは、定期または手動の呼び出し、排他、設定の組み立て、試行journalの永続化、停止通知、UIを所有する。

再試行可能か、安全に続行できるか、どのIssueまたはPRを選ぶかは判断しない。coreはjournalから試行履歴を読み、再試行上限とbackoffを適用して`retry`または`blocked`を返す。hostは`retry.notBefore`より前に呼び出さず、時刻や上限を独自計算しない。`retry`後の呼び出しでcoreが新しい試行を作成した時点だけ、試行回数が増える。

共有設定は信頼済みbase branchから読み、運用者のローカル上書きと組み合わせ、検証済みの呼び出し設定としてcoreへ渡す。PR branch上の設定は、そのPR自身の安全判定に使わない。各adapterには必要な設定だけを渡し、秘密情報を完了報告へ含めない。

### 3. An attempt has stable identity

Issue実装またはPRレビューを一度遂行する単位を試行とする。Automation hostは定期枠または手動操作ごとに安定したhost invocation IDを渡す。coreが候補を選び、attempt IDと不変のattempt intentを作る。hostが提供する`AttemptJournal`ポートがintentを永続化し、成功を応答するまで、coreはGitHub claim、コメント、workspace取得、agent起動などの外部副作用を始めない。

attempt intentは最低限、host invocation ID、attempt ID、ワークフロー種別、project ID、対象の種類と識別子、選定時の期待GitHub状態を結び付ける。PRレビューでは選定時head SHAを、実装では選定時に観測した信頼済みbase commitを対象revisionとして含め、永続化後は変更しない。

journalは次の結果を区別する。

- 同じhost invocationまたはattempt IDと同じbinding — 既存intentを返し、coreは同じ試行を復旧する。
- 同じIDと異なるbinding — 契約違反として安全停止する。
- 新しいIDとbinding — 永続化完了後にだけ試行を開始できる。

起動結果が不明な状態から復旧するときは、同じattempt IDで既存workspace、session、完了報告を再発見する。明確な終端失敗に対してcoreが`retry`を返し、`notBefore`後にhostが再度呼び出した場合だけ、coreは新しいattempt IDを発行できる。異なるattempt ID、異なる対象、古いrevisionに結び付いた成果は、現在の試行の完了証拠として採用しない。

### 4. The execution runtime owns workspace and session lifecycle

`ImplementationLauncher`と`ReviewerLauncher`が、実行基盤、`AgentProgram`、完了経路を目的別に組み合わせる。coreはworktree、tab、pane、argv、promise pathを認識しない。

実行基盤は、attempt intentに結び付いた所有権付きhandleを返す。取得、起動、観測、停止、後片付けはattempt IDと不変bindingを必須入力とし、少なくとも`created`、`recovered`、`conflict`、`unknown`、`preserved`を区別する。

- 同じattempt IDによるworkspace取得とagent起動は冪等で、既存資源を`recovered`として返す。同じ試行に二つ目のlive sessionを作らない。
- 既存sessionの再開は同じ試行の復旧であり、新しいsessionを使う再試行は新しいattempt IDを必要とする。
- 観測は、実行中、停止、完了報告後のprocess残留、完了報告なしの終端または無活動、競合、状態不明を区別する。
- 停止と後片付けは冪等にする。既に停止または安全に削除済みなら成功として現在状態を返す。
- workspace取得後にsession起動が失敗するなどの部分失敗でも、取得済み資源のhandleと所有者を失わない。adapterは安全な補償を試み、削除の安全性を証明できなければ`preserved`または`unknown`として場所と復旧手順を返す。

実行基盤はGitHub状態、再試行可否、マージ可否を判断しない。観測事実と型付き失敗だけを返す。後片付けでは、対象がその試行の所有物であることを再確認する。dirty、未push、diverged、所有者不明、状態不明のworkspaceは削除しない。

### 5. Agent programs normalize into one completion report

`AgentProgram`は、Pi、Claude、Codexごとの差を、事前確認、argvと権限、プロンプト搬送、agent固有の完了経路、共通完了報告への変換に限定する。

共通報告はversion付きのdiscriminated schemaとする。共通部分はschema version、attempt ID、役割、対象の種類と識別子、起動時revision、要約を持つ。実装報告では起動時base commitと生成したcommitまたはPR headを区別し、レビュー報告では起動時PR headと実際にレビューしたheadを一致させる。

- `complete`は、役割別の型付き結果と、検証またはレビュー証拠を必須とする。
- `blocked`は、reason code、説明、復旧または追加情報の手順を必須とする。
- agent固有の追加情報はnamespaced extensionに限定し、安全判定の権威にしない。

promise fileはPi + Herdr経路の搬送方法であり、deadloop coreの公開契約ではない。process終了、画面出力、session状態、エージェントの最終回答だけでは意味的完了とみなさない。報告の欠落、schema不正、attempt不一致、対象不一致、revision不一致は「有効な完了報告なし」とする。完了報告は証拠であり、GitHub副作用やmergeを許可する命令ではない。

V1 の読み書きへの移行は進行中である。新しく起動する Worker、レビューエージェント、レビュー修正エージェント、ブランチ更新エージェントは V1 を書く。従来の3項目ペイロードは旧試行を終了させるためだけに弱い証拠として読め、保存済みの試行記録との結び付きや、後片付け・状態調整の強い証拠には昇格しない。

この判断は [ADR 0003](./0003-promise-file-contract.md) のプッシュ型ファイル搬送を維持し、3項目の従来ペイロードを版付き共通報告へ改訂する。移行は、先に読み取り側を従来形式と新しい版の両方へ対応させ、次に書き込み側を切り替え、旧試行がなくなってから従来形式の読み取りを削除する。従来ペイロードは専用の promise パスと保存済みの起動情報にだけ結び付け、存在しないリビジョンや検証証拠を合成して強い証拠へ昇格させない。移行中に必要な証拠を持たない旧報告は、既存の安全ゲートで再検証できなければ人間へ引き渡す。

### 6. Review policy is a pure decision boundary

レビュー方針は、取得済みのGitHub、CI、外部レビュー、deadloopレビュー、人間承認の事実を受け取り、純粋なdirectiveを返す。

各証拠は対象head SHA、取得時刻、取得元を持つ。未取得、要件なし、未完了、失敗を区別する。

レビュー方針はAPI取得、コメント投稿、レビューエージェント起動、mergeを行わない。結果は次のいずれかとする。

- 待機
- 外部レビュー要求
- レビューエージェント起動
- 遮断
- 人間への引き渡し
- merge候補

検証済みの信頼済み設定で`autoMerge: false`なら、レビュー方針は必ず人間への引き渡しを返し、coreへmerge capabilityを渡さない。`autoMerge: true`を明示した場合だけ、expected head SHA付きの`mergeIfCurrent`を呼べる。

merge直前にcoreは、head、draft状態、必須check、必須reviewとapproval、信頼済みbase branchの方針を再取得する。すべてが同じheadに結び付き、成功または充足が確認できた場合だけmergeする。欠落、変化、不明が一つでもあればmergeせず、再評価または人間への引き渡しに戻す。これらは、後続の詳細なレビュー方針に依存しない必須不変条件である。

### 7. Operational failures are typed data

想定できる運用上の失敗は例外ではなく、次の分類を持つ型付きデータとする。

1. 待機 — CIや外部レビューが未完了。失敗ではない。
2. 鮮度切れまたは競合 — headやラベルが変化。現在状態を再観測する。
3. 一時障害 — 副作用を送信していないと証明できる通信障害やrate limit。上限付き再試行の候補。
4. 運用者対応が必要 — 設定、認証、権限不足。復旧手順を示して停止する。
5. 不明、危険、契約違反 — 部分成功、所有権不明、dirty、schema不正、不変条件違反。成果を保全して安全停止する。

adapterは固有エラーに原因だけでなく、操作phaseと結果の確実性を付けて正規化する。変更要求を送信した後のtimeoutや応答不明は、一時障害として再試行しない。`outcome-unknown`として、期待ラベル、決定的marker、expected head SHAなどを使う目的別再観測へ進む。

再観測は`applied`、`not-applied`、`conflict`、`still-unknown`を区別する。`not-applied`を確認した場合だけ元の操作を再実行でき、`applied`は成功として継続し、`conflict`はワークフローを再評価し、`still-unknown`は安全停止する。未分類の例外を自動再試行しない。予期しない例外は最上位で「不明」として安全停止する。

### 8. Recovery always re-observes external state

Automation hostの保存状態は、作業を再発見する手掛かりであり、現在状態の証明ではない。

再起動後は、GitHubのIssue、PR、ラベル、head、実行基盤のworkspaceとsession、完了報告を再取得する。attempt IDと現在状態が一致すれば処理を続け、食い違い、不明、部分成功では自動操作を止める。

作業中にIssueの適格ラベルが外れた場合やPRが閉じた場合は、coreが中止を決め、実行基盤へsession停止を依頼する。遅れて届いた完了報告は、対象が現在も適格であることを再確認しない限り、ラベル変更やmergeの根拠にしない。

### 9. Adapter contracts use purpose-specific operations and capabilities

adapter契約は、万能な`execute`や製品名の分岐ではなく、小さな目的別操作語彙と能力表で表す。

必須能力が欠ける場合は、副作用より前の事前確認で停止する。未対応機能を推測的な代替処理で隠さない。どの能力を第一級対応の必須条件にするかは、[推奨経路と第一級対応の受入契約を確定する](https://github.com/yasuhito/deadloop/issues/89)で決める。

第一級adapterは型付き実装、契約テスト、決定論的な事前確認を持つ。自然言語によるcustom integrationは、無人のGitHub副作用を伴う第一級経路にしない。

この境界は、Matt Pocock skillsが共通のMap、Child ticket、Blocking、Frontier、Claim、Resolveという語彙をtracker固有の操作文書へ写像する小さな設計から学んだ。ただし、Matt skillsは人間同席のprompt workflowであり、自由形式のtracker文書を許容できる。deadloopでは同じ「安定した意味と具体的操作の分離」を採り、危険な副作用の実装はMarkdownではなく型付きadapterへ限定する。

## Consequences

- Pi + Herdr経路からcoreを抽出するとき、hostが解釈する汎用effect listや万能RunnerAdapterを新設しない。
- attempt intentの副作用前永続化、同じ試行の冪等な復旧、1試行1live session、結果不明後の再観測、version付き完了報告、merge直前の全条件再取得を、各目的別ワークフローとadapterの共通不変条件にする。
- Automation hostの再起動やadapterの不明な失敗では、保存済みの進行状態から盲目的に再開せず、GitHub、実行基盤、完了報告を再観測する。
- Agent programを追加しても、GitHub副作用の権限と意味的完了の判定基準は変えない。
- 第一級対応の可否は製品名の列挙ではなく、必要能力と契約テストの通過で判断できる。
- 自由形式のadapter設定や汎用plugin APIは、具体的な第三者統合の必要性が実証されるまで導入しない。
