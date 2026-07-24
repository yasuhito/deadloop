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

2026-07-24 に Issue 番号を確認する Then の期待値へ一時的に 1000 を加えて、`npm run test:acceptance` を実行した。コマンドは status 1 で終了し、「準備済みの Issue を作業対象に選ぶ」 (`acceptance/features/issue-selection.feature.md:8`) と「完了した本文依存を持つ Issue を作業対象に選ぶ」 (`acceptance/features/issue-selection.feature.md:44`) が失敗した。どちらも `acceptance/steps/issue-selection.steps.ts:68` の Then と同ファイル `:69` の assertion を指し、それぞれ `1 !== 1001` (`-1`, `+1001`) と `2 !== 1002` (`-2`, `+1002`) の差分を報告した。確認後に assertion は引数で渡された Issue 番号を期待する状態へ戻した。

同日に、選定対象外を確認する3つの Then の期待値を一時的に `true` へ変えて、`npm run test:acceptance` を実行した。コマンドは status 1 で終了し、T244 の「作業中」 (`acceptance/features/issue-selection.feature.md:20`、Then `acceptance/steps/issue-selection.steps.ts:76`、assertion `:77`)、T245 の「依存欄」 (`acceptance/features/issue-selection.feature.md:41`、Then `:84`、assertion `:85`)、T248 の「末尾」 (feature `:42`、Then `:84`、assertion `:85`)、T247 の「GitHub 上の未完了の依存」 (feature `:50`、Then `:88`、assertion `:89`) の4シナリオが失敗した。各失敗は `false !== true` と `-false` / `+true` の差分を報告した。期待値を `false` へ戻した後、同じコマンドが9シナリオ、37ステップで成功することを確認した。

同日に、新規追加した2つの選定対象外シナリオについても、各 Then の期待値を一時的に `true` へ変えて `npm run test:acceptance` を実行した。コマンドは status 1 で終了し、「準備不足」 (`acceptance/features/issue-selection.feature.md:14`、Then `acceptance/steps/issue-selection.steps.ts:72`、assertion `:73`) と「停止中」 (`acceptance/features/issue-selection.feature.md:26`、Then `acceptance/steps/issue-selection.steps.ts:80`、assertion `:81`) の2シナリオだけが意図どおり失敗した。どちらも実際値 `false` と一時的な期待値 `true` の不一致を示す `false !== true` および `-false` / `+true` の差分を報告した。確認後に両方の期待値を `false` へ戻した。

既存の `test/issue-coordinator-selection.test.ts` からは、完全に置換した T243〜T248 の6件を削除した。CLI の help と未知の引数に関する T249、T250 は低レベル診断として Vitest に残している。
