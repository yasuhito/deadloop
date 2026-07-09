# Herdr 実行基盤

deadloop v0 は Herdr 実行基盤を使います。

## 役割

- Herdr worktree を作る
- Pi 作業エージェント / レビューエージェントのセッションを起動する
- 作業エージェントが書いた promise ファイルから完了報告を確認する
- マージ / close 後に不要な作業用 workspace / linked worktree を決定論的な補助スクリプトで片付ける

## 必要なもの

- `herdr` CLI
- `gh` CLI
- 対象 GitHub repository への読み書き権限
- 対象リポジトリのローカル作業ツリー

## 将来の実行基盤

Herdr 固有の操作は実行基盤として扱います。コード上の実行基盤 seam は `src/runner.ts`、Herdr implementation は `src/herdr-runner.ts` に置きます。将来、tmux や別の端末 / workspace 管理ツールを追加する場合も、GitHub Issue / PR の状態管理は deadloop 側に残します。
