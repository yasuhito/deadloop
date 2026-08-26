# ADR 0032: PR driver がレビュー修復を agent:implement 要求で起動する

## Status

採用済み。Issue #278。[ADR 0031](0031-review-history-based-repair-progress.md) の修復進展の意味論を変えず、その起動経路を置き換える。

## Context

レビュー修復の起動は `pr-review-repair-dispatch` がレビュー請求（`agent:in-progress`）を持ったまま直接行っていた。レビュー結果の永続化、reviewer-promise 検証、bounded-attempt 上限、repair-worktree チェック、履歴鮮度ゲート、worker 起動が同一ドライバーに絡み合い、#238 が定めた「PR の `agent:implement` 要求だけが修復の開始点」という遷移が実装されていなかった。要求ラベルを選んでも起動者がいないため、`agent:implement` を持つ PR は `unserved_request` として丸ごとスキップされ、要求が使えない状態だった。

起動責務の置き場所として2案があり、**案A（起動責務を PR driver へ集約する）**を採用する。

## Decision

レビュー結果の記録と修復要求の作成は引き続き dispatcher（レビュー結果ディスパッチャー）が行う。ただし dispatcher は worker を起動しない。必須指摘のあるレビュー結果は次の順で処理する。

1. reviewer promise の検証とレビュー結果コメント（修復試行マーカー付き）の GitHub 永続化。**要求より先に結果が存在する。**
2. reviewer workspace の後片付け。
3. `agent:in-progress` を `agent:implement` 要求へ変更（implement ラベル追加 → in-progress 除去の順）。これ以降、修復の開始責務は dispatcher にはない。

PR driver は `review-repair` を served role に戻す。`agent:implement` 要求を持つ PR を選んだとき、driver が claim（`agent:implement` を消費して `agent:in-progress` へ）してから修復 worker を起動する。全リクエスト役割の起動がここに集約される。

### 各ゲートの配置先

- **bounded-attempt 上限**: 引き続き決定論的ロジック（`selectRepairAttempt`、head + findings fingerprint のキー）が担う。dispatcher は要求作成時に結果コメントへ修復試行マーカーを書くので、同一 (head, findings) 組に対する要求は一度しか作られない。driver は起動前に、このキーの修復がすでに完了報告・停止マーカーを残している場合は要求を obsolete として消費する。
- **repair-worktree チェック**: driver へ移動する。claim 後・起動直前に worktree の不在／重複／未コミット変更／head 不一致を判定し、安全でなければ既存の人間ブロック経路で要求を消費して停止する。worktree が存在しないことは正常（起動が用意する）。
- **history-freshness ゲート**: レビュー結果の永続化を守るゲートは dispatcher に残留する。修復起動時の鮮度は driver が claim 時に PR 履歴観測を取得し、起動直前まで不変であることを要求することで担保する。dispatcher 固有の accepted-history ファイルを driver が読む依存は持たない。

### 修復契約

修復契約の findings は GitHub に永続化されたものだけから来る。レビュー結果コメントの修復試行マーカーに base64url JSON で findings を埋め込み、driver がそれを読んでプロンプトを描画する。advisory 観測は契約に入らない。マーカー payload を持たない古い形式のコメントは契約なしとして扱い、要求は obsolete として消費する。

### obsolete 要求

driver は要求を消費する前に修復がまだ必要か再検証する。対象 head の必須指摘が GitHub に残っていない、head が動いた、同じキーの修復がすでに結果を出している——のいずれでも、agent を起動せず人間が読める説明コメントを残して要求を消費し、PR を通常レビューへ返す。

## Consequences

- `unserved_request` は消える。`agent:implement` を持つ PR はスキップされず、driver の固定要求順序（update-branch → implement → review）で処理される。
- 修復の起動再試行・監視復旧は driver の claim ライフサイクル（stale reclaim、実行基盤による生存判定）に従う。dispatcher 内にあった起動証跡ファイルと Herdr 直接復旧経路は削除する。
- 修復 push 成功後の `agent:in-progress` → 新しい `agent:review` 要求への変更は完了ハンドラーの現行動作のまま変わらない。
- dispatcher は `monitor` ハンドオフを返さなくなり、レビュー結果処理はすべて `done` で終わる。レビュー試行の完了ハンドラーは新しい `review_repair_requested` / `review_repair_already_requested` を保持結果として扱う。
