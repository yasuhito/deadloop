# pi-looper 拡張

Pi 本体から読み込まれる拡張の実体です。通常はパッケージルートの `README.md` を読んでください。

## ローカル設定

通常は `~/.pi/agent/pi-looper/projects.json` に実運用用の設定を置きます。このディレクトリに `projects.json` を置くこともできますが、リポジトリには含めません。公開用の雛形は `projects.example.json` です。`projects.json` はローカルパス、GitHub リポジトリ、展開判断を含むローカル設定なのでコミットしません。PR reviewer の自動マージは安全のため既定で無効です。必要な場合だけプロジェクト設定に `"autoMerge": true` を明示します。初回導入は [../../docs/public-package-setup.md](../../docs/public-package-setup.md) の Phase 1 から始めてください。

優先順位:

1. `PI_LOOPER_CONFIG`
2. `HERDR_LOOPER_CONFIG`（旧名互換）
3. `~/.pi/agent/pi-looper/projects.json`
4. このディレクトリの `projects.json`

## 状態保存

状態と lock は `~/.pi/agent/pi-looper/` に保存します。

## 状況レポート

Pi コマンド `/pi-looper-status` は、有効なプロジェクトの運用者向けレポートを短く表示します。ローカルプロジェクト設定、pi-looper の状態ファイル、GitHub Issue / PR ラベル、Herdr 作業用 worktree を読み、人間が複数のコマンド結果を手で突き合わせなくても、ループが何を待っているか分かるようにします。

## Herdr の片付け

`generic-issue-coordinator` は Issue 選択前に `automations/cleanup-completed-worker-worktrees.py` を呼び、マージ済み / close 済み PR に対応する clean な Herdr linked worktree だけを決定論的に片付けます。削除可否はプロンプトでは判断しません。

## Issue coordinator の決定処理

`generic-issue-coordinator` は Issue 候補選定、除外ラベル判定、本文の `## Blocked by` / `Depends on #N` と GitHub Relationships metadata の依存判定を `automations/generic-issue-coordinator-decisions.py` で決定論的に行います。プロンプトはその結果を使って進行管理と Gate 以降の判断に集中します。

## PR reviewer の決定処理

`generic-pr-reviewer` は PR 候補選定、未完了検証、Copilot / CodeRabbit の外部レビュー待機、古い marker 判定を `automations/generic-pr-reviewer-decisions.py` で決定論的に行います。プロンプトはその結果を使って進行管理と最終判断に集中します。

## 旧名互換

旧 `herdr-looper` からの移行のため、当面は `HERDR_LOOPER_*` と内部 `HEADR_*` 環境変数も読みます。新規設定では `PI_LOOPER_*` を使ってください。
