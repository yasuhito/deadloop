# Herdr runner

pi-looper v0 は Herdr runner を使います。

## 役割

- Herdr worktree を作る
- Pi worker / review worker のセッションを起動する
- pane / session から worker の完了 promise を確認する
- merge / close 後に不要な worker workspace / linked worktree を決定論的 helper で片付ける

## 必要なもの

- `herdr` CLI
- `gh` CLI
- 対象 GitHub repository への読み書き権限
- 対象 repository の local checkout

## 将来の runner

Herdr 固有の操作は runner として扱います。将来、tmux や別の terminal / workspace manager を追加する場合も、GitHub issue / PR の状態管理は pi-looper 側に残します。
