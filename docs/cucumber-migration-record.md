# Cucumber 移行記録

この記録は、分類表の Cucumber 候補を受け入れ仕様へ移した対応と検証結果を追跡する。
完全に置換した Vitest は削除し、受け入れ仕様より局所的な失敗原因を示すテストだけを Vitest 継続へ再分類する。

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

### 元の Vitest の最終状態

| 分類 ID | 最終状態 | Vitest を継続する局所的な診断価値 |
| --- | --- | --- |
| T312 | 削除 | 復旧手順の表示は受け入れシナリオが同じ driver 結果を完全に置換したため、重複テストを削除した。 |
| T331 | Vitest 継続へ再分類 | `pr-reviewer.precheck.sh` と偽 `gh` の接続および終了コードを局所的に診断する。 |
| T332 | Vitest 継続へ再分類 | 自動マージ無効値を shell 環境から選定処理へ渡す接続を局所的に診断する。 |
| T333 | Vitest 継続へ再分類 | 自動マージ有効値を shell 環境から選定処理へ渡す接続を局所的に診断する。 |
| T334 | Vitest 継続へ再分類 | CI 状態を読み込んだ precheck の終了コードを局所的に診断する。 |
| T335 | Vitest 継続へ再分類 | 現在時刻と外部レビュー待機時間を shell 環境から渡す接続を局所的に診断する。 |
| T336 | Vitest 継続へ再分類 | 外部レビュー無効値を shell 環境から渡す接続を局所的に診断する。 |
| T337 | Vitest 継続へ再分類 | 外部レビュー有効値と Copilot の状態を precheck へ渡す接続を局所的に診断する。 |
| T338 | Vitest 継続へ再分類 | CodeRabbit の状態を precheck へ渡したときの終了コードを局所的に診断する。 |
| T339 | Vitest 継続へ再分類 | shell precheck が下書きを自動化対象として終了コード 0 を返す境界を局所的に診断する。受け入れシナリオは同じ下書きの選定から draft gate までを検査する。 |
| T340 | Vitest 継続へ再分類 | decision CLI の入力読込みと `request_external_review` の直列化を局所的に診断する。 |
| T341 | Vitest 継続へ再分類 | decision CLI の時刻入力と `wait_external_review` の直列化を局所的に診断する。 |
| T342 | Vitest 継続へ再分類 | decision CLI の時刻入力と `fallback_review` の直列化を局所的に診断する。 |
| T343 | Vitest 継続 | 不正な decision mode を拒否する CLI 入力検証を局所的に診断する。 |
| T344 | Vitest 継続 | 不正な待機秒数を拒否する CLI 入力検証を局所的に診断する。 |
| T345 | Vitest 継続 | 不正な日時を拒否する CLI 入力検証を局所的に診断する。 |
| T346 | Vitest 継続へ再分類 | 偽 `herdr agent list` の出力と shell precheck の接続を局所的に診断する。 |
| T347 | Vitest 継続へ再分類 | 稼働中担当者を示す偽 `herdr` 出力と shell precheck の接続を局所的に診断する。 |
| T348 | Vitest 継続へ再分類 | 停止ラベルの環境設定と shell precheck の終了コードを局所的に診断する。 |

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
