# 機能: pull request の自動修正と競合回復を一回に制限する

レビューで見つかった修正や競合を安全に処理し、同じ変更を繰り返したり別の変更を上書きしたりしないことを保証する。

## シナリオ: 競合した pull request は一度だけ専用の回復作業を開始する

* 前提 回復できる競合状態の pull request がある
* もし deadloop が pull request を確認する
* ならば deadloop は専用の競合回復作業を開始する

## シナリオ: 同じ pull request head と base の競合回復は二度開始しない

* 前提 同じ pull request head と base の競合回復を一度試した pull request がある
* もし deadloop が pull request を確認する
* ならば deadloop は専用の競合回復作業を開始しない

## シナリオ: 同じ pull request head と base の競合回復を再試行すると人間対応へ移る

* 前提 同じ pull request head と base の競合回復を一度試した pull request がある
* もし deadloop が pull request を確認する
* ならば deadloop はレビューを維持して人間対応へ移す

## シナリオ: 同じ pull request head と base の競合回復を再試行すると回復案内を残す

* 前提 同じ pull request head と base の競合回復を一度試した pull request がある
* もし deadloop が pull request を確認する
* ならば deadloop は回復案内を残す

## シナリオ: base が変わった競合 pull request は通常レビューへ戻る

* 前提 base の更新後に競合が解消した pull request がある
* もし deadloop が pull request を確認する
* ならば deadloop は通常レビューを開始する

## シナリオ: 競合回復中もレビュー状態を維持する

* 前提 回復できる競合状態の pull request がある
* もし deadloop が pull request を確認する
* ならば deadloop はレビュー状態を維持する

## シナリオ: 最初のレビュー指摘は専用の修正作業を開始する

* 前提 初めての対応可能なレビュー指摘がある pull request がある
* もし deadloop がレビュー結果を処理する
* ならば deadloop は専用の修正作業を開始する

## シナリオ: 専用の修正作業を開始した後は有界な監視へ引き渡す

* 前提 初めての対応可能なレビュー指摘がある pull request がある
* もし deadloop がレビュー結果を処理する
* ならば deadloop は修正作業を有界な監視へ引き渡す

## シナリオ: 修正中もレビュー状態を維持する

* 前提 レビュー指摘の修正中である pull request がある
* もし deadloop がレビュー指摘の修正を開始する
* ならば deadloop はレビュー状態を維持する

## シナリオ: 修正の push で head が変わった pull request は通常レビューへ戻る

* 前提 修正の push で head が変わった pull request がある
* もし deadloop が pull request を確認する
* ならば deadloop は通常レビューを開始する

## シナリオ: 修正後の新しい head では同じレビュー指摘の修正を二度開始しない

* 前提 修正後の新しい head でも同じレビュー指摘が残った pull request がある
* もし deadloop がレビュー結果を処理する
* ならば deadloop は専用の修正作業を開始しない

## シナリオ: 修正後の新しい head で同じレビュー指摘が残ると人間対応へ移る

* 前提 修正後の新しい head でも同じレビュー指摘が残った pull request がある
* もし deadloop がレビュー結果を処理する
* ならば deadloop はレビューを維持して人間対応へ移す

## シナリオ: 修正後の新しい head で同じレビュー指摘が残ると回復案内を残す

* 前提 修正後の新しい head でも同じレビュー指摘が残った pull request がある
* もし deadloop がレビュー結果を処理する
* ならば deadloop は回復案内を残す

## シナリオ: 最初の技術的なレビュー失敗は一度だけ再試行する

* 前提 初めて技術的に失敗したレビューがある pull request がある
* もし deadloop がレビュー結果を処理する
* ならば deadloop はレビューを一度だけ再試行する

## シナリオ: 最初の技術的なレビュー失敗では人間対応にしない

* 前提 初めて技術的に失敗したレビューがある pull request がある
* もし deadloop がレビュー結果を処理する
* ならば deadloop は人間対応にしない

## シナリオ: 二度目の技術的なレビュー失敗は再試行しない

* 前提 技術的に一度失敗したレビューがある pull request がある
* もし deadloop がレビュー結果を処理する
* ならば deadloop は通常レビューを開始しない

## シナリオ: 二度目の技術的なレビュー失敗は人間対応へ移る

* 前提 技術的に一度失敗したレビューがある pull request がある
* もし deadloop がレビュー結果を処理する
* ならば deadloop はレビューを維持して人間対応へ移す

## シナリオ: 二度目の技術的なレビュー失敗は回復案内を残す

* 前提 技術的に一度失敗したレビューがある pull request がある
* もし deadloop がレビュー結果を処理する
* ならば deadloop は回復案内を残す

## シナリオ: 古い pull request head の修正は push しない

* 前提 修正対象の pull request head が確認済みである
* もし push の直前に pull request head が変わる
* ならば deadloop は branch へ push しない

## シナリオ: 修正は確認した既存 branch へ非強制でだけ push する

* 前提 修正対象の pull request head が確認済みである
* もし deadloop が修正を完了する
* ならば deadloop は確認した branch へ非強制で push する

## シナリオ: 修正のチェックは push 直前の head 確認より先に実行する

* 前提 修正対象の pull request head が確認済みである
* もし deadloop が修正を完了する
* ならば deadloop は最後の pull request head 確認より先に設定済みチェックを実行する

## シナリオ: 別のリポジトリからの pull request の競合回復は push しない

* 前提 別のリポジトリからの pull request が競合している
* もし deadloop が競合回復を完了する
* ならば deadloop は競合回復 branch へ push しない

## シナリオ: 競合回復は確認した既存 branch へ非強制でだけ push する

* 前提 競合回復対象の pull request head が確認済みである
* もし deadloop が競合回復を完了する
* ならば deadloop は競合回復 branch へ非強制で push する

## シナリオ: 競合回復のチェックは push 直前の head 確認より先に実行する

* 前提 競合回復対象の pull request head が確認済みである
* もし deadloop が競合回復を完了する
* ならば deadloop は競合回復の最後の pull request head 確認より先に設定済みチェックを実行する

## シナリオ: 古い pull request head の競合回復は push しない

* 前提 競合回復対象の pull request head が確認済みである
* もし push の直前に pull request head が変わる
* ならば deadloop は競合回復 branch へ push しない
