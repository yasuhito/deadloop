# pi-looper

pi-looper は、[Pi](https://pi.dev/) 上で GitHub Issue から実装、PR 作成、レビュー、修正、検証、マージまでを自動で回すためのループエンジニアリングツールです。

人間がエージェントに渡せる Issue を用意すると、pi-looper が定期的に GitHub を見に行きます。実装可能な Issue があれば、Issue coordinator が Herdr worktree に Pi の作業エージェントを起動し、作業エージェントが実装します。実装後は司令塔が検証して PR を作り、PR reviewer が別 Pi セッションのレビューエージェントを起動してレビュー、必要な修正、再検証、最終マージまで進めます。

つまり、開発者は「何を作るか」を GitHub Issue に書き、ラベルでエージェントに渡せる状態を示すだけで、実装からマージまでのループを継続的に回せます。pi-looper は、この「Issue を作るだけで開発ループが進む」運用を Pi 上で実現するための拡張です。

現在の標準実行基盤は [Herdr](https://herdr.dev/) です。将来は tmux など別の実行基盤も追加できるよう、Herdr 専用ではなく `pi-looper` という名前にしています。

## 状態

- v0 実装です。
- 現在は Herdr CLI に依存します。
- 将来は tmux など別の実行基盤を追加できるよう、名前は `pi-looper` にしています。

## 重要な注意

pi-looper は GitHub Issue / PR にコメントを書き込み、ラベルを編集します。`autoMerge: true` を明示した場合だけ、条件がそろうと PR を squash merge して head branch を削除できます。最初は `autoMerge: false` のまま、テスト用リポジトリか保護規則と権限を確認したリポジトリで試してください。

## Safe start for first-time users

1. Install the package from a trusted source:

   ```bash
   pi install git:github.com/yasuhito/pi-looper
   ```

2. Create local config outside the repository and edit it for your checkout. If you installed from GitHub, Pi clones the package under `~/.pi/agent/git/github.com/yasuhito/pi-looper`:

   ```bash
   mkdir -p ~/.pi/agent/pi-looper
   cp ~/.pi/agent/git/github.com/yasuhito/pi-looper/extensions/pi-looper/projects.example.json ~/.pi/agent/pi-looper/projects.json
   $EDITOR ~/.pi/agent/pi-looper/projects.json
   ```

   For a local development checkout, copy from `/absolute/path/to/pi-looper/extensions/pi-looper/projects.example.json` instead.

   `projects.json` is local config. It contains local paths and rollout choices, so do **not** commit it. Keep `autoMerge: false` while getting started.

3. Create the required GitHub labels, then label an issue with both `ready-for-agent` and `agent:implement`.

4. Roll out in phases:
   - Phase 1: enable only `generic-issue-coordinator` so automation stops after PR creation.
   - Phase 2: add `generic-pr-reviewer` with `autoMerge: false` so reviewed PRs go to `ready-for-human`.
   - Phase 3: consider `autoMerge: true` only after branch protection, CI, review expectations, and stop conditions are proven.

5. Start Pi from inside the target repository:

   ```bash
   cd /absolute/path/to/your/repo
   pi
   ```

Detailed setup, label, safety, and package-content notes are in [docs/public-package-setup.md](docs/public-package-setup.md).

## 必要なもの

- Pi
- Herdr CLI
- GitHub CLI `gh` と認証済みアカウント
- 対象 GitHub リポジトリへの読み書き権限
- 対象リポジトリのローカル作業ツリー
- Python 3
- Git

Herdr 実行基盤の詳細は [docs/herdr-runner.md](docs/herdr-runner.md) を参照してください。公開パッケージとしての安全な初期設定は [docs/public-package-setup.md](docs/public-package-setup.md) を参照してください。

## Dogfooding

pi-looper 自体の開発も、段階的に pi-looper で回します。最初は Issue coordinator だけを有効にし、エージェントに渡せる Issue から PR 作成までを自動化します。PR レビューとマージは、安全設定が整うまで人間が確認します。

詳しい手順は [docs/dogfooding.md](docs/dogfooding.md) を参照してください。

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

`projects.example.json` を参考に、ローカル設定ファイルを作ります。この `projects.json` はローカル設定であり、リポジトリにコミットしません。GitHub からインストールした場合は、Pi が複製したパッケージからコピーします。

```bash
mkdir -p ~/.pi/agent/pi-looper
cp ~/.pi/agent/git/github.com/yasuhito/pi-looper/extensions/pi-looper/projects.example.json ~/.pi/agent/pi-looper/projects.json
```

ローカル開発 checkout から試す場合は、代わりに `/absolute/path/to/pi-looper/extensions/pi-looper/projects.example.json` からコピーしてください。

既定では `~/.pi/agent/pi-looper/projects.json` を読みます。pi-looper は Pi の現在ディレクトリが `repoPath` またはその配下にある場合だけ動くため、対象リポジトリの中で起動してください。

```bash
cd /absolute/path/to/your/repo
pi
```

別の設定ファイルを使いたい場合だけ、起動時に `PI_LOOPER_CONFIG` を指定します。

```bash
cd /absolute/path/to/your/repo
PI_LOOPER_CONFIG=/path/to/projects.json pi
```

主な設定項目:

- `repoPath` — 対象リポジトリのローカルパス
- `githubRepo` — `owner/name`
- `baseBranch` — worktree の基準 branch
- `worktreeRoot` — Herdr worktree の root
- `checkCommand` — 作業エージェント / レビューエージェントが最後に通す検証コマンド。pi-looper 自体では `npm test && npm run lint && npm run typecheck && bash -n extensions/pi-looper/automations/*.sh && python3 -m py_compile extensions/pi-looper/automations/*.py && npm pack --dry-run` を標準検証にしています
- `autoMerge` — `true` のときだけ PR reviewer が条件を満たした PR をマージする。既定値は `false` なので、初回導入では明示的に `false` のままにしてください
- `workerInstructions` — 作業エージェント用プロンプトに差し込むプロジェクト固有指示
- `workerModel` — 作業エージェントの使用モデル。Pi の `provider/id` 形式(例: `anthropic/claude-opus-4-8`)をそのまま `--model` に渡す。設定すると司令塔は issue の内容にかかわらず必ずこのモデルで Worker を起動する。未設定なら Pi の既定モデルを使う
- `reviewerModel` — レビューエージェントの使用モデル。形式と意味論は `workerModel` と同じ。実装(重い)とレビュー(軽い)でサブスクリプションの消費先を分けられるよう独立させている
- `labels` — Issue / PR のラベル
- `automations` — schedule、prompt、precheck

v0 の `schedule` は `*/N * * * *` 形式だけに対応します。例: `*/10 * * * *`。

## 状況レポート

Pi から次のコマンドで、運用者向けの状況レポートを確認できます。

```text
/pi-looper-status
```

レポートは現在ディレクトリから有効なプロジェクトを解決し、有効な自動化、現在の GitHub Issue / PR キュー、関連する Herdr 作業用 worktree、片付け候補を要約します。

## 付属自動化

- `generic-issue-coordinator`
  - マージ済み / close 済み PR に対応する完了済み Herdr 作業用 workspace / worktree を決定論的な補助スクリプトで片付ける
  - 実装可能な Issue を1件選ぶ
  - Herdr worktree / Pi 作業エージェントを起動する
  - 作業エージェント完了後に検証して PR を作る
- `generic-pr-reviewer`
  - 通常は `agent:review` PR を1件選ぶ
  - `autoMerge: true` の場合に限り `ready-for-human` PR も対象にできる
  - Copilot / CodeRabbit / 人間コメントを確認する
  - 外部レビューが無い場合はレビューエージェントに代替レビューを依頼する
  - 必要な修正と検証は別 Pi セッションのレビューエージェントが担当する
  - `autoMerge: false` ではマージせず `ready-for-human` に渡す
  - `autoMerge: true` の場合だけ、司令塔側で最終確認して squash merge する

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

実装用の作業エージェントに拾わせるには、Issue に次の両方が必要です。

- `ready-for-agent`
- `agent:implement`

## エージェントに渡せる Issue の書き方

`generic-issue-coordinator` は、Issue を作業エージェントに渡す前に実装契約を確認します。この条件は [extensions/pi-looper/automations/generic-issue-coordinator.prompt.md](extensions/pi-looper/automations/generic-issue-coordinator.prompt.md) の `### 3. Gate` 節を正とし、README の説明もその節に合わせます。

Issue 本文には、少なくとも次の見出しを入れてください。

- `## Agent Brief` または `## What to build` — 何を作るか、変更範囲、期待する挙動を書く。
- `## Acceptance criteria` または `## 受け入れ条件` — 完了時に満たす条件と、必要な検証コマンドを書く。

必要に応じて `## Out of scope` / `## 対象外` も書き、今回やらないことを明確にしてください。

Gate では、見出し以外にも次を確認します。

- 子 Issue や task list を実装単位として要求していない。
- PRD 型 Issue、設計検討、RFC、計画作成だけの Issue ではない。
- 既存の open PR が `Closes #N` / `Fixes #N` / `Resolves #N` で対象 Issue を閉じる形になっていない。
- GitHub Relationships metadata と本文・コメント上の依存 Issue がすべて closed である。

契約不足の場合、coordinator は `agent:implement` を外し、`needs-triage` を付け、不足点を Issue にコメントします。Issue 本文を直したら、`agent:implement` を付け直すと次回以降の実行で復帰できます。子 Issue を持つ親 Issue、PRD 型 Issue、既存 PR がある Issue は `agent:blocked` に送られるため、実装可能な単位の Issue を別に用意してください。依存 Issue が open の場合はラベル変更やコメントをせず、その実行では見送ります。

主な制御ラベル:

- `agent:in-progress` — 実装中
- `agent:review` — PR レビュー対象
- `agent:reviewing` — レビュー自動化が処理中
- `agent:blocked` — 自動処理を止める
- `ready-for-human` — 人間確認対象
- `needs-info` — 情報不足

## 注意

- Pi パッケージ / 拡張はローカル環境で任意コードを実行できます。信頼できる配布元だけを入れてください。
- 現在の実行基盤は Herdr です。Herdr CLI が入っていない環境では動きません。
- `projects.json` にはローカルパスやリポジトリ名が入るため、このリポジトリには含めません。
