# Cucumber 移行記録

この記録は、`docs/cucumber-test-classification.md` の Cucumber 候補を受け入れ仕様へ移した対応を追跡する。分類表の当初の件数と判断根拠を保つため、元表は変更しない。

## ブランチ更新と push の安全制限（Issue #114）

`acceptance/features/branch-update-push-safety.feature.md` には 7 シナリオを追加した。次の表は、各分類 ID の移行結果を示す。同等性の人間レビューが完了するまでは、対応する Vitest 9 件も残している。

| 分類 ID | 最終結果 | 移行先または再分類理由 |
|---|---|---|
| T021 | 移行済み | 信頼されていない作業場所では作業エージェントを起動しない |
| T253 | T021 と同じシナリオへ統合 | 信頼されていない作業場所では作業エージェントを起動しない |
| T283 | Vitest 継続 | `--fixture` 経由で `decideBranchUpdateFixture` が返す純粋な `decideBranchUpdate` の内部判断結果を確認する単体テストであり、更新実行境界の外部結果ではないため受け入れ仕様へ移行しない |
| T284 | Vitest 継続 | `--fixture` 経由で `decideBranchUpdateFixture` が返す純粋な `decideBranchUpdate` の内部判断結果を確認する単体テストであり、更新実行境界の外部結果ではないため受け入れ仕様へ移行しない |
| T288 | 移行済み | 自動チェックの完了時に変わった pull request head は、その後の再照会で古い head として報告する |
| T289 | 移行済み | 別リポジトリの pull request は branch を更新しない |
| T290 | T288 と同じシナリオへ統合 | 自動チェック完了後に head を変更するアダプターにより、再照会がチェックより後であることを外部結果として確認する |
| T291 | 移行済み | 更新できる pull request は選択された branch だけへ push する／更新できる pull request は強制せずに push する |
| T292 | 同じ保証へ統合 | push 直前に pull request head が変わった場合は branch を更新しない |

T285〜T287 は retry key と記録済み試行の低レベル状態を診断するため、Vitest 継続とする。

### 同等性確認

元の分類に対応する Vitest 9 件を残したまま、追加した Cucumber 7 シナリオを次のコマンドで確認した。`npm run test:acceptance` は、追加した 7 シナリオを既存の受け入れスイートとともに実行する。

```bash
npm run test:acceptance
npx vitest run test/agent-trust.test.ts test/launch-agent-integration.test.ts test/pr-branch-update-decision.test.ts test/pr-branch-update-safety.test.ts test/pr-reviewer-driver.test.ts
```

Cucumber は追加分 7 シナリオ、スイート全体 23 シナリオ 128 ステップが成功し、Vitest は対象 5 ファイル 56 テストが成功した。T283 と T284 は内部判断を観測する単体テストとして Vitest に残し、受け入れ仕様への移行対象から外した。自動チェック後の dirty 状態は finalizer 境界の追加保証として別シナリオに残す。push 直前に変わった head のシナリオでは、テスト用アダプターが自動チェック完了時に head を変更する。その後の再照会による `action=stale_head` と push 記録がないことを別々に観測するため、head 再照会をチェックより前へ移す回帰も検出する。信頼確認シナリオは `herdr` を記録用の偽物へ置き換え、起動記録がないことを観測する。この信頼確認は、信頼判定の T021 と Herdr を起動しない統合動作の T253 を一つの外部結果で同時に覆う。finalizer の fixture は有効化検証済みの project 情報、検証済み push URL、検証開始時に固定した candidate OID を使う。Vitest のコマンド順検査も局所的な診断として残す。

### 意図的失敗の確認

各移行先について期待する外部結果を一時的に壊し、毎回 `npm run test:acceptance` が終了状態 1 となることを確認した。結果は次のとおり。いずれも失敗したシナリオ名、feature と step の位置、期待値との差分を報告した。

| 分類 ID | 一時的に与えた失敗 | 報告された結果 |
|---|---|---|
| T021、T253 | 起動記録があることを期待 | 「信頼されていない作業場所では作業エージェントを起動しない」が失敗 |
| T288、T290 | head の再照会を自動チェックより前へ移す | 「push 直前に変わった pull request head は古い head として報告する」が失敗 |
| T292 | head の再照会を自動チェックより前へ移す | 「push 直前に pull request head が変わった場合は branch を更新しない」が push 記録を報告して失敗 |
| T289 | push があることを期待 | 「別リポジトリの pull request は branch を更新しない」が失敗 |
| T291 | 本番の git push 引数に別 branch または tag の refspec、あるいは `--follow-tags` を追加 | 「更新できる pull request は選択された branch だけへ push する」が送信先の差分を報告して失敗 |
| T291 | 本番の git push 引数へ `--force`、`-fq`、`-qf` を一つずつ追加 | 「更新できる pull request は強制せずに push する」だけが force 系オプションを報告して失敗 |

