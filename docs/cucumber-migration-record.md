# Cucumber 移行記録

この記録は、`docs/cucumber-test-classification.md` の Cucumber 候補を受け入れ仕様へ移した対応を追跡する。分類表の当初の件数と判断根拠を保つため、元表は変更しない。

## ブランチ更新と push の安全制限（Issue #114）

`acceptance/features/branch-update-push-safety.feature.md` には 7 シナリオを追加した。次の表は、各分類 ID の移行または再分類の結果を示す。同等性の人間レビューが完了するまでは、対応する Vitest 9 件も残している。

| 分類 ID | 最終結果 | 移行先または再分類理由 |
|---|---|---|
| T021 | 移行済み | 信頼されていない作業場所では作業エージェントを起動しない |
| T253 | T021 と同じシナリオへ統合 | 信頼されていない作業場所では作業エージェントを起動しない |
| T283 | 移行済み | branch 更新の選定境界で、未コミット変更があると機械更新も作業エージェントへの委譲も開始しない |
| T284 | Vitest 継続へ再分類 | fixture 専用の head 判定であり、本番のブランチ更新経路では同じ前提を作れないため `test/pr-branch-update-decision.test.ts` に残す |
| T288 | 移行済み | 自動チェックの完了時に変わった pull request head は、その後の再照会で古い head として報告する |
| T289 | 移行済み | 別リポジトリの pull request は branch を更新しない |
| T290 | T288 と同じシナリオへ統合 | 自動チェック完了後に head を変更するアダプターにより、再照会がチェックより後であることを外部結果として確認する |
| T291 | 移行済み | 更新できる pull request は選択された branch だけへ push する／更新できる pull request は強制せずに push する |
| T292 | 同じ保証へ統合 | push 直前に pull request head が変わった場合は branch を更新しない |

T285〜T287 は retry key と記録済み試行の低レベル状態を診断するため、Vitest 継続とする。

### 同等性確認

元の分類に対応する Vitest 9 件を残したまま、追加した Cucumber 7 シナリオを次のコマンドで確認した。`npm run test:acceptance` は、追加した 7 シナリオに既存の project-check シナリオ 1 件を加えたスイート全体を実行する。

```bash
npm run test:acceptance
npx vitest run test/agent-trust.test.ts test/launch-agent-integration.test.ts test/pr-branch-update-decision.test.ts test/pr-branch-update-safety.test.ts test/pr-reviewer-driver.test.ts
```

Cucumber は追加分 7 シナリオ、スイート全体 8 シナリオ 44 ステップが成功し、Vitest は対象 5 ファイル 39 テストが成功した。変更中の作業場所のシナリオは、branch 更新の選定境界へ未コミット変更を渡し、作業エージェントの起動記録と push 記録がどちらもないことを一つの結果として観測する。push 直前に変わった head のシナリオでは、テスト用アダプターが自動チェック完了時に head を変更する。その後の再照会による `action=stale_head` と push 記録がないことを別々に観測するため、head 再照会をチェックより前へ移す回帰も検出する。信頼確認シナリオは `herdr` を記録用の偽物へ置き換え、起動記録がないことを観測する。この信頼確認は、信頼判定の T021 と Herdr を起動しない統合動作の T253 を一つの外部結果で同時に覆う。Vitest のコマンド順検査も局所的な診断として残す。

### 意図的失敗の確認

各移行先について期待する外部結果を一時的に壊し、毎回 `npm run test:acceptance` が終了状態 1 となることを確認した。結果は次のとおり。いずれも失敗したシナリオ名、feature と step の位置、期待値との差分を報告した。

| 分類 ID | 一時的に与えた失敗 | 報告された結果 |
|---|---|---|
| T021、T253 | 起動記録があることを期待 | 「信頼されていない作業場所では作業エージェントを起動しない」が失敗 |
| T283 | branch 更新の選定から dirty worktree 判定を外す | 「変更中の作業場所からは branch を更新しない」が作業エージェントの起動記録を報告して失敗（7 passed, 1 failed） |
| T288、T290 | head の再照会を自動チェックより前へ移す | 「push 直前に変わった pull request head は古い head として報告する」が失敗 |
| T292 | head の再照会を自動チェックより前へ移す | 「push 直前に pull request head が変わった場合は branch を更新しない」が push 記録を報告して失敗 |
| T289 | push があることを期待 | 「別リポジトリの pull request は branch を更新しない」が失敗 |
| T291 | 本番の git push 引数に別 branch または tag の refspec を追加 | push 成功時の完全な引数列を確認する 2 シナリオが失敗（6 passed, 2 failed） |
| T291 | 本番の git push 引数へ `--force` または `--mirror` を追加 | push 成功時の完全な引数列を確認する 2 シナリオが失敗（6 passed, 2 failed） |

送信先と push 方法は、成功した `git push` の完全な引数列が次の値だけであることを確認する。

```text
git -C /worktree push --porcelain origin HEAD:refs/heads/agent/issue-31
```

本番コマンドへ `HEAD:refs/heads/other`、`HEAD:refs/tags/review-test`、`--force`、`--mirror` を一つずつ追加した確認では、いずれも終了状態 1 となり、追加引数を期待値との差分として報告した。確認のたびに一時変更を戻した。最後に変更のない期待値で再実行し、8 シナリオ 44 ステップが成功した。
