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
- 現在対応しているホスト環境は、互換性のある `flock` 実行ファイル（通常は util-linux が提供）と、非待機のファイル記述子ロックを利用できる Unix 系システムです。`/deadloop-enable` は自動処理を有効化する前に、この機能を検査します。

## 設定

認証済みの `gh` CLI、起動中の互換 [Herdr](https://herdr.dev/) サーバー、リポジトリに必要な検査をまとめて実行するコマンドを用意してください。

1. リポジトリ直下の `deadloop.json` に検証コマンドを追加します。

   ```json
   {
     "checkCommand": "npm run check"
   }
   ```

   `npm run check` は、そのリポジトリのテストなど、必要な検査をまとめて実行するコマンドに置き換えてください。次へ進む前に、`deadloop.json` をリポジトリの基準ブランチへコミットして push します。deadloop は共有方針を基準ブランチから読み取ります。

2. 通常の Git チェックアウトから Pi を起動します。

   ```bash
   cd /absolute/path/to/your/repo
   pi
   ```

3. deadloop を有効化します。

   ```text
   /deadloop-enable
   ```

4. deadloop に任せる Issue に、次のラベルを両方付けます。

   - `ready-for-agent`
   - `agent:implement`

これだけで利用を開始できます。有効化すると、deadloop は不足している標準ラベルを作成し、自動マージを無効にした状態で動き始めます。対象の Issue を実装して PR を作成・レビューし、レビュー済みの PR を人間へ引き渡します。

## 有効化で行うこと

`/deadloop-enable` は、リポジトリ、基準ブランチ、Herdr のワークツリー保存先を自動的に取得します。その後、次の処理を行います。

1. 一時ワークツリーで設定済みの検証コマンドを実行する
2. GitHub の認証と書き込み権限を確認する
3. 不足している標準ラベルを作成する
4. `~/.pi/agent/deadloop/` にスケジューラーの実行許可を保存する

検査に失敗した場合、deadloop は無効のまま、修正が必要な内容を表示します。詳しく調べるには `/deadloop-doctor` を使ってください。

設定ファイルが存在するだけでは、自動処理は始まりません。`/deadloop-disable` は新しい作業の開始を止めますが、実行中のエージェントは停止せず、GitHub の状態、ワークツリー、実行成果物も削除しません。旧版から更新した場合は、リポジトリごとに再度有効化してください。

## 詳細設定

標準の設定では、ローカル設定ファイルは不要です。`autoMerge`、ワークツリー保存先、信頼済みの別の自動処理ホストなどを上書きする場合だけ作成します。

```bash
mkdir -p ~/.pi/agent/deadloop
cp ~/.pi/agent/git/github.com/yasuhito/deadloop/extensions/deadloop/projects.example.json ~/.pi/agent/deadloop/projects.json
$EDITOR ~/.pi/agent/deadloop/projects.json
```

`projects.json` にはローカルのパスや運用設定が含まれます。リポジトリにはコミットしないでください。共有する検証コマンドなど、レビュー対象にする方針は、リポジトリ内の `deadloop.json` に記載することを推奨します。

すべての設定項目と有効化の詳しい動作は、[設定ガイド](docs/public-package-setup.md)を参照してください。

## 安全装置

`autoMerge` は、レビュー済みの PR を deadloop が自動的にマージするかを制御します。

`false` では、PR の作成とレビューまでを自動化し、マージは人間に引き渡します。

`true` では、安全条件を満たした PR を squash merge し、作業ブランチを削除します。

最初は `false` に設定してください。ブランチ保護、CI、権限、停止条件を確認してから `true` にします。

## マージ競合の自動修復

現在の GitHub claim 導入期間中は、ブランチ更新の変更処理を副作用なしで停止します。#241 で追跡する `agent:update-branch` への引き渡しが実装されるまで利用できません。既存の非 force、先頭コミットの厳密一致、必須検証、通常 merge の安全契約は引き続き必要であり、この一時停止によって廃止されるものではありません。

以下のブランチ更新動作は、維持する安全契約の説明であり、現在到達できる変更経路の説明ではありません。

作業エージェントは、選択された基準コミットを既存の PR ブランチへマージします。rebase は行いません。

作業エージェントは、設定済みの検査を実行します。PR の先頭が検証済みコミットと一致する場合だけ、ブランチを不可分に更新して通常のレビューへ戻します。

更新中もレビュー用ラベルを維持します。追加のラベルは不要です。

同じ PR の先頭コミットと基準側の先頭コミットの組み合わせに対する試行は、一度だけです。

PR の先頭コミットが変わっていた場合は、push せずに停止します。deadloop は次の周期で PR を再評価します。

更新に失敗した場合や安全を確認できない場合は、復旧情報とともに `agent:blocked` を付けます。

安全契約については [ADR 0011](docs/adr/0011-pr-merge-conflict-recovery.md) を参照してください。

## レビュー指摘の自動修正

組み込みのレビューエージェントが構造化された修正可能な指摘を返すと、deadloop は既存の PR ブランチで、一度だけ専用の修正用作業エージェントを起動できます。

修正中は、有効な取得を示す `agent:in-progress` を維持し、別の作業状態ラベルは追加しません。修正完了までは新しい `agent:review` 要求を作らず、修正状態から移るときに古い `agent:reviewing` があれば除去します。

作業エージェントには、指摘事項だけを渡します。

最終処理では、変更したファイル数にかかわらず、すべての修正で設定済みの検査を実行します。対象ブランチの先頭が検証済みコミットと一致する場合だけ、そのブランチを不可分に更新します。

別の先頭コミットを置き換えたり、GitHub の作業状態を変更したりはしません。

レビュー結果は、読みやすい PR コメントとして記録します。コメントには、対象コミット、判断理由、指摘事項、次の操作を記載します。

各レビューは、PR のコミット列、正確な差分、会話コメント、送信済みレビュー、行コメントを全ページ取得した観測結果にも結び付けます。追加、編集、削除、head または base の変更、差分の変更があれば、進行中のレビュー要求を解除して新しいレビューを必要とします。コメント本文は、信頼できない証拠としてのみ扱います。

修正の push を確認した後は、結果を別のコメントに記録します。コメントには、指摘ごとの変更内容、新しいコミット、検査結果、再レビューへの引き渡しを記載します。

先頭コミットが変わっていた場合や修正に失敗した場合は、成功コメントを投稿しません。

先頭コミットが変わると、新しいレビュー周期が始まります。

先頭コミットがすでに変わっていた場合は、push もラベル変更も行わずに停止します。

上限付きの試行後も同じ指摘が残った場合は、復旧情報とともに `agent:blocked` を付けます。人間の判断が必要な場合や、技術上または安全上の再試行を使い切った場合も同様です。

詳しくは [ADR 0012](docs/adr/0012-automatic-pr-review-repair.md) を参照してください。

## 段階的に導入する

1. **Issue の調整のみ** — 慎重に導入したい場合は、ここから始めます。PR のレビューとマージは人間が行います。
2. **PR の自動レビュー** — 標準の PR レビューを `autoMerge: false` で使用します。レビュー済み PR は `ready-for-human` に移して人間へ引き渡します。現在の導入期間中は、有効なレビュー claim 配下へ接続されるまで外部レビューの変更処理も副作用なしで停止します。`externalReview` を有効にしても、この停止を回避しません。
3. **任意の自動マージ** — ブランチ保護、CI、レビュー要件、dry-run または人間による承認手順、停止条件が十分に実証されてから、`autoMerge: true` を検討してください。

## 運用コマンド

対象リポジトリで起動した Pi セッションから、次のコマンドを実行できます。

```text
/deadloop-enable
/deadloop-disable
/deadloop-status
/deadloop-doctor
/deadloop-abandon-attempt <attempt-id>  # doctor に表示された場合のみ
/deadloop-complete-github-state-migration updated-hosts-stopped  # GitHub 状態移行を配備した後の一度限りの確認
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
