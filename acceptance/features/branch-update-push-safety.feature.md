# 機能: ブランチ更新と push を安全に制限する

pull request の更新中に対象が変わったり安全な作業場所でなくなったりしても、別の変更を壊さないために更新を止める。

## シナリオ: push 直前に pull request head が変わった場合は branch を更新しない

* 前提 更新前に確認した pull request head がある
* かつ 自動チェック後に pull request head が変わる
* もし deadloop が branch 更新を完了しようとする
* ならば branch への push は行われない

## シナリオ: 別リポジトリの pull request は branch を更新しない

* 前提 更新前に確認した pull request head がある
* かつ pull request が別リポジトリから作られている
* もし deadloop が branch 更新を完了しようとする
* ならば branch への push は行われない

## シナリオ: 選択後に head が変わった pull request は作業エージェントを起動しない

* 前提 選択した pull request head が更新前に変わっている
* もし deadloop が branch 更新を開始しようとする
* ならば branch 更新の作業エージェントは起動されない

## シナリオ: 変更中の作業場所では branch 更新の作業エージェントを起動しない

* 前提 更新対象の作業場所に未コミットの変更がある
* もし deadloop が branch 更新を開始しようとする
* ならば branch 更新の作業エージェントは起動されない

## シナリオ: 信頼されていない作業場所では作業エージェントを起動しない

* 前提 作業場所の信頼が承認されていない
* もし deadloop が Claude の作業エージェントを起動しようとする
* ならば 作業エージェントは起動されない

## シナリオ: 自動チェックは push 直前の head 確認より先に実行される

* 前提 更新前に確認した pull request head がある
* もし deadloop が branch 更新を完了しようとする
* ならば 自動チェックは pull request head 確認より先に実行される

## シナリオ: 更新できる pull request は選択された branch だけへ push する

* 前提 更新前に確認した pull request head がある
* もし deadloop が branch 更新を完了しようとする
* ならば 選択された branch だけが push の対象になる

## シナリオ: 更新できる pull request は強制せずに push する

* 前提 更新前に確認した pull request head がある
* もし deadloop が branch 更新を完了しようとする
* ならば branch は強制せずに push される
