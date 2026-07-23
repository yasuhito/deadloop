![deadloop banner](docs/assets/deadloop-banner.webp)

[English](README.md) | 日本語

# deadloop

> ループを作るのはあなた。回すのは deadloop。頑張っちゃうぞ。

**GitHub Issue から、レビュー済みの PR へ。** deadloop は Issue を監視し、実装、PR 作成、レビュー、マージを、安全装置付きで自動化します。

## インストール

```bash
npx skills@latest add yasuhito/deadloop
```

## 現在の状態

- v0 は Pi パッケージ／拡張として動作します。
- 既定の実行基盤は [Herdr](https://herdr.dev/) です。

## 設定

標準設定で始めるには、対象リポジトリのルートに `deadloop.json` を作成し、基準ブランチへコミットします。

```json
{}
```

deadloop は現在の Git リポジトリから、ローカルのチェックアウト先、GitHub リポジトリ、基準ブランチ、Herdr のワークツリー保存先を自動的に取得します。最初の実行にローカル設定は必要ありません。

`autoMerge` やワークツリー保存先などを変更する場合だけ、設定例を Pi のローカル設定へコピーします。

```bash
mkdir -p ~/.pi/agent/deadloop
cp ~/.pi/agent/git/github.com/yasuhito/deadloop/extensions/deadloop/projects.example.json ~/.pi/agent/deadloop/projects.json
$EDITOR ~/.pi/agent/deadloop/projects.json
```

`projects.json` にはローカルのパスや運用設定が含まれるため、リポジトリにはコミットしないでください。すべての設定項目は [設定ガイド](docs/public-package-setup.md) を参照してください。

## 安全装置

`autoMerge` は、レビュー済みの PR を deadloop が自動的にマージするかを制御します。

`false` では、PR の作成とレビューまでを自動化し、マージは人間に引き渡します。`true` では、安全条件を満たした PR を squash merge し、作業ブランチを削除します。

最初は `false` に設定し、ブランチ保護、CI、権限、停止条件を確認してから `true` にしてください。

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

実行可能な受け入れ仕様は [`acceptance/features/`](acceptance/features/) にあります。問題を調べる際は Vitest と Cucumber を個別に実行できます。`npm test` は常に両方を直列に実行します。

```bash
npm run test:unit
npm run test:acceptance
npm test
npm run lint
npm run typecheck
bash -n extensions/deadloop/automations/*.sh
npm pack --dry-run
npm run check
```
