---
status: accepted
---

# Model review policy as ordered, head-bound guarantees

[レビュー方針の最小モデルを決める](https://github.com/yasuhito/deadloop/issues/91) で、GitHubの必須チェックと必須承認、外部レビューサービス、deadloopのレビューエージェント、人間への引き渡しを、製品名に依存しない最小のレビュー方針として定めた。この判断は、[deadloop coreとアダプターの最小契約](./0006-minimum-adapter-contracts.md)で定めた純粋なレビュー方針を、利用者が観測できる順序と結果へ具体化する。

## Decision

### 1. Run review guarantees in a fixed order

レビュー方針は、原則として次の順序で現在のPRを評価する。

1. GitHubの必須チェック。
2. 設定されている場合だけ、外部レビューサービス。
3. deadloopのレビューエージェント。
4. 人間への引き渡し、または自動マージの判定。

必須チェックが未完了なら待機し、失敗している間は外部レビューやdeadloopレビューを始めない。チェック修正によるhead更新で、先に取得したレビューが直ちに古くなることを避けるためである。GitHub側の障害や利用上限など、コード以外が原因と確認できる失敗だけは、既存の保守的な代替検証判定を利用できる。

GitHubの必須承認は、`autoMerge: true`でマージする場合の最終条件として扱う。自動レビュー後に現在のheadに対する承認が充足しているかを再取得する。先に承認が届いていてもよいが、head更新後の古い承認は使わない。

### 2. Do not request an external review by default

外部レビューサービスは標準では利用しない。現在のようにCopilotとCodeRabbitを無条件に両方呼び出す動作は廃止する。

利用者は、`/deadloop-setup`のような対話的なセットアップコマンドで、`none`または対応済みの外部レビューサービス一つを選ぶ。選択結果は、信頼済みbase branch上の共有設定`deadloop.json`へ保存する。最初は複数サービスの同時利用を扱わず、実際の必要性が確認されてから拡張する。

選択肢へ追加できるのは、少なくとも次の型付き能力を持ち、決定論的に事前確認できるアダプターだけとする。

- 現在のPR headへレビューを依頼する。
- 同じheadに対する処理中、問題なし、修正要求、確認不能を観測する。
- タイムアウト、権限不足、未導入を区別し、理由と復旧手順を返す。

任意のシェルコマンドや自然言語の手順を、無人でGitHub副作用を行う外部レビューアダプターとして登録させない。未対応サービスは自動実行せず、アダプターと契約試験を追加してからセットアップの選択肢へ昇格させる。セットアップの具体的な導線は[READMEと初回導入体験の優先改善を決める](https://github.com/yasuhito/deadloop/issues/92)で決める。

### 3. External review supplements rather than replaces deadloop review

外部レビューサービスを選んだ場合も、最初の90日ではdeadloopのレビューエージェントを必ず実行する。外部サービスごとに完了や指摘の表現が異なり、deadloopの完了報告と同じ安全契約をまだ保証できないためである。

将来、外部サービスが共通の完了報告、headの鮮度、失敗分類、適合試験を満たした場合に限り、deadloopレビューを置き換える方針を別途検討できる。最初から代替可能な汎用provider機構は作らない。

### 4. Normalize review results into four outcomes

外部レビューサービスとdeadloopのレビューエージェントは、詳細な指摘本文とは別に、現在のheadへ結び付いた次の共通結果を返す。

- `pending` — 確認中。
- `passed` — 自動マージを止める指摘がない。
- `changes-requested` — 修正が必要。
- `unavailable` — タイムアウト、取得失敗、結果不明などにより確認できない。

各結果は対象head SHA、取得時刻、取得元を持つ。説明の改善案など、マージを止めない指摘は本文に残し、方針上は`passed`として扱える。`changes-requested`または`unavailable`を`passed`へ推測変換しない。

外部レビューが`changes-requested`でも、deadloopレビューを実行して人間へまとめて渡す。外部レビューが一定時間応答しなければ`unavailable`として待機を終え、deadloopレビューを実行する。どちらの場合も成果と取得できた証拠を`ready-for-human`へ引き渡すが、自動マージ候補にはしない。

### 5. Keep human handoff and merge authorization separate

`autoMerge: false`は、人間の確認を要求する唯一のdeadloop設定とする。専用の`requireHumanApproval`設定は追加しない。自動レビューが終わった時点で、GitHubの人間承認がまだなくても`ready-for-human`へ移す。

`ready-for-human`は「マージ可能」や「人間承認済み」ではなく、deadloopの担当する確認が終わり、取得できなかった証拠、修正要求、残る判断を含めて次の操作を人間へ渡した状態を意味する。

`autoMerge: true`を明示した場合だけ、現在のheadに対する必須チェック、必須承認、設定済み外部レビューの`passed`、deadloopレビューの`passed`をすべて再取得できたときにマージ候補を返す。一つでも未完了、修正要求、確認不能、古いheadへの証拠であればマージせず、待機または人間への引き渡しを返す。coreはマージ直前にもheadと必須条件を再取得し、`mergeIfCurrent`を使う。

## Consequences

- review policyはCopilotやCodeRabbitの名前で分岐せず、必須チェック、必須承認、外部レビュー、deadloopレビュー、人間への引き渡しという保証を評価できる。
- 現行の外部レビュー待ち時間は、無条件のCopilot / CodeRabbit呼び出しのfallbackではなく、選択済みアダプターの`unavailable`判定へ置き換える。
- 外部サービスの未導入や障害でPR成果を捨てず、deadloopレビューまで完了して人間へ渡せる一方、不足したレビューを隠して自動マージすることはない。
- 共通レビュー結果、headの鮮度、タイムアウト、安全な引き渡しは能力別適合試験へ追加できる。製品固有のコメント文面やAPI手順は各アダプターの試験に閉じ込める。