送信先のシナリオは成功した `git push` の remote と refspec、および追加の送信先を生む引数だけを観測し、force 指定の有無は観測しない。非強制 push のシナリオは成功した push が一つあり、そのコマンドに force 系オプションがないことを独立して確認する。本番コマンドへ `HEAD:refs/heads/other`、`HEAD:refs/tags/review-test`、`--follow-tags`、`--force`、`-fq`、`-qf`、`--mirror` を一つずつ追加した確認では、対応するシナリオが終了状態 1 となり、追加引数を期待値との差分として報告した。`--mirror` は送信先を増やすと同時に強制 push も指定するため、二つの T291 シナリオが失敗した。短いオプションの解析は `--` で終了し、以後の `-f` はオプションとして扱わない。確認のたびに一時変更を戻した。最後に変更のない期待値で再実行し、23 シナリオ 128 ステップが成功した。

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
| T341 | 外部レビュー待ちでは通常レビューを開始しない |
| T342 | 外部レビューの待機期限が切れたら通常レビューを開始する |
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
| T340 | `githubEffects` に `add_pr_reviewer`（担当者 `@copilot`）が含まれる期待値を `true` から `false` に変更 | 「外部レビューをまだ依頼していない pull request には外部レビューを依頼する」だけが失敗し、`true !== false`、20シナリオ中19件成功・1件失敗を表示 |
| T341 | `testAdapterEffects.herdrStarts` の件数の期待値を `0` から `1` に変更 | 同じ結果ステップを使う「外部レビュー待ちでは通常レビューを開始しない」と「下書きの pull request はレビューを開始しない」の2件が失敗し、実値 `0` と期待値 `1` の差分を表示 |
| T342 | `testAdapterEffects.herdrStarts` の件数の期待値を `1` から `0` に変更 | 「外部レビューの待機期限が切れたら通常レビューを開始する」だけが失敗し、実値 `1` と期待値 `0` の差分を表示 |
| T339 | `testAdapterEffects.herdrStarts` の件数の期待値を `0` から `1` に変更 | 同じ結果ステップを使う「下書きの pull request はレビューを開始しない」と「外部レビュー待ちでは通常レビューを開始しない」の2件が失敗し、実値 `0` と期待値 `1` の差分を表示 |
| T312 | 復旧手順の正規表現を存在しない見出しへ変更 | 「下書きの pull request には復旧手順を示す」だけが失敗し、実際のコメントと不一致の正規表現を表示 |

各実行の直後に変更を元へ戻した。最後に通常の `npm run test:acceptance` が成功することと、意図的な変更が作業ツリーに残っていないことを確認した。

## Issue #122: 古いレビュー占有だけを回収する

正本は [`acceptance/features/stale-review-claim-recovery.feature.md`](../acceptance/features/stale-review-claim-recovery.feature.md) である。
スケジューラーがレビュー処理を直列化する契約に基づき、`agent:reviewing` が残っていて対応する実働担当がいない状態を中断された古い占有として扱う。
稼働中のレビュー担当、ブランチ更新担当の完了を待つ猶予中、`agent:blocked` による意図的な停止は回収せず、回収後に新しい担当が稼働した次周期でも同じ pull request を重ねて選ばない。

| 分類 ID | Cucumber 移行結果 | 移行先または再分類理由 | 元 Vitest の最終状態・局所的な診断価値 |
| --- | --- | --- | --- |
| T350 | 移行済み | 実働担当がいない古いレビュー占有を回収する | 継続。判定用 CLI を通した選択結果を局所的に診断する。 |
| T351 | Vitest 継続へ再分類 | 中断後の再開区分は内部判定フラグであり、外部から同じ保証を表現できない。 | 継続。内部の再開区分を局所的に診断する。 |
| T352 | 移行済み | レビュー担当が稼働中の占有を回収しない | 継続。判定用 CLI を通した非選択理由を局所的に診断する。 |
| T353 | 移行済み | ブランチ更新担当の完了を待つ猶予中の占有を回収しない | 継続。判定用 CLI と担当一覧の接続を局所的に診断する。 |
| T354 | 移行済み | 終了済みのレビュー担当だけが残る占有を回収する | 継続。終了済み担当を除外する選択判定を局所的に診断する。 |
| T355 | 移行済み | 意図的に停止されたレビュー占有を回収しない | 継続。停止ラベルによる非選択判定を局所的に診断する。 |
| T356 | Vitest 継続へ再分類 | 通常開始区分は内部判定フラグであり、外部から同じ保証を表現できない。 | 継続。内部の通常開始区分を局所的に診断する。 |

「回収後に新しい担当が稼働した占有を重ねて回収しない」は、回収済みで新しい担当が稼働している状態から次の選定周期を実行し、追加の担当が起動されないことを保証する。
T350、T352〜T355 は、元の Vitest と同じ PR・担当状態を決定論的な選定境界へ与え、Cucumber と Vitest が併存した状態で双方の成功を確認した。T351 と T356 は外部から同じ保証を表現できないため、移行仕様 §9 に従って Cucumber 移行を停止した。
元の Vitest 7件は、判定用 CLI の引数、検証用データの読込み、JSON 直列化、内部の再開区分を局所的に診断する価値が残るため継続する。

### 意図的失敗の確認

2026-07-24 に移行済み ID の Then assertion を一種類ずつ一時変更した。重複防止シナリオを一つの外部結果へ修正した 2026-07-25 にも、その Then assertion を一時変更した。各変更後に `npm run test:acceptance` が終了状態 1 となることを確認した。

| 対象 | 一時的な変更 | 観測した失敗 |
| --- | --- | --- |
| T350、T354 | 選択番号の期待値を `number + 1` に変更 | 対応する2シナリオだけが失敗し、128件中126件成功・2件失敗を表示 |
| T352、T353、T355 | 非回収の期待値を `false` から `true` に変更 | 対応する3シナリオだけが失敗し、125件成功・3件失敗を表示 |
| 回収後の重複防止 | 追加起動数の期待値を `0` から `1` に変更 | 対応する1シナリオだけが失敗し、125件成功・1件失敗を表示。実値 `0` と期待値 `1` の差分を確認 |

T351 と T356 は Vitest 継続へ再分類したため、Cucumber の意図的失敗確認の対象外とした。

すべての出力でシナリオ名、`.feature.md` と `.steps.ts` の位置、実値と期待値の差分を確認した。
各実行の直後に一時変更を戻し、通常の受け入れテストが成功することと意図的な変更が残っていないことを再確認した。
