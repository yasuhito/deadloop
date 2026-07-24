# Cucumber 移行記録

この記録は [分類表](cucumber-test-classification.md) の ID と受け入れ仕様の対応を追跡する。受け入れシナリオへ移した後も、移行期間中は Vitest の局所的な診断を併存させる。完全な削除は移行仕様の同等性確認と人間レビュー後に行う。

## Issue #128: 公開設定と安全な既定値

受け入れ仕様の正本は [`acceptance/features/public-configuration.feature.md`](../acceptance/features/public-configuration.feature.md) である。

| 分類 ID | 処理 | 移行先シナリオ、統合先、または Vitest 継続理由 |
|---|---|---|
| T076 | Cucumber 移行済み | 「環境変数で指定した設定ファイルを使う」 |
| T077 | Cucumber 移行済み | 「利用者設定を同梱設定より優先する」 |
| T078 | Cucumber 移行済み | 「利用者設定がない場合は同梱設定を使う」 |
| T079 | 一部を Cucumber へ統合、Vitest 継続 | エージェント、自動化、自動マージ、CI 代替、外部レビューの公開既定値は T080、T095、T099、T108、T110、T111 の移行先へ統合した。ID、パス、ラベル、スケジュール、起動方針など、それらのシナリオが観測しない広い既定値契約は `normalizes project configuration defaults from public config fields` に残す。 |
| T080 | Cucumber 移行済み | 「設定を省略した場合は標準の自動化を使う」 |
| T081 | Cucumber 移行済み | 「空の自動化設定は自動化を無効のままにする」 |
| T082 | Vitest 継続 | cron の対応形式を解析する低レベル処理のため。 |
| T083 | Vitest 継続 | cron 文字列の空白除去を検査する低レベル処理のため。 |
| T084 | Vitest 継続 | 未対応 cron の診断を局所的に検査するため。 |
| T085 | Vitest 継続 | 0 分間隔の診断を局所的に検査するため。 |
| T086 | Vitest 継続 | 猶予期間外のスロット計算を検査する純粋関数のため。 |
| T087 | Vitest 継続 | 取り逃したスロットの内部記録を検査するため。 |
| T088 | Vitest 継続 | 現在の cron スロット計算を検査する純粋関数のため。 |
| T089 | Vitest 継続 | 最終実行時刻からの次回スロット計算を検査する純粋関数のため。 |
| T090 | Vitest 継続 | 古い候補を除外するスロット計算を検査する純粋関数のため。 |
| T091 | Vitest 継続 | テンプレート値の文字列描画を検査する低レベル処理のため。 |
| T092 | Vitest 継続 | 自動化スクリプトへ渡す環境変数の組み立てを検査する低レベル処理のため。 |
| T093 | Vitest 継続 | 指示ファイルから指示文を組み立てる文字列整形の診断価値を残すため。 |
| T094 | Vitest 継続 | 明示した指示文と指示ファイルの内部優先順位を局所的に検査するため。 |
| T095 | Cucumber 移行済み | 「設定を省略した Worker は pi を使う」 |
| T096 | Vitest 継続 | 明示した `pi` 値の正規化は現在の受け入れシナリオで観測していないため。 |
| T097 | Cucumber 移行済み | 「指定した Worker エージェントを使う」 |
| T098 | Vitest 継続 | 不正な Worker 値の解析診断は現在の受け入れシナリオで観測していないため。 |
| T099 | Cucumber 移行済み | 「設定を省略した Reviewer は pi を使う」 |
| T100 | Cucumber 移行済み | 「指定した Reviewer エージェントを使う」 |
| T101 | Vitest 継続 | 不正な Reviewer 値の解析診断は現在の受け入れシナリオで観測していないため。 |
| T102 | Vitest 継続 | Worker 起動方針と Pi thinking フラグの独立性は低レベルの起動契約で、現在の受け入れシナリオで観測していないため。 |
| T103 | Cucumber 移行済み | 「指定した Worker モデルをそのまま使う」 |
| T104 | Cucumber 移行済み | 「指定した Reviewer モデルをそのまま使う」 |
| T105 | Vitest 継続 | Worker・Reviewer モデルをプロンプト値へ公開するテンプレート境界の検査であり、モデル解決シナリオとは結果が異なるため。 |
| T106 | Vitest 継続 | Worker エージェントをプロンプト値へ公開するテンプレート境界の検査であり、エージェント解決シナリオとは結果が異なるため。 |
| T107 | Vitest 継続 | Reviewer エージェントをプロンプト値へ公開するテンプレート境界の検査であり、エージェント解決シナリオとは結果が異なるため。 |
| T108 | Cucumber 移行済み | 「設定を省略した場合は自動マージしない」 |
| T109 | Cucumber 移行済み | 「自動マージは明示した場合だけ有効になる」 |
| T110 | 一部を Cucumber へ移行、Vitest 継続 | 「設定を省略した場合は CI 代替を使わない」は無効状態だけを検査する。既定 mode、allowAutoMerge、localCommands は元の Vitest に残す。 |
| T111 | Cucumber 移行済み | 「設定を省略した場合は外部レビューを使わない」 |
| T112 | Vitest 継続 | CI 代替コマンドをプロンプト向けに整形する低レベル処理のため。 |
| T113 | Vitest 継続 | 自動マージ状態をプロンプト値へ公開するテンプレート境界のため。 |
| T114 | Vitest 継続 | 外部レビュー状態をプロンプト値へ公開するテンプレート境界のため。 |
| T115 | Vitest 継続 | automation の driverFile を保持する内部設定値は現在の受け入れシナリオで観測していないため。 |
| T116 | Vitest 継続 | tick 時の再読込と呼出順を検査する低レベル統合のため。 |
| T117 | Vitest 継続 | 共有方針不在時の内部解決経路は現在の受け入れシナリオで観測していないため。 |
| T118 | Cucumber 移行済み | 「ローカルで省略した Worker モデルを共有方針が補う」 |
| T119 | Cucumber 移行済み | 「共有方針はローカルで省略した指示ファイルを補う」 |
| T120 | Cucumber 移行済み | 「ローカルの Worker モデルは共有方針より優先する」 |
| T121 | Vitest 継続 | このリポジトリの共有方針ファイル全体を解析する境界検査のため。 |
| T122 | Vitest 継続 | 共有方針の空 automation 配列を結合する低レベル設定処理のため。 |
| T123 | Vitest 継続 | 共有方針の automation フィールド結合を検査する低レベル設定処理のため。 |
| T124 | Vitest 継続 | 共有方針の driverFile 結合を検査する低レベル設定処理のため。 |
| T125 | Vitest 継続 | 共有方針の外部レビュー設定結合を検査する低レベル設定処理のため。 |
| T126 | Vitest 継続 | 共有方針の禁止キーに対する解析診断を局所的に検査するため。 |
| T127 | Vitest 継続 | 方針取得時の基準ブランチ引数を検査する低レベル呼出契約のため。 |
| T128 | Vitest 継続 | 設定構文エラーの内部 status reason を局所的に検査するため。 |
| T129 | Vitest 継続 | スケジューラーロック所有者の内部判定を局所的に検査するため。 |
| T130 | Vitest 継続 | 拡張ソースの更新時刻警告を検査する低レベル処理のため。 |
| T131 | Vitest 継続 | 表示 ID の小文字 slug 正規化を検査する純粋関数のため。 |
| T132 | Vitest 継続 | 記号だけの表示 ID に対する代替値を検査する純粋関数のため。 |
| T133 | Vitest 継続 | 空の表示 ID に対する代替値を検査する純粋関数のため。 |

この Issue の Cucumber シナリオは、設定を省略した利用者の観測結果と、設定元・共有方針・ローカル設定の優先結果だけを検査する。内部分類値、cron の時刻計算、文字列テンプレート、Git / runner の引数は受け入れ仕様へ持ち込まない。

### 意図的失敗による検出確認

「環境変数で指定した設定ファイルを使う」を対象に、Then の期待値を `paths.environment` から一時的に `/intentionally-wrong/projects.json` へ変更し、次を実行した。

```bash
npx cucumber-js --name '環境変数で指定した設定ファイルを使う'
```

終了コードは 1 だった。失敗したのは対象の一シナリオだけで、`acceptance/steps/public-configuration.steps.ts` の `assert.equal` が実際値 `/environment/projects.json` と一時的な期待値 `/intentionally-wrong/projects.json` の差を報告した。期待値を `paths.environment` に復元し、同じコマンドを再実行して 1 scenario / 5 steps の成功を確認した。続いて `npm run test:acceptance` で全 19 scenarios / 79 steps の成功を確認した。一時的な不正値はコミットしていない。
