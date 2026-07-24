# Issue 選択の Cucumber 移行記録

Issue #117 では、公開ラベル、依存関係、Issue の状態から着手可能な Issue だけを選ぶ保証を、日本語の実行可能な受け入れ仕様へ移した。製品コードは変更していない。

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

| 状態 | fixture または境界 | 受け入れ仕様 |
|---|---|---|
| 必要な公開ラベルが不足した準備不足 | `selection-missing-required-label.json` | 「準備不足の Issue を作業対象に選ばない」 |
| `agent:blocked` が付いた停止中 | `selection-blocked.json` | 「停止中の Issue を作業対象に選ばない」 |
| 必要な公開ラベルがそろったクローズ済み Issue | coordinator の事前確認と `gh issue list` のスタブ | 「クローズ済みの Issue を作業対象に選ばない」 |

ラベルと依存関係の各シナリオは既存の決定論的な Issue 選定コマンドを fixture で実行する。選定しないシナリオは選定結果を、選定する T243 と T246 のシナリオはそれぞれ Issue 番号 1 と 2 を Then の一つの assertion で観測する。したがって、以前のテストと同じ事前状態（公開ラベル、本文または GitHub の依存状態）および契機（Issue 選定）に対して、同じ利用者観測可能な選定結果と選定された Issue の同一性を確認する。

クローズ済み Issue のシナリオは、決定コマンドへ直接 fixture を渡さず、coordinator の事前確認を起動する。実際の GitHub CLI と同様に、`gh issue list` の状態指定がない場合と `--state open` の場合は候補なしを返し、`--state all` の場合だけ公開ラベルがそろったクローズ済み Issue を返すスタブにより、本番と同じ GitHub 一覧取得境界を通す。事前確認の終了状態 1 を一つの assertion で観測し、クローズ済み Issue が作業対象にないことを確認する。2026-07-24 に `npm run test:acceptance` を実行し、10シナリオ、41ステップがすべて成功した。

## Vitest と Cucumber の併存確認

2026-07-24 に、削除前の T243〜T248 の6テストを `test/issue-coordinator-selection.test.ts` へ一時的に復元し、置換後の Cucumber シナリオと併存させた。`npm run test:unit` は test files 44件、tests 496件がすべて成功し、このファイルの8テスト（T243〜T250を含む）も成功した。続けて `npm run test:acceptance` を実行し、9シナリオ、37ステップがすべて成功した。これにより、同じ製品コードに対して T243〜T248 の Vitest と対応する Cucumber の正常系がともに成功することを確認した。確認後、完全に置換済みの T243〜T248 だけを再度削除し、低レベル診断として残す T249、T250 は変更していない。

## 意図的な失敗の確認

2026-07-24 に Issue 番号を確認する Then の期待値へ一時的に 1000 を加えて、`npm run test:acceptance` を実行した。コマンドは status 1 で終了し、「準備済みの Issue を作業対象に選ぶ」 (`acceptance/features/issue-selection.feature.md:8`) と「完了した本文依存を持つ Issue を作業対象に選ぶ」 (`acceptance/features/issue-selection.feature.md:50`) が失敗した。どちらも `acceptance/steps/issue-selection.steps.ts:132` の Then と同ファイル `:133` の assertion を指し、それぞれ `1 !== 1001` (`-1`, `+1001`) と `2 !== 1002` (`-2`, `+1002`) の差分を報告した。確認後に assertion は引数で渡された Issue 番号を期待する状態へ戻した。

同日に、選定対象外を確認する3つの Then の期待値を一時的に `true` へ変えて、`npm run test:acceptance` を実行した。コマンドは status 1 で終了し、T244 の「作業中」 (`acceptance/features/issue-selection.feature.md:26`、Then `acceptance/steps/issue-selection.steps.ts:144`、assertion `:145`)、T245 の「依存欄」 (`acceptance/features/issue-selection.feature.md:47`、Then `:152`、assertion `:153`)、T248 の「末尾」 (feature `:48`、Then `:152`、assertion `:153`)、T247 の「GitHub 上の未完了の依存」 (feature `:56`、Then `:156`、assertion `:157`) の4シナリオが失敗した。各失敗は `false !== true` と `-false` / `+true` の差分を報告した。期待値を `false` へ戻した後、同じコマンドが9シナリオ、37ステップで成功することを確認した。

同日に、新規追加した2つの選定対象外シナリオについても、各 Then の期待値を一時的に `true` へ変えて `npm run test:acceptance` を実行した。コマンドは status 1 で終了し、「準備不足」 (`acceptance/features/issue-selection.feature.md:20`、Then `acceptance/steps/issue-selection.steps.ts:140`、assertion `:141`) と「停止中」 (`acceptance/features/issue-selection.feature.md:32`、Then `acceptance/steps/issue-selection.steps.ts:148`、assertion `:149`) の2シナリオだけが意図どおり失敗した。どちらも実際値 `false` と一時的な期待値 `true` の不一致を示す `false !== true` および `-false` / `+true` の差分を報告した。確認後に両方の期待値を `false` へ戻した。

同日に、coordinator の事前確認の `--state open` を一時的に `--state all` へ変えて `npm run test:acceptance` を実行した。コマンドは status 1 で終了し、「クローズ済みの Issue を作業対象に選ばない」 (`acceptance/features/issue-selection.feature.md:14`) だけが失敗した。`acceptance/steps/issue-selection.steps.ts:136` の Then と `:137` の assertion を指し、事前確認の実際の終了状態 0 と期待値 1 の不一致を `0 !== 1` (`-0`, `+1`) と報告した。`--state open` を戻した後、同じコマンドが10シナリオ、41ステップで成功することを確認した。

既存の `test/issue-coordinator-selection.test.ts` からは、完全に置換した T243〜T248 の6件を削除した。CLI の help と未知の引数に関する T249、T250 は低レベル診断として Vitest に残している。
