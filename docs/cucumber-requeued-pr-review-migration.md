# 修正後の PR レビュー再開の Cucumber 移行記録

> **後継仕様あり:** この文書にある同名担当の交代、`pane close`、既存端末の再利用は過去の移行証拠であり、現在の実行契約ではない。現在は [試行ごとに破棄する Herdr 実行場所のライフサイクル](herdr-attempt-workspace-lifecycle-spec.md) に従い、起動ごとに一意な担当名と新しい実行場所を使い、永続化を確認した成功済み試行では実行場所だけを閉じる。

Issue [#124](https://github.com/yasuhito/deadloop/issues/124) では、修正または競合回復で head が変わった pull request を再投入したとき、終了済みのレビュー担当を片付けて通常レビューを一度だけ再開する契約を移行した。新しい正本は [`acceptance/features/requeued-pr-review.feature.md`](../acceptance/features/requeued-pr-review.feature.md) である。

## 分類 ID と関連する保証

| 分類 ID | 移行先または扱い | 最終状態 |
| --- | --- | --- |
| T349 | 「更新された pull request は通常レビューを一度だけ再開する」 | 移行済み。重複する Vitest を削除 |
| T002 | [`worker-launch-and-monitoring.feature.md`](../acceptance/features/worker-launch-and-monitoring.feature.md) の完了済み同名担当の交代 | Issue #119 で移行・Vitest 削除済み |
| T003〜T005 | 同じ正本の稼働中、複数候補、別作業場所に対する起動拒否 | Issue #119 で移行・Vitest 削除済み |
| T318 | [`bounded-pr-recovery.feature.md`](../acceptance/features/bounded-pr-recovery.feature.md) の競合回復開始 | Issue #116 で移行済み。driver の局所診断として Vitest 継続 |
| T320 | 同じ正本の branch 更新中の両レビューラベル維持 | Issue #116 で移行済み。driver の局所診断として Vitest 継続 |
| T322 | 同じ正本の競合回復後に更新された branch を通常レビューへ戻す遷移 | Issue #116 で移行済み。driver の局所診断として Vitest 継続 |

T349 の各シナリオは、修正後の head `feed44`、`agent:review` と `agent:blocked` の両ラベル、同じ作業場所に残る終了済み担当を Given で確立する。Given では driver を実行しない。When で `agent:blocked` を外して再投入し、driver の一周期を実行する。この再投入後の一周期だけを観測し、新しいレビュー担当が一人だけ起動されること、`pane close pane-old` が `agent start` より前に実行されること、レビュー担当へ渡すプロンプトの expected head が `feed44` であることを、別々のシナリオと assertion で確認する。これにより、再投入という契機の後に終了済み担当を交代させて通常レビューへ復帰する境界を保証する。

## 同等性と Vitest の扱い

削除前の `test/pr-reviewer-relaunch-integration.test.ts` と新しい Cucumber シナリオを併存させ、`agent:review` と `agent:blocked` の両方を持つ pull request、終了済み担当、修正後の head を事前状態として用意した。`agent:blocked` を外して再投入した状態で driver を実行し、どちらも、この契機の後に終了済み担当が残る既存作業場所で `pane close pane-old` による片付けを `agent start` より前に行い、同名の新しいレビュー担当を一人だけ起動することを同じ driver 経路で検出した。Cucumber 側ではさらに、起動されたレビュー担当への引き継ぎが修正後の head OID を含むことを検出する。

元の Vitest はこの端から端の保証以外に、純粋関数、引数変換、解析、静的ファイル検査などの局所的な診断価値を持たない。Cucumber の失敗表示でもシナリオ、結果ステップ、実際の起動数と期待した起動数の差を特定できるため、完全に置換して削除した。

## 意図的な失敗確認

2026-07-25 に、再投入後の一周期について結果ステップが期待するレビュー担当の起動数を `1` から `2` へ一時的に変更し、対象シナリオだけを実行した。終了コード 1 となり、`requeued-pr-review.feature.md` のシナリオ位置、`requeued-pr-review.steps.ts` の結果ステップと assertion の位置、実際値 `1` と誤った期待値 `2` の差が表示された。

同日、修正後の head の assertion が期待する値を `feed44` から修正前の `dead43` へ一時的に変更し、「更新された pull request の head をレビュー担当へ引き継ぐ」シナリオだけを実行した。終了コード 1 となり、シナリオ位置、結果ステップ位置、assertion 位置と、実際の head `feed44` に対して誤った期待値が `dead43` である差が表示された。

片付け順のシナリオについても、期待する順序を `agent start`、`pane close` の順へ一時的に逆転して単独実行した。終了コード 1 となり、結果ステップと assertion の位置、および実際には `pane close pane-old`、`agent start demo-pr-44-reviewer` の順である差が表示された。

各期待値を直ちに元へ戻し、各対象シナリオが成功することと意図的な変更が作業ツリーに残っていないことを確認した。
