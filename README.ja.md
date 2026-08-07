![deadloop banner](docs/assets/deadloop-banner.webp)

[English](README.md) | 日本語

# deadloop

> ループを作るのはあなた。回すのは deadloop。頑張っちゃうぞ。

**GitHub Issue から、レビュー済みの PR へ。** deadloop は Issue を監視し、実装、PR 作成、レビュー、マージを、安全装置付きで自動化します。

## インストール

Pi パッケージをインストールして有効化します。

```bash
pi install git:github.com/yasuhito/deadloop
```

対話形式の設定案内が必要な場合は、任意でセットアップスキルもインストールします。

```bash
npx skills@latest add yasuhito/deadloop
```

## 現在の状態

- v0 は Pi パッケージ／拡張として動作します。
- 既定の実行基盤は [Herdr](https://herdr.dev/) です。

## 設定

### リポジトリを有効化する

通常の Git チェックアウトから、ローカルのスケジューラーを明示的に有効化します。

```text
/deadloop-enable
```

deadloop は、チェックアウト先、GitHub リポジトリ、基準ブランチ、Herdr の既定のワークツリー保存先を自動的に取得します。

実行許可は `~/.pi/agent/deadloop/` 配下のローカル状態に保存されます。`deadloop.json` や `projects.json` が存在するだけでは、自動処理を開始しません。

### 事前確認を通過する

自動処理を有効化する前に、`/deadloop-enable` は信頼済み基準コミットから、所有権を記録した一時 Git ワークツリーを作ります。通常のチェックアウトにある未コミット変更を混ぜずに、その中で明示された必須検証コマンドを実行します。

検証が失敗すると、自動処理は無効のままです。コマンドは保存したログの場所を表示します。この事前確認では、Herdr の実行場所もエージェントも作りません。

再度有効化するときは、リポジトリ、コミット、コマンド、情報源、基準コミットがすべて一致する成功記録だけを再利用します。

事前確認では、終了結果にかかわらず、生成された実行成果物の復元を試みます。復元に失敗した場合は、隔離先と一時ワークツリーを保全し、両方の場所を記録して `/deadloop-doctor` で表示します。

### GitHub の権限とラベルを確認する

事前確認に成功すると、`/deadloop-enable` は GitHub への書き込み権限を確認します。不足している標準ラベルだけを作成します。

### 最初は自動マージを無効にする

新規に有効化したリポジトリは、必ず `autoMerge: false` で始まります。

有効化時に既存の `autoMerge: true` が見つかった場合も、自動マージは無効のままです。危険性を理解して有効にするには、リポジトリの有効化後に設定を `false` から `true` へ明示的に変更してください。

この確認結果は、無効化してから再び有効化した場合も維持されます。自動マージを使うまでは、`autoMerge` を `false` のままにしてください。

### リポジトリを無効化または再有効化する

`/deadloop-disable` はスケジューリングを停止します。実行中のエージェントは停止せず、GitHub の状態、ワークツリー、実行成果物も削除しません。

旧版から更新した場合は、リポジトリごとに再度有効化してください。

### 必要な場合だけローカル設定を上書きする

`autoMerge` やワークツリー保存先などを変更する場合だけ、設定例を Pi のローカル状態へコピーします。

```bash
mkdir -p ~/.pi/agent/deadloop
cp ~/.pi/agent/git/github.com/yasuhito/deadloop/extensions/deadloop/projects.example.json ~/.pi/agent/deadloop/projects.json
$EDITOR ~/.pi/agent/deadloop/projects.json
```

`projects.json` にはローカルのパスや運用設定が含まれます。リポジトリにはコミットしないでください。

### 必須検証コマンドを定義する

リポジトリが所有する集約検証コマンドは、可能な限り信頼済みの `deadloop.json` に定義します。たとえば、`"checkCommand": "npm run check"` と指定します。

ローカル値は、意図的に上書きする場合だけ使ってください。

`/deadloop-status` と `/deadloop-doctor` は、実効必須検証コマンド、その情報源、信頼済み基準コミット、上書き情報を表示します。

必須検証を解決できない場合、doctor は非権威の候補を表示します。候補は `package.json` の検証用スクリプトと、GitHub Actions の個々の `run` ステップから探します。

doctor は、各候補の情報源、作業ディレクトリ、明示された実行コンテキストを保ちます。候補を必須検証へ昇格したり、複数の候補を一つのコマンドへ合成したりはしません。

すべての設定項目は [設定ガイド](docs/public-package-setup.md) を参照してください。

## 安全装置

`autoMerge` は、レビュー済みの PR を deadloop が自動的にマージするかを制御します。

`false` では、PR の作成とレビューまでを自動化し、マージは人間に引き渡します。

`true` では、安全条件を満たした PR を squash merge し、作業ブランチを削除します。

必須検証が未実施または失敗していても、レビュー担当は修正要求や人間の判断が必要という結果を記録できます。承認、合格としての人間への引き渡し、マージ候補への追加には、現在の PR head に対してホストが記録した必須検証の成功が必要です。エージェントが報告した検証結果は追加情報としてのみ扱います。

最初は `false` に設定してください。ブランチ保護、CI、権限、停止条件を確認してから `true` にします。

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

同じリポジトリにある選択済み PR が設定済みの基準ブランチと競合した場合、deadloop は一度だけ、安全策を備えたブランチ更新用の作業エージェントを起動できます。

作業エージェントは、選択された基準コミットを既存の PR ブランチへマージします。rebase は行いません。

作業エージェントは、設定済みの検査を実行します。PR の先頭が検証済みコミットと一致する場合だけ、ブランチを不可分に更新して通常のレビューへ戻します。

更新中もレビュー用ラベルを維持します。追加のラベルは不要です。

同じ PR の先頭コミットと基準側の先頭コミットの組み合わせに対する試行は、一度だけです。

PR の先頭コミットが変わっていた場合は、push せずに停止します。deadloop は次の周期で PR を再評価します。

更新に失敗した場合や安全を確認できない場合は、復旧情報とともに `agent:blocked` を付けます。

安全契約については [ADR 0011](docs/adr/0011-pr-merge-conflict-recovery.md) を参照してください。

## レビュー指摘の自動修正

組み込みのレビューエージェントが構造化された修正可能な指摘を返すと、deadloop は既存の PR ブランチで、一度だけ専用の修正用作業エージェントを起動できます。

修正中もレビュー用ラベルを維持します。修正専用ラベルは追加しません。

作業エージェントには、指摘事項だけを渡します。

最終処理では、まず修正範囲を測定します。上限を超えた場合は、設定済みの検査を実行せず、push せずに人間へ引き渡します。

修正が上限内の場合は、設定済みの検査を実行します。対象ブランチの先頭が検証済みコミットと一致する場合だけ、そのブランチを不可分に更新します。

別の先頭コミットを置き換えたり、GitHub の作業状態を変更したりはしません。

レビュー結果は、読みやすい PR コメントとして記録します。コメントには、対象コミット、判断理由、指摘事項、次の操作を記載します。

修正の push を確認した後は、結果を別のコメントに記録します。コメントには、指摘ごとの変更内容、新しいコミット、検査結果、再レビューへの引き渡しを記載します。

先頭コミットが変わっていた場合や修正に失敗した場合は、成功コメントを投稿しません。

先頭コミットが変わると、新しいレビュー周期が始まります。

先頭コミットがすでに変わっていた場合は、push もラベル変更も行わずに停止します。

上限付きの試行後も同じ指摘が残った場合は、復旧情報とともに `agent:blocked` を付けます。人間の判断が必要な場合や、技術上または安全上の再試行を使い切った場合も同様です。

詳しくは [ADR 0012](docs/adr/0012-automatic-pr-review-repair.md) を参照してください。

## 段階的に導入する

1. **Issue の調整のみ** — 慎重に導入したい場合は、ここから始めます。PR のレビューとマージは人間が行います。
2. **PR の自動レビュー** — 標準の PR レビューを `autoMerge: false` で使用します。レビュー済み PR は `ready-for-human` に移して人間へ引き渡します。`externalReview.enabled` が `true` の場合を除き、外部レビューは要求しません。
3. **任意の自動マージ** — ブランチ保護、CI、レビュー要件、dry-run または人間による承認手順、停止条件が十分に実証されてから、`autoMerge: true` を検討してください。

## 実行

対象リポジトリ内で Pi を起動します。

```bash
cd /absolute/path/to/target/repo
pi
```

利用できるコマンド:

```text
/deadloop-enable
/deadloop-disable
/deadloop-status
/deadloop-doctor
/deadloop-abandon-attempt <attempt-id>  # doctor に表示された場合のみ
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

実行可能な受け入れ仕様は [`acceptance/features/`](acceptance/features/) にあります。

問題を調べる際は、Vitest と Cucumber を個別に実行できます。`npm test` は常に両方を直列に実行します。

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
