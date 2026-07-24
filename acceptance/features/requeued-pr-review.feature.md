# 機能: 更新された pull request のレビューを一度だけ再開する

deadloop の利用者に対し、修正や競合回復で head が変わった pull request では、終了済みの担当だけを交代させて通常レビューを一度だけ再開することを保証する。
これにより、前の head の担当を残したまま重複起動したり、稼働中の担当を誤って終了したりすることを防ぐ。

`@requeued-pr-review`
## シナリオ: 更新された pull request は通常レビューを一度だけ再開する

* 前提 修正後の新しい head を持ち終了済みのレビュー担当が残る pull request がある
* もし deadloop が再投入された pull request を確認する
* ならば 新しい head のレビュー担当を一人だけ起動する
