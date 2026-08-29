# ADR 0036: 保持中の試行の完了処理は、起動時のスナップショットではなく現行コードで実行する

## Status

Accepted. [ADR 0017](0017-code-snapshot-as-execution-supply.md) を一部修正する。エージェント自身の実行が起動時のコードスナップショットに固定されること、スナップショットが commit ごとに一つで読み取り専用であることは変えない。変えるのは、ホストが行う完了処理のコード供給だけである。

## Context

ADR 0017 で、試行は起動時のコード世代（`code-snapshots/<commit>/`）から動く。監視の引き渡し（`state.json` の `pendingDriverHandoff`）は `input.automationDir` にそのスナップショットの automations ディレクトリを記録し、決定論的な完了処理（`runDeterministicCompletion`）はそこから `complete-deterministic-*-attempt.cts` を起動する。完了処理は各段階（必須検証、push、PR 作成、結果の記録、workspace 閉鎖）を同じディレクトリの兄弟スクリプトとして実行する。

この固定は、完了処理にコードの欠陥があると回復不能になる（Issue #373）。2026-08-29 に実例が出た。`fcdd855e` 以降、`guarded-push.cts` は成功時に stdout へ何も書かず、完了処理はその出力を JSON として読むため、push 直後に「Unexpected end of JSON input」で必ず失敗した。修正を配備して ADR 0035 の取り込みが済んでも、保持中の試行は記録された旧スナップショットの壊れたスクリプトを tick ごとに実行し続け、必須検証（約 90 秒）を数十回やり直した。Issue の試行には PR 側のような「新しい要求で解放する」経路も無く、`state.json` はホストが毎 tick 書き戻すので手編集も当てにならない。つまり、その試行はどの操作でも完了に到達できなかった。

## Decision

完了処理は、ホストが現在ロードしているコード世代から実行する。`applyDeterministicAttemptMonitoring` は完了 directive のとき現行スナップショットの `automationDir` を受け取り、`runDeterministicCompletion` は引き渡しの `input.automationDir` をそれで置き換えて完了スクリプトを起動する。完了スクリプトは兄弟スクリプトを `input.automationDir` から解決するので、置き換えは各段階へ波及する。

置き換えるのは完了処理だけである。エージェントの起動、プロンプト、監視の観測は引き続き起動時のスナップショットに従う。引き渡しに記録された `automationDir` は書き換えない。現行スナップショットが用意できない（依存関係の不一致など）ときは完了処理を始めず、理由を automation の結果に残す。

## Considered options

**固定のまま、人が `state.json` を直す。** 採らない。ホストは `state.json` を tick ごとに書き戻すので、手編集は競合する。

**保持中の引き渡しの `automationDir` を現行世代へ張り替える reconciliation を設ける。** 採らない。記録を書き換えると「起動時に何を使ったか」の証拠が消える。完了処理の入力を実行時に差し替えるほうが、記録と実行の区別が保たれる。

**完了処理も含めて起動時の世代に固定し続ける。** 採らない。完了処理はホスト側の事務処理で、GitHub を書き換える経路である。ここが配備で直せないと、保持中の試行が全て修正不能のまま残る。エージェントの実行と違い、完了処理は途中で世代が変わっても観測可能な副作用が一貫している（各段階が独立に guard されている）。

## Consequences

- 完了処理の欠陥は、修正を main へ入れて ADR 0035 の取り込みが済めば、次の tick で保持中の試行にも届く。
- 完了処理が読む記録（`attempt.json`、`promise.json`、必須検証の証跡）の形式は、旧世代の試行が残っている間は現行コードが読めなければならない。形式を変えるときは、保持中の試行が無いことを確認するか、読み取り側で古い記録を拒否して理由を出す。
- ADR 0033 が完了処理をホストの in-process 関数へ移した時点で、完了処理は自然にホストのコードで動き、本 ADR の差し替えは不要になる。本 ADR はそれまでの spawn 経路に対する決定である。
- `applyDeterministicAttemptMonitoring` の第 4 引数（`{ automationDir }`）が現行世代の供給口になる。テストは代替の完了スクリプトを置いた 2 つのディレクトリで、どちらが実行されたかを観測する。
