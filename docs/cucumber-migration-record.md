# Cucumber 移行記録

この記録は、`docs/cucumber-test-classification.md` の Cucumber 候補を受け入れ仕様へ移した対応を追跡する。分類表の当初の件数と判断根拠を保つため、元表は変更しない。

## ブランチ更新と push の安全制限（Issue #114）

`acceptance/features/branch-update-push-safety.feature.md` は次の分類 ID を移行した。対応する Vitest は、局所的な診断価値を持つ ID だけを残した。

| 分類 ID | 最終結果 | 移行先シナリオ |
|---|---|---|
| T021 | 移行済み | 信頼されていない作業場所では作業エージェントを起動しない |
| T283 | 移行済み | 変更中の作業場所では branch 更新を開始しない |
| T284 | 移行済み | 選択後に head が変わった pull request は branch 更新を開始しない |
| T288 | 同じ保証へ統合 | push 直前に pull request head が変わった場合は branch を更新しない |
| T289 | 移行済み | 別リポジトリの pull request は branch を更新しない |
| T290 | 移行済み | 自動チェックは push 直前の head 確認より先に実行される |
| T291 | 移行済み | 更新できる pull request は選択された branch だけへ非強制で push する |
| T292 | 同じ保証へ統合 | push 直前に pull request head が変わった場合は branch を更新しない |

T285〜T287 は retry key と記録済み試行の低レベル状態を診断するため、Vitest 継続とする。
