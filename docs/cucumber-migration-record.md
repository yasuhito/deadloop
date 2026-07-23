# Cucumber 移行記録

この記録は、`docs/cucumber-test-classification.md` の Cucumber 候補を受け入れ仕様へ移した対応を追跡する。分類表の当初の件数と判断根拠を保つため、元表は変更しない。

## ブランチ更新と push の安全制限（Issue #114）

`acceptance/features/branch-update-push-safety.feature.md` は次の分類 ID を移行した。同等性の人間レビューが完了するまでは、対応する Vitest 8 件も残している。

| 分類 ID | 最終結果 | 移行先シナリオ |
|---|---|---|
| T021 | 移行済み | 信頼されていない作業場所では作業エージェントを起動しない |
| T283 | 移行済み | 変更中の作業場所では branch 更新の作業エージェントを起動しない |
| T284 | 移行済み | 選択後に head が変わった pull request は作業エージェントを起動しない |
| T288 | 同じ保証へ統合 | push 直前に pull request head が変わった場合は branch を更新しない |
| T289 | 移行済み | 別リポジトリの pull request は branch を更新しない |
| T290 | 移行済み | 自動チェックは push 直前の head 確認より先に実行される |
| T291 | 同じ保証を分割 | 更新できる pull request は選択された branch だけへ push する／更新できる pull request は強制せずに push する |
| T292 | 同じ保証へ統合 | push 直前に pull request head が変わった場合は branch を更新しない |

T285〜T287 は retry key と記録済み試行の低レベル状態を診断するため、Vitest 継続とする。

### 同等性確認

移行前の Vitest 8 件と Cucumber 9 シナリオを併存させ、次のコマンドで両方が成功することを確認した。

```bash
npm run test:acceptance
npx vitest run test/agent-trust.test.ts test/pr-branch-update-decision.test.ts test/pr-branch-update-safety.test.ts test/pr-reviewer-driver.test.ts
```

Cucumber は 9 シナリオ 48 ステップ、Vitest は対象 4 ファイル 35 テストが成功した。未コミット変更と古い head のシナリオは、ブランチ更新の実行境界をテスト用 fixture に置き換え、作業エージェントの起動記録がないことを観測する。信頼確認シナリオは `herdr` を記録用の偽物へ置き換え、起動記録がないことを観測する。

### 意図的失敗の確認

「更新できる pull request は強制せずに push する」の期待値を一時的に `false` から `true` へ変更し、`npm run test:acceptance` を実行した。コマンドは終了状態 1 となり、次のシナリオ、位置、差分を報告した。

```text
更新できる pull request は強制せずに push する # acceptance/features/branch-update-push-safety.feature.md:49
ならばbranch は強制せずに push される # acceptance/steps/branch-update-push-safety.steps.ts:213
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

false !== true

    + expected - actual

    -false
    +true

    at World.<anonymous> (.../acceptance/steps/branch-update-push-safety.steps.ts:214:10)

9 scenarios (8 passed, 1 failed)
48 steps (47 passed, 1 failed)
```

確認後、期待値は `false` に戻した。
