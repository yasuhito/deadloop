# PR レビュー遷移の Cucumber 移行記録

Issue [#123](https://github.com/yasuhito/deadloop/issues/123) では、PR、CI、外部レビュー、競合の現在状態から次のレビュー処理へ進む公開契約を移行した。新しい正本は [`acceptance/features/pr-review-transitions.feature.md`](../acceptance/features/pr-review-transitions.feature.md) であり、先に移行済みの外部レビューと競合の正本も下表から参照する。

## 分類 ID の対応

| 分類 ID | 移行先シナリオまたは扱い | 最終状態 |
| --- | --- | --- |
| T307 | レビュー対象がなければレビュー処理を開始しない | 移行済み。重複する Vitest を削除 |
| T308 | CI 実行中は完了を待つ | 移行済み。重複する Vitest を削除 |
| T309 | 外部レビューが無効なら通常レビューを開始する | 移行済み。重複する Vitest を削除 |
| T310 | `pr-reviewer-selection.feature.md` の「外部レビュー待ちでは通常レビューを開始しない」へ統合 | 移行済み。重複する Vitest を削除 |
| T311 | `pr-reviewer-selection.feature.md` の「外部レビューをまだ依頼していない pull request には外部レビューを依頼する」へ統合 | 移行済み。重複する Vitest を削除 |
| T312 | `pr-reviewer-selection.feature.md` の「下書きの pull request には復旧手順を示す」 | Issue #121 で移行・Vitest 削除済み |
| T313 | `pr-reviewer-selection.feature.md` の「外部レビューの待機期限が切れたら通常レビューを開始する」へ統合 | 移行済み。重複する Vitest を削除 |
| T314 | 該当なし | Vitest 継続（promise file の配置を局所診断） |
| T315 | 該当なし | Vitest 継続へ再分類（検証隔離 helper を含む監視プロンプトを局所診断） |
| T316 | 自動マージが無効のまま通常レビューへ遷移する | 移行済み。重複する Vitest を削除 |
| T317 | 該当なし | Vitest 継続（起動責務を LLM に渡さないプロンプト境界を局所診断） |
| T318, T320, T322, T323 | `bounded-pr-recovery.feature.md` の競合回復シナリオ | Issue #116 で移行済み。driver の局所診断として Vitest 継続 |
| T319 | 該当なし | Vitest 継続（head/base ごとの再試行キーを局所診断） |
| T321 | 該当なし | Vitest 継続（決定論的 finalizer の安全指示を局所診断） |
| T324 | 該当なし | Vitest 継続（決定論的な担当者名を局所診断） |

「古い head の外部レビュー依頼を現在の依頼として使わない」は、分類後に明確になった head 単位の安全例として追加した。現在 head と一致しない依頼印は待機や承認に流用せず、現在 head への新しい外部レビュー依頼だけを観測する。

## 残す Vitest の診断価値

T314、T315、T317、T319、T321、T324 は、公開遷移ではなく promise file の配置、監視プロンプト、起動責務、再試行キー、finalizer 指示、担当者名のどこが壊れたかを直接示す。このため、同じ PR 状態から利用者向けの遷移を確認する Cucumber へ置き換えず、Vitest に残す。競合の T318、T320、T322、T323 も、受け入れ仕様に加えて driver の分岐と保持ラベルを局所診断するため、先行移行の判断どおり残す。

## 同等性と意図的な失敗確認

削除した Vitest と Cucumber は、同じ driver fixture と決定論的テスト用アダプターを使う。レビュー処理なし、CI 待機、通常レビュー起動、外部レビュー待機・依頼・期限切れ、`autoMerge: false` の引き渡しについて、同じ事前状態と契機から同じ利用者観測結果になることを確認した。

2026-07-24 に「外部レビューが無効なら通常レビューを開始する」の起動数期待値を一時的に `1` から `2` へ変更し、そのシナリオだけを実行した。終了コード 1 となり、Feature のシナリオ位置、`pr-review-transitions.steps.ts` の Then と assertion の位置、実値 `1` と誤った期待値 `2` の差を表示した。期待値を直ちに `1` へ戻し、意図的な変更が残っていない状態で受け入れテストと全検証を再実行した。
