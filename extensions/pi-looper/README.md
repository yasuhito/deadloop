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

## Issue coordinator decisions

`generic-issue-coordinator` は issue 候補選定、skip label 判定、本文の `## Blocked by` / `Depends on #N` と GitHub Relationships metadata の依存判定を `automations/generic-issue-coordinator-decisions.py` で決定論的に行います。prompt はその結果を使って orchestration と Gate 以降の判断に集中します。

## PR reviewer decisions

`generic-pr-reviewer` は PR 候補選定、pending checks、Copilot / CodeRabbit の外部レビュー待機、stale marker 判定を `automations/generic-pr-reviewer-decisions.py` で決定論的に行います。prompt はその結果を使って orchestration と最終判断に集中します。

## 旧名互換

旧 `herdr-looper` からの移行のため、当面は `HERDR_LOOPER_*` と内部 `HEADR_*` 環境変数も読みます。新規設定では `PI_LOOPER_*` を使ってください。
