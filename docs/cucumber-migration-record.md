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

2026-07-24 に、各 Then assertion の期待値を次のとおり一時的に変更し、変更ごとに `npm run test:acceptance` を実行した。すべて終了コード 1 で意図したシナリオだけが失敗し、出力には `.feature.md` のシナリオ行、`.steps.ts` のステップと callback 行、および実値と期待値の差分が表示された。

| 対象 ID | 一時的な変更 | 観測した失敗 |
| --- | --- | --- |
| T331、T333、T335、T336、T346 | 選択番号の期待値を `number + 1` に変更 | 対応する5シナリオと複数候補シナリオの計6件が失敗し、たとえば `7 !== 8` を表示 |
| T332、T334、T337、T338、T347、T348 | 非選択の期待値を `false` から `true` に変更 | 対応する6シナリオと同じ Then を使う追加2シナリオの計8件が失敗し、`false !== true` を表示 |
| T340 | 外部レビュー依頼の期待値を `wait` に変更 | 「外部レビューをまだ依頼していない pull request には外部レビューを依頼する」だけが失敗し、`external_review_requested` と `wait` の差分を表示 |
| T341 | 外部レビュー待機の期待値を `external_review_requested` に変更 | 「外部レビューを待っている pull request は待機する」だけが失敗し、`wait` と `external_review_requested` の差分を表示 |
| T342 | 通常レビュー復帰の期待値を `wait` に変更 | 「外部レビューの待機期限が切れた pull request は通常レビューへ戻す」だけが失敗し、`reviewer_monitor_request` と `wait` の差分を表示 |
| T339 | 下書き停止の期待値を `wait` に変更 | 「下書きの pull request はレビューを開始しない」だけが失敗し、`draft_blocked` と `wait` の差分を表示 |
| T312 | 復旧手順の正規表現を存在しない見出しへ変更 | 「下書きの pull request には復旧手順を示す」だけが失敗し、実際のコメントと不一致の正規表現を表示 |

各実行の直後に変更を元へ戻した。最後に通常の `npm run test:acceptance` が成功することと、意図的な変更が作業ツリーに残っていないことを確認した。
