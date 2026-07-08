# pi-looper

pi-looper は、[Pi](https://pi.dev/) 上で GitHub Issue から実装、PR 作成、レビュー、修正、検証、マージまでを自動で回すためのループエンジニアリングツールです。

人間がエージェントに渡せる Issue を用意すると、pi-looper が定期的に GitHub を見に行きます。実装可能な Issue があれば、Issue coordinator が Herdr worktree に Pi の作業エージェントを起動し、作業エージェントが実装します。実装後はオーケストレータが検証して PR を作り、PR reviewer が別 Pi セッションのレビューエージェントを起動してレビュー、必要な修正、再検証、最終マージまで進めます。

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

   If you start from the Agent Skills ecosystem, this repository also exposes a compatibility skill:

   ```bash
   npx skills@latest add yasuhito/pi-looper
   ```

   That command installs the setup skill only. To activate the Pi extension, still run `pi install git:github.com/yasuhito/pi-looper`.

2. Create local config outside the repository and edit it for your checkout. If you installed from GitHub, Pi clones the package under `~/.pi/agent/git/github.com/yasuhito/pi-looper`:

   ```bash
   mkdir -p ~/.pi/agent/pi-looper
   cp ~/.pi/agent/git/github.com/yasuhito/pi-looper/extensions/pi-looper/projects.example.json ~/.pi/agent/pi-looper/projects.json
   $EDITOR ~/.pi/agent/pi-looper/projects.json
   ```

   For a local development checkout, copy from `/absolute/path/to/pi-looper/extensions/pi-looper/projects.example.json` instead.

   `projects.json` is local config. It contains local paths and rollout choices, so do **not** commit it. Keep `autoMerge: false` while getting started.

   If a project uses `workerAgent: "claude"`, the operator must first run `claude` interactively once from the target repository root and accept Claude Code workspace trust for that checkout.

3. Create the required GitHub labels, then label an issue with both `ready-for-agent` and `agent:implement`.

4. Roll out in phases:
   - Phase 1: enable only `issue-coordinator` so automation stops after PR creation.
   - Phase 2: add `pr-reviewer` with `autoMerge: false` so reviewed PRs go to `ready-for-human`.
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

Agent Skills の入口から導入メモを入れる場合:

```bash
npx skills@latest add yasuhito/pi-looper
```

このコマンドは `pi-looper` のセットアップ用 skill を追加するだけで、Pi extension は有効化しません。実際に自動化を読み込ませるには、上の `pi install git:github.com/yasuhito/pi-looper` も実行してください。

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

設定は、ローカルの `projects.json`、信頼済み base branch の `pi-looper.project.json`、パッケージ既定値の順に重ねます。優先順位は `projects.json` の明示値 > `git fetch` 後に `baseBranch` から読む `pi-looper.project.json` > パッケージ既定値です。PR branch 側の `pi-looper.project.json` は、その PR 自身の判断には使いません。

主な設定項目:

- `repoPath` — 対象リポジトリのローカルパス
- `githubRepo` — `owner/name`
- `baseBranch` — worktree の基準 branch
- `worktreeRoot` — Herdr worktree の root
- `checkCommand` — 作業エージェント / レビューエージェントが最後に通す検証コマンド。pi-looper 自体では `npm test && npm run lint && npm run typecheck && bash -n extensions/pi-looper/automations/*.sh && npm pack --dry-run` を標準検証にしています
- `autoMerge` — `true` のときだけ PR reviewer が条件を満たした PR をマージする。既定値は `false` なので、初回導入では明示的に `false` のままにしてください
- `ciFallback` — GitHub Actions が課金・quota・Actions 停止などで実行できないと決定論的に判定できる場合だけ、PR reviewer がローカル CI 相当検証を代替として扱う設定。既定は `{ "enabled": false, "mode": "billing-only", "allowAutoMerge": false }` です。`allowAutoMerge: false` では代替検証が成功してもマージせず `ready-for-human` に渡します。`allowAutoMerge: true` でも、GitHub CI が成功していない PR のマージには最新 head SHA への手動承認コメント、dry-run 相当の直前再確認、失敗時停止条件が必要です。必要なら `localCommands` に `git diff --check`、lint、関連テストなどを並べます
- `workerInstructions` — 作業エージェント用プロンプトに差し込むプロジェクト固有指示
- `workerAgent` — Worker を起動するエージェント種別。列挙値は `"pi"` / `"claude"`、未設定時は `"pi"`。`"claude"` を使う場合は、対象リポジトリのルートで operator が一度 `claude` を対話起動し、Claude Code の workspace trust を受け入れておく
- `workerModel` — 作業エージェントの使用モデル。選択した `workerAgent` が理解する形式で書く（`pi` は `provider/id`、`claude` は `opus` / `claude-opus-4-8` など）。設定するとオーケストレータは issue の内容にかかわらず必ずこのモデルで Worker を起動する。未設定なら各エージェントの既定モデルを使う
- `reviewerAgent` — レビューエージェントを起動するエージェント種別。列挙値は `"pi"` / `"claude"`、未設定時は `"pi"`。`"claude"` を使う場合は、対象リポジトリのルートで operator が一度 `claude` を対話起動し、Claude Code の workspace trust を受け入れておく
- `reviewerModel` — レビューエージェントの使用モデル。選択した `reviewerAgent` が理解する形式で書く（`pi` は `provider/id`、`claude` は `opus` / `claude-opus-4-8` など）。実装(重い)とレビュー(軽い)でサブスクリプションの消費先を分けられるよう独立させている
- `labels` — Issue / PR のラベル
- `automations` — schedule、prompt、precheck、任意の決定論的ドライバー。`driverFile` を設定すると、事前確認の通過後、プロンプト送信前に同梱された自動化スクリプトを実行し、`skip` / `done` / `needs_llm` / `error` の JSON 結果で LLM 呼び出しを絞れます

`pi-looper.project.json` で共有できるのは、`workerAgent`、`workerModel`、`reviewerAgent`、`reviewerModel`、`checkCommand`、`workerInstructions`、`workerLaunchPolicy`、`labels`、およびローカルで有効化済みの `automations` に対する `id` / `name` / `promptFile` / `precheckFile` / `driverFile` だけです。`enabled`、`repoPath`、`githubRepo`、`baseBranch`、`worktreeRoot`、`autoMerge`、`schedule`、`precheckTimeoutSeconds` はローカル設定に残します。特に `autoMerge` はリポジトリ設定から有効化できません。

共有ポリシー例:

```json
{
  "workerAgent": "pi",
  "workerModel": "anthropic/claude-opus-4-8",
  "reviewerAgent": "claude",
  "reviewerModel": "claude-opus-4-8",
  "checkCommand": "npm test && npm run lint && npm run typecheck",
  "workerInstructions": "AGENTS.md and relevant docs must be read before making changes."
}
```

repo policy が不正 JSON または許可されていない key を含む場合、その project の自動化は安全側に停止し、`/pi-looper-status` と `/pi-looper-doctor` に理由を表示します。共有ポリシーに寄せたい operator は、該当 key をローカル `projects.json` から削除してください。

v0 の `schedule` は `*/N * * * *` 形式だけに対応します。例: `*/10 * * * *`。

## 状況レポートと doctor 診断

Pi から次のコマンドで、運用者向けの状況レポートを確認できます。

```text
/pi-looper-status
```

レポートは現在ディレクトリから有効なプロジェクトを解決し、有効な自動化、現在の GitHub Issue / PR キュー、関連する Herdr 作業用 worktree、片付け候補、使用中の設定ソースを要約します。

ループが止まった原因を調べる場合は、読み取り専用の doctor 診断を実行できます。

```text
/pi-looper-doctor
```

doctor 診断は既知の失敗モードを検知し、所見ごとにコピペ可能な確認コマンドまたは解決コマンドを表示します。自動修復は行いません。所見が無い場合は「問題なし」と表示します。

検知する失敗モードには、GitHub Issue / PR キューや作業用 worktree の問題に加えて、`state.json` から読み取る自動化の実行状態も含みます。

- precheck が code 126/127 でスキップされ続けている(precheck スクリプトが不在または実行不能)
- 同じ失敗が 3 スロット以上連続し、ループが空回りしている
- 3 スロット以上、自動化の試行そのものが途絶えている(オーケストレータセッション停止の疑い)

## 付属自動化

- `issue-coordinator`
  - `issue-coordinator-driver.ts` で cleanup、候補なし、契約不足、実装単位外の gate を決定論的に処理し、不要な LLM 呼び出しを避ける
  - マージ済み / close 済み PR に対応する完了済み Herdr 作業用 workspace / worktree を決定論的な補助スクリプトで片付ける
  - 実装可能な Issue を1件選ぶ
  - Herdr worktree / Pi 作業エージェントを起動する
  - 作業エージェント完了後に検証して PR を作る
- `pr-reviewer`
  - `pr-reviewer-driver.ts` で対象なし、pending CI、外部レビュー待ち、draft gate、外部レビュー依頼を決定論的に処理し、不要な LLM 呼び出しを避ける
  - 通常は `agent:review` PR を1件選ぶ
  - `autoMerge: true` の場合に限り `ready-for-human` PR も対象にできる
  - Copilot / CodeRabbit / 人間コメントを確認する
  - 外部レビューが無い場合はレビューエージェントに代替レビューを依頼する
  - 必要な修正と検証は別 Pi セッションのレビューエージェントが担当する
  - `autoMerge: false` ではマージせず `ready-for-human` に渡す
  - `autoMerge: true` の場合だけ、オーケストレータ側で最終確認して squash merge する

## 環境変数

```bash
PI_LOOPER=off pi
PI_LOOPER_AUTOMATIONS=off pi
PI_LOOPER_PROJECTS=example-project pi
PI_LOOPER_CONFIG=/path/to/projects.json pi
PI_LOOPER_DEBUG=1 pi
PI_LOOPER_CI_FALLBACK_ENABLED=true pi
PI_LOOPER_CI_FALLBACK_MODE=billing-only pi
PI_LOOPER_CI_FALLBACK_ALLOW_AUTO_MERGE=false pi
```

## ラベル運用

実装用の作業エージェントに Issue を拾わせるには、Issue に最低限 `ready-for-agent` と `agent:implement` の両方を付けます。初回は、使うラベルを GitHub 側に作成してください。

```bash
gh label create ready-for-agent --repo owner/repo --color 0e8a16 || true
gh label create agent:implement --repo owner/repo --color 1d76db || true
gh label create agent:in-progress --repo owner/repo --color fbca04 || true
gh label create agent:review --repo owner/repo --color 5319e7 || true
gh label create agent:reviewing --repo owner/repo --color c2e0c6 || true
gh label create agent:blocked --repo owner/repo --color b60205 || true
gh label create ready-for-human --repo owner/repo --color d93f0b || true
gh label create needs-info --repo owner/repo --color fef2c0 || true
gh label create wontfix --repo owner/repo --color ffffff || true
gh label create needs-triage --repo owner/repo --color f9d0c4 || true
```

| 既定のラベル名 | `labels` の設定キー | 場所 | 誰 / 何が付けるか | 意味 |
| --- | --- | --- | --- | --- |
| `ready-for-agent` | `ready` | Issue | 人間 | エージェントに渡してよい Issue であることを示す。実装開始には `agent:implement` も必要。 |
| `agent:implement` | `implement` | Issue | 人間 | 実装対象の Issue であることを示す。実装開始には `ready-for-agent` も必要。 |
| `agent:in-progress` | `inProgress` | Issue | Issue coordinator | 作業エージェントが実装中であることを示す。 |
| `agent:review` | `review` | PR | Issue coordinator | PR reviewer の対象 PR であることを示す。 |
| `agent:reviewing` | `reviewing` | PR | PR reviewer | レビュー自動化が処理中であることを示す。 |
| `agent:blocked` | `blocked` | 両方 | 人間または自動化 | 自動処理を止め、人間の確認を待つ。 |
| `ready-for-human` | `human` | PR | PR reviewer | 自動処理を終え、人間確認に渡す。`autoMerge: false` ではマージせずこの状態にする。 |
| `needs-info` | `needsInfo` | Issue | 人間または自動化 | 情報不足のため Issue coordinator の対象から外す。 |
| `wontfix` | `wontfix` | Issue | 人間 | 対応しない Issue として Issue coordinator の対象から外す。 |
| `needs-triage` | `needsTriage` | Issue | 人間または自動化 | まだ整理が必要な Issue であることを示す。契約不足を検出した coordinator は `agent:implement` を外してこのラベルを付ける。 |

ラベル名は、プロジェクトごとに `projects.json` の `labels` object で変更できます。既存チームのラベルを使いたい場合は、設定値だけを差し替えます。新しい仕組みや別名表は不要です。

```json
{
  "projects": [
    {
      "id": "example-project",
      "labels": {
        "ready": "ready",
        "implement": "implement",
        "inProgress": "doing",
        "review": "review-needed",
        "reviewing": "reviewing",
        "blocked": "blocked",
        "human": "human-review",
        "needsInfo": "needs-info",
        "wontfix": "wontfix",
        "needsTriage": "triage"
      }
    }
  ]
}
```

この例では、実装用の作業エージェントに拾わせる Issue には `ready` と `implement` を付けます。GitHub 側には、設定した名前のラベルを事前に作成してください。pi-looper はラベル作成を自動化しません。

## エージェントに渡せる Issue の書き方

`issue-coordinator` は、Issue を作業エージェントに渡す前に実装契約を確認します。この条件は [extensions/pi-looper/automations/issue-coordinator.prompt.md](extensions/pi-looper/automations/issue-coordinator.prompt.md) の `### 3. Gate` 節を正とし、README の説明もその節に合わせます。

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

## 注意

- Pi パッケージ / 拡張はローカル環境で任意コードを実行できます。信頼できる配布元だけを入れてください。
- 現在の実行基盤は Herdr です。Herdr CLI が入っていない環境では動きません。
- `projects.json` にはローカルパスやリポジトリ名が入るため、このリポジトリには含めません。
