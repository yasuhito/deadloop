# 機能: 更新された pull request のレビューを一度だけ再開する

deadloop の利用者に対し、修正や競合回復で head が変わった pull request では、終了済みの担当だけを交代させて通常レビューを一度だけ再開することを保証する。
これにより、前の head の担当を残したまま重複起動したり、稼働中の担当を誤って終了したりすることを防ぐ。

`@requeued-pr-review`
## シナリオ: 更新された pull request は通常レビューを一度だけ再開する

* 前提 修正で head が変わり終了済みのレビュー担当が残る pull request がある
* もし deadloop が再投入された pull request を確認する
* ならば 新しい head のレビュー担当を一人だけ起動する

`@requeued-pr-review`
## シナリオ: 終了済みのレビュー担当を片付けてから再開する

* 前提 修正で head が変わり終了済みのレビュー担当が残る pull request がある
* もし deadloop が再投入された pull request を確認する
* ならば 終了済みのレビュー担当を片付けてから新しい担当を起動する

`@requeued-pr-review`
## シナリオ: 更新された pull request の head をレビュー担当へ引き継ぐ

* 前提 修正で head が変わり終了済みのレビュー担当が残る pull request がある
* もし deadloop が再投入された pull request を確認する
* ならば レビュー担当への引き継ぎに修正後の head を使う
