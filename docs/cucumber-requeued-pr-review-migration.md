# 修正後の PR レビュー再開の Cucumber 移行記録

Issue [#124](https://github.com/yasuhito/deadloop/issues/124) では、修正または競合回復で head が変わった pull request を再投入したとき、終了済みのレビュー担当を片付けて通常レビューを一度だけ再開する契約を移行した。新しい正本は [`acceptance/features/requeued-pr-review.feature.md`](../acceptance/features/requeued-pr-review.feature.md) である。

## 分類 ID と関連する保証

| 分類 ID | 移行先または扱い | 最終状態 |
| --- | --- | --- |
| T349 | 「更新された pull request は通常レビューを一度だけ再開する」 | 移行済み。重複する Vitest を削除 |
| T002 | [`worker-launch-and-monitoring.feature.md`](../acceptance/features/worker-launch-and-monitoring.feature.md) の完了済み同名担当の交代 | Issue #119 で移行・Vitest 削除済み |
| T003〜T005 | 同じ正本の稼働中、複数候補、別作業場所に対する起動拒否 | Issue #119 で移行・Vitest 削除済み |
| T318, T320, T322 | [`bounded-pr-recovery.feature.md`](../acceptance/features/bounded-pr-recovery.feature.md) の競合回復開始、更新後の通常レビュー、レビュー状態維持 | Issue #116 で移行済み。driver の局所診断として Vitest 継続 |

T349 のシナリオは、pull request の head を修正前の `dead43` から修正後の `feed44` へ変えて `agent:review` に再投入する。実行基盤に同名の終了済み担当が残る状態でも新しいレビュー担当が一人だけ起動されることと、レビュー担当へ渡すプロンプトの expected head が `feed44` であることを、別々のシナリオと assertion で確認する。終了済み担当を片付けなければ起動は拒否されるため、起動数の結果は安全な交代も含む。稼働中担当の重複起動防止、および競合回復中の `agent:review` と `agent:reviewing` の維持から更新後の通常レビューへの復帰は、先行する正本と組み合わせて Issue #124 の安全境界を保証する。

## 同等性と Vitest の扱い

削除前の `test/pr-reviewer-relaunch-integration.test.ts` と新しい Cucumber シナリオを併存させ、同じ pull request と同じ終了済み担当を再投入後の選定周期へ与えた。どちらも、終了済み担当が残る既存作業場所で、同名の新しいレビュー担当が一人だけ起動されることを検出した。Cucumber 側ではさらに、修正前と修正後に異なる head OID を与え、起動されたレビュー担当への引き継ぎが修正後の OID を含むことを検出する。元の Vitest が併せて確認していた片付け順は、T002 の既存受け入れシナリオが同じ製品境界で保証する。

元の Vitest はこの端から端の保証以外に、純粋関数、引数変換、解析、静的ファイル検査などの局所的な診断価値を持たない。Cucumber の失敗表示でもシナリオ、結果ステップ、実際の起動数と期待した起動数の差を特定できるため、完全に置換して削除した。

## 意図的な失敗確認

2026-07-25 に、結果ステップが期待するレビュー担当の起動数を `1` から `2` へ一時的に変更し、対象シナリオだけを実行した。終了コード 1 となり、`requeued-pr-review.feature.md` のシナリオ位置、`requeued-pr-review.steps.ts` の結果ステップと assertion の位置、実際値 `1` と誤った期待値 `2` の差が表示された。

同日、修正後の head の assertion が期待する値を `feed44` から修正前の `dead43` へ一時的に変更し、「更新された pull request の head をレビュー担当へ引き継ぐ」シナリオだけを実行した。終了コード 1 となり、シナリオ位置 `acceptance/features/requeued-pr-review.feature.md:14`、結果ステップ位置 `acceptance/steps/requeued-pr-review.steps.ts:157`、assertion 位置 `acceptance/steps/requeued-pr-review.steps.ts:171` と、実際の head `feed44` に対して誤った期待値が `dead43` である差が表示された。

期待値を直ちに元へ戻し、各対象シナリオが成功することと意図的な変更が作業ツリーに残っていないことを確認した。
