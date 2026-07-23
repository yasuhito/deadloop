# 機能: pull request の自動修正と競合回復を一回に制限する

レビューで見つかった修正や競合を安全に処理し、同じ変更を繰り返したり別の変更を上書きしたりしないことを保証する。

## シナリオ: 競合した pull request は一度だけ専用の回復作業を開始する

* 前提 回復できる競合状態の pull request がある
* もし deadloop が pull request を確認する
* ならば deadloop は専用の競合回復作業を開始する

## シナリオ: 競合回復の監視者は branch を直接 push しない

* 前提 回復できる競合状態の pull request がある
* もし deadloop が pull request を確認する
* ならば deadloop は監視者に branch を直接 push しないよう指示する

## シナリオ: 同じ pull request head と base の競合回復は二度開始しない

* 前提 同じ pull request head と base の競合回復を一度試した pull request がある
* もし deadloop が pull request を確認する
* ならば deadloop は競合回復を停止して人間対応にする

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

## シナリオ: 同じレビュー指摘が残った場合は人間対応にする

* 前提 同じレビュー指摘の修正を一度試した pull request がある
* もし deadloop がレビュー結果を処理する
* ならば deadloop は修正を停止して人間対応にする

## シナリオ: 最初の技術的なレビュー失敗は一度だけ再試行する

* 前提 初めて技術的に失敗したレビューがある pull request がある
* もし deadloop がレビュー結果を処理する
* ならば deadloop はレビューを一度だけ再試行する

## シナリオ: 二度目の技術的なレビュー失敗は人間対応にする

* 前提 技術的に一度失敗したレビューがある pull request がある
* もし deadloop がレビュー結果を処理する
* ならば deadloop はレビューを停止して人間対応にする

## シナリオ: 修正作業はレビュー指摘の範囲を広げない

* 前提 初めての対応可能なレビュー指摘がある pull request がある
* もし deadloop が修正作業者へ指示する
* ならば deadloop は修正作業者に作業範囲を広げないよう指示する

## シナリオ: 修正作業者は直接 push しない

* 前提 初めての対応可能なレビュー指摘がある pull request がある
* もし deadloop が修正作業者へ指示する
* ならば deadloop は修正作業者に直接 push しないよう指示する

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
* ならば deadloop は push 前に設定済みチェックを実行する

## シナリオ: 競合回復は確認した既存 branch へ非強制でだけ push する

* 前提 競合回復対象の pull request head が確認済みである
* もし deadloop が競合回復を完了する
* ならば deadloop は競合回復 branch へ非強制で push する

## シナリオ: 競合回復のチェックは push 直前の head 確認より先に実行する

* 前提 競合回復対象の pull request head が確認済みである
* もし deadloop が競合回復を完了する
* ならば deadloop は競合回復の push 前に設定済みチェックを実行する

## シナリオ: 古い pull request head の競合回復は push しない

* 前提 競合回復対象の pull request head が確認済みである
* もし push の直前に pull request head が変わる
* ならば deadloop は競合回復 branch へ push しない
