# 有界な PR 修正・競合回復の Cucumber 移行記録

Issue [#116](https://github.com/yasuhito/deadloop/issues/116) では、PR の自動修正と競合回復を一回に制限する公開安全契約を `acceptance/features/bounded-pr-recovery.feature.md` へ移した。各シナリオは一つの利用者観測可能な結果だけを確認する。

## 分類 ID の対応

| 分類 ID | 移行先シナリオ | 状態 |
|---|---|---|
| T288, T292 | 古い pull request head の競合回復は push しない | 移行済み |
| T290 | 競合回復のチェックは push 直前の head 確認より先に実行する | 同じ安全保証へ統合 |
| T291 | 競合回復は確認した既存 branch へ非強制でだけ push する | 同じ安全保証へ統合 |
| T294 | 最初のレビュー指摘は専用の修正作業を開始する | 移行済み |
| T296 | 修正後の新しい head でも同じレビュー指摘が残った場合は人間対応にする | 移行済み |
| T297 | 最初の技術的なレビュー失敗は一度だけ再試行する | 移行済み |
| T298 | 二度目の技術的なレビュー失敗は人間対応にする | 移行済み |
| T301 | 修正作業はレビュー指摘の範囲を広げない | 移行済み |
| T302 | 修正作業者は直接 push しない | 移行済み |
| T303, T306 | 古い pull request head の修正は push しない | 同じ安全保証へ統合 |
| T304 | 修正のチェックは push 直前の head 確認より先に実行する | 移行済み |
| T305 | 修正は確認した既存 branch へ非強制でだけ push する | 移行済み |
| T318 | 競合した pull request は一度だけ専用の回復作業を開始する | 移行済み |
| T320 | 競合回復中もレビュー状態を維持する | 移行済み |
| T321 | 競合回復の監視者は branch を直接 push しない | 移行済み |
| T322 | base が変わった競合 pull request は通常レビューへ戻る | 移行済み |
| T323 | 同じ pull request head と base の競合回復は二度開始しない | 移行済み |

## 残す Vitest の診断価値

- T285–T287 は、再試行キーと GitHub コメント内の正確な head/base 記録を局所的に診断するため Vitest に残す。
- T293 は、Herdr・GitHub・git の偽コマンドを接続した修正作業の起動経路を診断するため Vitest に残す。受け入れシナリオは利用者に見える一回限りの引き渡しを保証し、この統合テストは失敗した実行基盤アダプターを絞り込む。
- T295、T299、T300 は、修正指摘の fingerprint、head ごとの技術失敗集計、作業者への構造化した指摘の受け渡しを局所的に診断するため Vitest に残す。
- T289 は、cross-repository PR の拒否を finalizer の引数境界で診断するため、別の安全契約の移行まで Vitest に残す。
- T314、T317、T319、T324 は、promise path、起動指示、再試行キー、agent 名という実行基盤の診断値を検査するため Vitest に残す。

## 同等性確認

通常の成功に加え、`acceptance/steps/bounded-pr-recovery.steps.ts` の結果 assertion を一時的に逆転させ、対象 Cucumber シナリオが assertion 差分と TypeScript のソース位置を示して失敗することを確認してから元へ戻す。最終確認は `npm run check` で Vitest と Cucumber を直列に実行する。
