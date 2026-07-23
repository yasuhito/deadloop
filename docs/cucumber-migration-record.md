# Cucumber 移行記録

この記録は、分類表の Cucumber 候補を受け入れ仕様へ移した対応と検証結果を追跡する。
Vitest は移行直後の同等性確認と局所的な診断価値のため、ここに記録した項目でも削除しない。

## Issue #121: レビュー可能な pull request だけを選ぶ

正本は [`acceptance/features/pr-reviewer-selection.feature.md`](../acceptance/features/pr-reviewer-selection.feature.md) である。
各シナリオは決定論的な PR 選定またはレビュー処理の境界に、分類元と同じ事前状態を与え、一つの外部結果だけを検査する。

| 分類 ID | 受け入れシナリオ |
| --- | --- |
| T331 | レビュー待ちの pull request を選ぶ |
| T332 | 自動マージが無効なら人間確認待ちの pull request を選ばない |
| T333 | 自動マージが有効なら人間確認待ちの pull request を選ぶ |
| T334 | CI 実行中の pull request を選ばない |
| T335 | 外部レビューの待機期限が切れた pull request を選ぶ |
| T336 | 外部レビューが無効なら外部レビュー待ちの pull request を選ぶ |
| T337 | 外部レビュー担当が処理中の pull request を選ばない |
| T338 | 別の外部レビュー担当が処理中の pull request を選ばない |
| T339 | 下書きの pull request はレビューを開始しない |
| T312 | 下書きの pull request には復旧手順を示す |
| T340 | 外部レビューをまだ依頼していない pull request には外部レビューを依頼する |
| T341 | 外部レビューを待っている pull request は待機する |
| T342 | 外部レビューの待機期限が切れた pull request は通常レビューへ戻す |
| T346 | 古いレビュー占有を回収して pull request を選ぶ |
| T347 | 別担当がレビュー中の pull request を選ばない |
| T348 | 停止中の pull request を選ばない |

`T343`、`T344`、`T345` は不正な CLI 入力を拒否する局所的な診断であり、分類どおり Vitest を継続する。
複数候補と選択後の状態変化は追加シナリオで確認し、低い番号の対象外ラベル・停止中・CI 実行中・別担当が処理中の候補を飛ばすこと、および同じ PR を重複して選ばないことを確認する。

## 同等性と否定確認

`npm run test:unit` と `npm run test:acceptance` を同じ作業ツリーで実行し、既存の `test/pr-reviewer-precheck.test.ts` と上記受け入れシナリオの双方が成功することを確認した。
2026-07-23 に `pull request #{int} をレビュー対象に選ぶ` の assertion を一時的に `number + 1` として `npm run test:acceptance` を実行したところ、終了コード 1 で失敗し、たとえば「レビュー待ちの pull request を選ぶ」で `7 !== 8` と feature 行および TypeScript の callback 行を表示した。直後に assertion を元へ戻した。
