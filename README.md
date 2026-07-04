# pi-looper

pi-looper は、[Pi](https://pi.dev/) 上で GitHub Issue / PR の作業ループを回す Pi extension です。

現在の標準 runner は [Herdr](https://herdr.dev/) です。Issue coordinator が実装可能な issue を拾って Herdr worktree の Pi worker に渡し、PR reviewer が別 Pi セッションの review worker を起動してレビュー、必要な修正、検証、最終マージまで進めます。

## 状態

- v0 実装です。
- 現在は Herdr CLI に依存します。
- 将来は tmux など別 runner を追加できるよう、名前は `pi-looper` にしています。

## 重要な注意

pi-looper は GitHub issue / PR にコメントを書き込み、ラベルを編集し、条件がそろうと PR を squash merge して head branch を削除します。最初はテスト用 repository か、保護規則と権限を確認した repository で試してください。

## 必要なもの

- Pi
- Herdr CLI
- GitHub CLI `gh` と認証済みアカウント
- 対象 GitHub repository への読み書き権限
- 対象 repository のローカル checkout
- Python 3
- Git

Herdr runner の詳細は [docs/herdr-runner.md](docs/herdr-runner.md) を参照してください。

## インストール

ローカルで試す場合:

```bash
pi install /path/to/pi-looper
```

GitHub から入れる場合:

```bash
pi install git:github.com/yasuhito/pi-looper
```

一時的に試すだけなら:

```bash
pi -e /path/to/pi-looper
```

## 設定

`extensions/pi-looper/projects.example.json` を参考に、ローカル設定ファイルを作ります。

```bash
mkdir -p ~/.pi/agent/pi-looper
cp extensions/pi-looper/projects.example.json ~/.pi/agent/pi-looper/projects.json
```

起動時に設定ファイルを指定します。pi-looper は Pi の現在ディレクトリが `repoPath` またはその配下にある場合だけ動くため、対象 repository の中で起動してください。

```bash
cd /absolute/path/to/your/repo
PI_LOOPER_CONFIG=~/.pi/agent/pi-looper/projects.json pi
```

主な設定項目:

- `repoPath` — 対象リポジトリのローカル path
- `githubRepo` — `owner/name`
- `baseBranch` — worktree の基準 branch
- `worktreeRoot` — Herdr worktree の root
- `checkCommand` — worker / reviewer が最後に通す検証コマンド
- `workerInstructions` — worker prompt に差し込むプロジェクト固有指示
- `labels` — issue / PR のラベル
- `automations` — schedule、prompt、precheck

v0 の `schedule` は `*/N * * * *` 形式だけに対応します。例: `*/10 * * * *`。

## 付属 automation

- `generic-issue-coordinator`
  - 実装可能 issue を1件選ぶ
  - Herdr worktree / Pi worker を起動する
  - worker 完了後に検証して PR を作る
- `generic-pr-reviewer`
  - `agent:review` または `ready-for-human` PR を1件選ぶ
  - Copilot / CodeRabbit / 人間コメントを確認する
  - 外部レビューが無い場合は review worker に代替レビューを依頼する
  - 必要な修正と検証は別 Pi セッションの review worker が担当する
  - 司令塔側で最終確認して squash merge する

## 環境変数

```bash
PI_LOOPER=off pi
PI_LOOPER_AUTOMATIONS=off pi
PI_LOOPER_PROJECTS=example-project pi
PI_LOOPER_CONFIG=/path/to/projects.json pi
PI_LOOPER_DEBUG=1 pi
```

旧名からの移行用に、当面は `HERDR_LOOPER_*` も互換として読みます。

## ラベル運用

初回は必要なラベルを作成してください。

```bash
gh label create ready-for-agent --repo owner/repo --color 0e8a16 || true
gh label create agent:implement --repo owner/repo --color 1d76db || true
gh label create agent:in-progress --repo owner/repo --color fbca04 || true
gh label create agent:review --repo owner/repo --color 5319e7 || true
gh label create agent:reviewing --repo owner/repo --color c2e0c6 || true
gh label create agent:blocked --repo owner/repo --color b60205 || true
gh label create ready-for-human --repo owner/repo --color d93f0b || true
gh label create needs-info --repo owner/repo --color fef2c0 || true
gh label create needs-triage --repo owner/repo --color f9d0c4 || true
```

実装 worker に拾わせるには、issue に次の両方が必要です。

- `ready-for-agent`
- `agent:implement`

主な制御ラベル:

- `agent:in-progress` — 実装中
- `agent:review` — PR review 対象
- `agent:reviewing` — review automation が処理中
- `agent:blocked` — 自動処理を止める
- `ready-for-human` — 人間確認対象
- `needs-info` — 情報不足

## 注意

- Pi packages / extensions はローカル環境で任意コードを実行できます。信頼できる配布元だけを入れてください。
- 現在の runner は Herdr です。Herdr CLI が入っていない環境では動きません。
- `projects.json` にはローカル path や repo 名が入るため、このリポジトリには含めません。
