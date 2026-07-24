# 機能: レビュー可能な pull request だけを選ぶ

自動レビューは、まだ準備中、停止中、または別の担当者が処理中の pull request を処理してはならない。
そのため deadloop は、現在安全にレビューできる pull request だけを選ぶ。

## シナリオ: レビュー待ちの pull request を選ぶ

* 前提 レビュー待ちの pull request がある
* もし deadloop がレビュー対象を探す
* ならば pull request #7 をレビュー対象に選ぶ

## シナリオ: 自動マージが無効なら人間確認待ちの pull request を選ばない

* 前提 人間確認待ちの pull request がある
* かつ 自動マージが無効である
* もし deadloop がレビュー対象を探す
* ならば レビュー対象は選ばれない

## シナリオ: 自動マージが有効なら人間確認待ちの pull request を選ぶ

* 前提 人間確認待ちの pull request がある
* かつ 自動マージが有効である
* もし deadloop がレビュー対象を探す
* ならば pull request #42 をレビュー対象に選ぶ

## シナリオ: レビュー対象外のラベルだけを持つ pull request を選ばない

* 前提 レビュー対象外のラベルだけを持つ pull request がある
* もし deadloop がレビュー対象を探す
* ならば レビュー対象は選ばれない

## シナリオ: CI 実行中の pull request を選ばない

* 前提 CI 実行中の pull request がある
* もし deadloop がレビュー対象を探す
* ならば レビュー対象は選ばれない

## シナリオ: 外部レビューの待機期限が切れた pull request を選ぶ

* 前提 外部レビューの待機期限が切れた pull request がある
* かつ 外部レビューが有効である
* もし deadloop がレビュー対象を探す
* ならば pull request #9 をレビュー対象に選ぶ

## シナリオ: 外部レビューが無効なら外部レビュー待ちの pull request を選ぶ

* 前提 外部レビュー待ちの pull request がある
* かつ 外部レビューが無効である
* もし deadloop がレビュー対象を探す
* ならば pull request #10 をレビュー対象に選ぶ

## シナリオ: 外部レビュー担当が処理中の pull request を選ばない

* 前提 外部レビュー担当が処理中の pull request がある
* かつ 外部レビューが有効である
* もし deadloop がレビュー対象を探す
* ならば レビュー対象は選ばれない

## シナリオ: 別の外部レビュー担当が処理中の pull request を選ばない

* 前提 別の外部レビュー担当が処理中の pull request がある
* かつ 外部レビューが有効である
* もし deadloop がレビュー対象を探す
* ならば レビュー対象は選ばれない

## シナリオ: 外部レビューをまだ依頼していない pull request には外部レビューを依頼する

* 前提 レビュー待ちの pull request がある
* かつ 外部レビューが有効である
* もし deadloop が外部レビューの扱いを決める
* ならば deadloop は外部レビューを依頼する

## シナリオ: 外部レビューを待っている pull request は待機する

* 前提 外部レビュー待ちの pull request がある
* かつ 外部レビューが有効である
* もし deadloop が外部レビューの扱いを決める
* ならば deadloop は外部レビューを待機する

## シナリオ: 外部レビューの待機期限が切れた pull request は通常レビューへ戻す

* 前提 外部レビューの待機期限が切れた pull request がある
* かつ 外部レビューが有効である
* もし deadloop が外部レビューの扱いを決める
* ならば deadloop は通常レビューへ戻す

## シナリオ: 下書きの pull request はレビューを開始しない

* 前提 下書きの pull request がある
* もし deadloop がレビューを開始しようとする
* ならば pull request は停止中になる

## シナリオ: 下書きの pull request には復旧手順を示す

* 前提 下書きの pull request がある
* もし deadloop がレビューを開始しようとする
* ならば pull request の復旧手順を示す

## シナリオ: 古いレビュー占有を回収して pull request を選ぶ

* 前提 稼働中の担当者がいないレビュー中の pull request がある
* もし deadloop がレビュー対象を探す
* ならば pull request #13 をレビュー対象に選ぶ

## シナリオ: 別担当がレビュー中の pull request を選ばない

* 前提 別担当がレビュー中の pull request がある
* もし deadloop がレビュー対象を探す
* ならば レビュー対象は選ばれない

## シナリオ: 停止中の pull request を選ばない

* 前提 停止中の pull request がある
* もし deadloop がレビュー対象を探す
* ならば レビュー対象は選ばれない

## シナリオ: 複数候補ではレビュー可能な pull request だけを選ぶ

* 前提 レビューできない pull request とレビュー可能な pull request が混在している
* もし deadloop がレビュー対象を探す
* ならば pull request #15 をレビュー対象に選ぶ

## シナリオ: 別担当が選択後に作業を始めた pull request を再度選ばない

* 前提 レビュー待ちの pull request がある
* もし 別担当が選択後にレビューを開始して次の選定周期になる
* ならば レビュー対象は選ばれない
