# 機能: pull request の現在状態に応じてレビュー処理を進める

deadloop の利用者に対し、pull request の現在の head、CI、外部レビュー、競合の状態だけを使って、安全な次の処理へ進むことを保証する。
これにより、古い結果の承認への流用、CI 完了前のレビュー、承認済み安全設定の消失を防ぐ。

## シナリオ: レビュー対象がなければレビュー処理を開始しない

* 前提 現在レビューできる pull request がない
* もし deadloop が pull request の次の処理を決める
* ならば レビュー処理は開始されない

## シナリオ: CI 実行中は完了を待つ

* 前提 pull request の CI が実行中である
* もし deadloop が pull request の次の処理を決める
* ならば CI の完了待ちになる

## シナリオ: 外部レビューが無効なら通常レビューを開始する

* 前提 CI が完了したレビュー待ちの pull request がある
* かつ 外部レビューが無効に設定されている
* もし deadloop が pull request の次の処理を決める
* ならば 通常レビューを開始する

## シナリオ: 古い head の外部レビュー依頼を現在の依頼として使わない

* 前提 以前の pull request head にだけ外部レビューを依頼している
* かつ 外部レビューが有効に設定されている
* もし deadloop が pull request の次の処理を決める
* ならば 現在の head の外部レビューを依頼する

## シナリオ: 以前の head の承認結果では現在の pull request をマージしない

* 前提 以前の pull request head に対する承認結果がある
* もし deadloop が現在の pull request の承認処理を完了する
* ならば 現在の pull request はマージされない
