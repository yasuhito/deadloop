# pi-looper extension

Pi 本体から読み込まれる extension 実体です。通常は package root の `README.md` を読んでください。

## ローカル設定

通常は `~/.pi/agent/pi-looper/projects.json` に実運用用の設定を置きます。この directory に `projects.json` を置くこともできますが、リポジトリには含めません。公開用の雛形は `projects.example.json` です。PR reviewer の自動マージは安全のため既定で無効です。必要な場合だけ project config に `"autoMerge": true` を明示します。

優先順位:

1. `PI_LOOPER_CONFIG`
2. `HERDR_LOOPER_CONFIG`（旧名互換）
3. `~/.pi/agent/pi-looper/projects.json`
4. この directory の `projects.json`

## 状態保存

状態と lock は `~/.pi/agent/pi-looper/` に保存します。

## Herdr cleanup

`generic-issue-coordinator` は issue 選択前に `automations/cleanup-completed-worker-worktrees.py` を呼び、merged / closed PR に対応する clean な Herdr linked worktree だけを決定論的に片付けます。削除可否は prompt では判断しません。

## 旧名互換

旧 `herdr-looper` からの移行のため、当面は `HERDR_LOOPER_*` と内部 `HEADR_*` 環境変数も読みます。新規設定では `PI_LOOPER_*` を使ってください。
