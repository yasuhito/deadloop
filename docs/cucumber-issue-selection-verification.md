# Issue 選択の Cucumber 移行記録

Issue #117 では、公開ラベルと依存関係から着手可能な Issue だけを選ぶ保証を、日本語の実行可能な受け入れ仕様へ移した。製品コードは変更していない。

## 分類 ID と受け入れ仕様の対応

| 分類 ID | 以前の Vitest の保証 | 移行先 |
|---|---|---|
| T243 | `ready-for-agent` と `agent:implement` を持つ Issue を選ぶ | `issue-selection.feature.md` の「準備済みの Issue を作業対象に選ぶ」 |
| T244 | `agent:in-progress` の Issue を選ばない | `issue-selection.feature.md` の「作業中の Issue を作業対象に選ばない」 |
| T245 | 本文の未完了依存を持つ Issue を選ばない | `issue-selection.feature.md` の「未完了の本文依存を持つ Issue を作業対象に選ばない」の「依存欄」例 |
| T246 | 本文の依存が完了後は Issue を選ぶ | `issue-selection.feature.md` の「完了した本文依存を持つ Issue を作業対象に選ぶ」 |
| T247 | GitHub の未完了依存を持つ Issue を選ばない | `issue-selection.feature.md` の「GitHub 上の未完了の依存を持つ Issue を作業対象に選ばない」 |
| T248 | 本文末尾の未完了依存を持つ Issue を選ばない | `issue-selection.feature.md` の「未完了の本文依存を持つ Issue を作業対象に選ばない」の「末尾」例 |

Issue #117 が求める選定対象外の状態を網羅するため、次のシナリオも追加した。

| 状態 | fixture | 受け入れ仕様 |
|---|---|---|
| 必要な公開ラベルが不足した準備不足 | `selection-missing-required-label.json` | 「準備不足の Issue を作業対象に選ばない」 |
| `agent:blocked` が付いた停止中 | `selection-blocked.json` | 「停止中の Issue を作業対象に選ばない」 |

各シナリオは既存の決定論的な Issue 選定コマンドを fixture で実行する。選定しないシナリオは選定結果を、選定する T243 と T246 のシナリオはそれぞれ Issue 番号 1 と 2 を Then の一つの assertion で観測する。したがって、以前のテストと同じ事前状態（公開ラベル、本文または GitHub の依存状態）および契機（Issue 選定）に対して、同じ利用者観測可能な選定結果と選定された Issue の同一性を確認する。

## 意図的な失敗の確認

2026-07-23 に「準備済みの Issue を作業対象に選ぶ」の Then を一時的に `false` を期待するよう変更して、`npm run test:acceptance` を実行した。コマンドは status 1 で終了し、`acceptance/features/issue-selection.feature.md:8` の対象シナリオ、`acceptance/steps/issue-selection.steps.ts:49` の Then、`true !== false` の assertion 差分を報告した。確認後に assertion は `true` を期待する状態へ戻した。

既存の `test/issue-coordinator-selection.test.ts` からは、完全に置換した T243〜T248 の6件を削除した。CLI の help と未知の引数に関する T249、T250 は低レベル診断として Vitest に残している。
