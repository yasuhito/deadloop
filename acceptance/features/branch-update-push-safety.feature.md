# 機能: ブランチ更新と push を安全に制限する

pull request に変更を送った開発者の変更を守るため、更新中に対象が変わったり安全な作業場所でなくなったりした場合は更新を止める。

## シナリオ: push 直前に pull request head が変わった場合は branch を更新しない

* 前提 更新前に確認した pull request head がある
* もし 自動チェック後に pull request head が変わる
* ならば branch への push は行われない

## シナリオ: push 直前に変わった pull request head は古い head として報告する

* 前提 更新前に確認した pull request head がある
* もし 自動チェック後に pull request head が変わる
* ならば 完了結果は古い head として観測される

## シナリオ: 別リポジトリの pull request は branch を更新しない

* 前提 更新前に確認した pull request head がある
* かつ pull request が別リポジトリから作られている
* もし deadloop が branch 更新を完了しようとする
* ならば branch への push は行われない

## シナリオ: 自動チェック後に追跡中の変更がある場合は branch を更新しない

* 前提 更新前に確認した pull request head がある
* もし 自動チェック後に作業場所へ追跡中の変更が生じる
* ならば branch への push は行われない

## シナリオ: 信頼されていない作業場所では作業エージェントを起動しない

* 前提 作業場所の信頼が承認されていない
* もし deadloop が Claude の作業エージェントを起動しようとする
* ならば 作業エージェントは起動されない

## シナリオ: 更新できる pull request は選択された branch だけへ push する

* 前提 更新前に確認した pull request head がある
* もし deadloop が branch 更新を完了しようとする
* ならば 選択された branch だけが push の対象になる

## シナリオ: 更新できる pull request は強制せずに push する

* 前提 更新前に確認した pull request head がある
* もし deadloop が branch 更新を完了しようとする
* ならば branch は強制せずに push される
