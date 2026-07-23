![deadloop banner](docs/assets/deadloop-banner.webp)

[English](README.md) | 日本語

# deadloop

> ループを作るためのループ、頑張っちゃうぞ。

**GitHub Issue から、レビュー済みの PR へ。** deadloop は Issue を監視し、実装、PR 作成、レビュー、マージを、安全装置付きで自動化します。

## インストール

```bash
npx skills@latest add yasuhito/deadloop
```

## 現在の状態

- v0 は Pi パッケージ／拡張として動作します。
- 既定の実行基盤は [Herdr](https://herdr.dev/) です。
- 公開名、パッケージ名、コマンド、設定パス、環境変数には **deadloop** を使用します。

## 安全を最優先する

信頼できるソースからのみインストールしてください。deadloop は GitHub Issue や PR へのコメント投稿、ラベル変更、PR 作成を行います。`autoMerge: true` を明示的に有効にすると、PR の squash merge と作業ブランチの削除も行います。

最初はテスト用リポジトリ、またはブランチ保護と権限を把握しているリポジトリで、`autoMerge: false` に設定して始めてください。

## 設定

ローカル設定なしで使う場合は、対象リポジトリの信頼済み基準ブランチのルートに `deadloop.json` をコミットし、そのチェックアウトから Pi を起動します。deadloop は、現在の Git リポジトリから `repoPath`、GitHub リポジトリ、既定の Herdr ワークツリー保存先を推測します。

`~/.pi/agent/deadloop/projects.json` は、`autoMerge`、独自の `worktreeRoot`、`deadloop.json` を持たないリポジトリの管理など、ローカル環境だけで使う上書き設定に限定してください。上書きが必要な場合は、設定例をコピーして編集します。

```bash
mkdir -p ~/.pi/agent/deadloop
cp ~/.pi/agent/git/github.com/yasuhito/deadloop/extensions/deadloop/projects.example.json ~/.pi/agent/deadloop/projects.json
$EDITOR ~/.pi/agent/deadloop/projects.json
```

ローカルのチェックアウトから使う場合は、次のファイルをコピーします。

```text
/absolute/path/to/deadloop/extensions/deadloop/projects.example.json
```

`projects.json` はローカル設定です。コミットしないでください。

ローカルプロジェクトでは、次の項目を設定できます。

- `repoPath` — 対象リポジトリのチェックアウトへの絶対パス。現在の Git リポジトリの信頼済み基準ブランチに `deadloop.json` がある場合は省略できます。
- `githubRepo` — `owner/name` 形式の GitHub リポジトリ。`deadloop.json` から暗黙に設定するプロジェクトでは、`origin` リモートから推測します。
- `baseBranch` — ワークツリーの起点にするブランチまたはリモート参照。通常は `origin/main` です。暗黙に設定するプロジェクトでは、現在のブランチの上流から推測します。
- `worktreeRoot` — Herdr がワークツリーを作成するディレクトリ。暗黙に設定するプロジェクトでは、既定値は `~/.herdr/worktrees/<repo>/` です。
- `autoMerge` — リポジトリの安全策が十分に実証されるまでは `false` にしてください。
- `externalReview` — 既定では無効です。組み込みの CodeRabbit／Copilot リクエスト経路を利用できる場合に限り、`{ "enabled": true }` を設定してください。

共有するリポジトリ方針は、信頼済み基準ブランチの `deadloop.json` に置きます。標準ラベル、検証方法（`git diff --check` の後に `npm run check`、または既存の `test`／`lint`／`typecheck` スクリプトを実行）、作業エージェント向け指示ファイル（`AGENTS.md`、`CONTEXT.md`、`README.md`）、Issue 調整と PR レビューの自動処理、外部レビューの無効化には既定値があります。独自設定が必要な項目だけ記述してください。ローカルの `projects.json` はリポジトリ方針より優先されます。

実行時のプロンプトと完了報告は、対象ワークツリーの外にある `~/.pi/agent/deadloop/runs/` へ保存します。deadloop は、設定したプロジェクト検査の実行中、未追跡の `.deadloop` と `.pi-subagents` を一時的に隔離します。そのため、生成された JSON が再帰的な整形や静的検査の対象に混入しません。Git 管理ファイルは隠しません。いずれかの実行時ディレクトリに Git 管理ファイルがある場合、検証は安全のため失敗します。

## ラベルを作成する

リポジトリごとに、標準ラベルを一度作成します。

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

Issue は、`ready-for-agent` と `agent:implement` の両方が付いている場合に限り処理対象になります。

## マージ競合の自動修復

同じリポジトリにある選択済み PR が設定済みの基準ブランチと競合した場合、deadloop は一度だけ、安全策を備えたブランチ更新用の作業エージェントを起動できます。この作業エージェントは、選択された基準コミットを既存の PR ブランチへマージします。rebase は行いません。設定済みの検査を実行し、通常の push の直前に PR の先頭コミットを再確認してから、通常のレビューへ戻します。更新中もレビュー用ラベルを維持するため、追加のラベルは不要です。

同じ PR の先頭コミットと基準側の先頭コミットの組み合わせに対する試行は一度だけです。PR の先頭コミットが変わっていた場合は push せずに停止し、次の周期で再評価します。更新に失敗した場合や安全を確認できない場合は、復旧情報とともに `agent:blocked` を付けます。安全契約については [ADR 0011](docs/adr/0011-pr-merge-conflict-recovery.md) を参照してください。

## レビュー指摘の自動修正

組み込みのレビューエージェントが構造化された修正可能な指摘を返すと、deadloop は既存の PR ブランチで、一度だけ専用の修正用作業エージェントを起動できます。修正中もレビュー用ラベルを維持し、修正専用ラベルは追加しません。作業エージェントには指摘事項だけを渡します。設定済みの検査を実行し、対象ブランチへの通常の push の直前に PR の先頭コミットを再確認します。強制 push や GitHub の作業状態の変更は行いません。

先頭コミットが変わると、新しいレビュー周期が始まります。先頭コミットがすでに変わっていた場合は、push もラベル変更も行わずに停止します。上限付きの試行後も同じ指摘が残った場合、人間の判断が必要な場合、または技術上／安全上の再試行を使い切った場合は、復旧情報とともに `agent:blocked` を付けます。詳しくは [ADR 0012](docs/adr/0012-automatic-pr-review-repair.md) を参照してください。

## 段階的に導入する

1. **Issue の調整のみ** — 慎重に導入したい場合は、ここから始めます。PR のレビューとマージは人間が行います。
2. **PR の自動レビュー** — 標準の PR レビューを `autoMerge: false` で使用します。レビュー済み PR は `ready-for-human` に移して人間へ引き渡します。`externalReview.enabled` が `true` の場合を除き、外部レビューは要求しません。
3. **任意の自動マージ** — ブランチ保護、CI、レビュー要件、dry-run／人間による承認手順、停止条件が十分に実証されてから、`autoMerge: true` を検討してください。

## 実行

対象リポジトリ内で Pi を起動します。

```bash
cd /absolute/path/to/target/repo
pi
```

利用できるコマンド:

```text
/deadloop-status
/deadloop-doctor
```

運用者向けの環境変数:

```bash
DEADLOOP_CONFIG=/path/to/projects.json pi
DEADLOOP_PROJECTS=my-project pi
DEADLOOP=off pi
DEADLOOP_AUTOMATIONS=off pi
DEADLOOP_DEBUG=1 pi
```

## ドキュメント

- 設定ガイド: [docs/public-package-setup.md](docs/public-package-setup.md)
- Herdr runner の詳細: [docs/herdr-runner.md](docs/herdr-runner.md)

## このリポジトリを検証する

```bash
npm test
npm run lint
npm run typecheck
bash -n extensions/deadloop/automations/*.sh
npm pack --dry-run
```
