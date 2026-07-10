# AGENTS.md

## プロジェクトの目的

`deadloop` は、GitHub Issue の実装、PR レビュー、必要な修正、検証、マージまでの作業ループを回すためのループエンジニアリングツールです。

現在の v0 は Pi パッケージ / 拡張として動き、標準実行基盤に Herdr を使います。長期的には Herdr 専用ツールではなく、実行基盤を差し替えられる形に育てます。

## 最初に読むもの

作業前に、変更対象に応じて次を読むこと。

- 全体像: `README.md`
- Pi 拡張の実体: `extensions/deadloop/README.md`
- Herdr 実行基盤の役割: `docs/herdr-runner.md`
- 改名境界: `docs/migration-to-deadloop.md`
- パッケージ定義: `package.json`
- 自動化プロンプト / 事前確認を触る場合: `extensions/deadloop/automations/`

Pi 拡張 / パッケージの仕様に関わる変更では、Pi 本体のドキュメントも確認すること。

- Extensions: `/home/yasuhito/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Packages: `/home/yasuhito/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`

## Matt workflow

このリポジトリでは、Matt skills の考え方に従って作業を進める。

- 大きな機能、公開方針、設計変更は、いきなり実装せず `/grill-with-docs` 相当の聞き取りで目的と制約を明確にする。
- 聞き取りでは抽象的な専門用語だけで質問せず、このリポジトリの製品や操作に置き換えた具体例と推奨案を示し、一度に一つの判断を確認する。
- 複数セッションに分かれる大きな作業は、PRD と独立した Issue に分けてから実装する。
- 小さく具体的な変更は、そのまま実装してよい。ただし、完了前に差分を見直す。
- 実装では、可能な限り `/tdd` の考え方で、先に観測可能な失敗や検証用データを作ってから直す。
- 変更後は `/code-review` の考え方で、仕様適合と標準適合の 2 軸を確認する。

## 設計方針

- LLM プロンプトは判断、説明、曖昧な状況の扱いに寄せる。
- 決定論的に判定できる処理は、プロンプトに埋めず、スクリプトまたは TypeScript の関数へ切り出す。
- GitHub / Herdr / git の状態は毎回コマンドで再取得し、セッションの記憶に依存しない。
- 自動マージ、head branch 削除、ラベル変更、コメント投稿は安全側に倒す。
- 公開パッケージとして使われる前提で、ローカルパス、秘密情報、個人リポジトリ固有の設定を既定値にしない。
- Herdr 固有処理は実行基盤の境界へ寄せる。Issue / PR の状態管理は実行基盤に依存しない形に保つ。

## 安全ルール

- `extensions/deadloop/projects.json` はローカル設定であり、コミットしない。
- API キー、トークン、個人リポジトリ固有のパス、個人環境だけで成立する設定をコミットしない。
- main workspace で破壊的な git 操作をしない。
- `git reset --hard`、`git clean`、強制 push、branch の強制削除は、ユーザーの明示指示なしに実行しない。
- 自動化プロンプトの安全制約を弱めない。特に作業エージェントに push / ラベル操作 / PR 作成 / Issue close を許す変更は、明示的な設計判断なしに行わない。
- 自動マージに関わる変更は、dry-run、manual approval、失敗時の停止条件を確認する。

## 検証

変更内容に応じて、少なくとも次を実行する。

```bash
npm test
npm run lint
npm run typecheck
bash -n extensions/deadloop/automations/*.sh
npm pack --dry-run
```

自動化の選定ロジック、プロンプト描画、スケジューラー、実行基盤境界を変更した場合は、検証用データを使うテスト追加を優先する。テスト基盤が未整備なら、変更と同時に最小のテスト入口を作る。

テストケースごとのアサーション / expectation は、たかだか 1 つにする。複数の観点を確認したい場合は、観点ごとにテストケースを分ける。失敗時に、どの期待が壊れたかをテスト名と 1 つの assertion からすぐ分かるようにする。

## ドキュメント方針

- 公開ユーザー向けの説明は、最終的には英語を正とする。
- 当面、日本語の既存 README / プロンプトを変更する場合は、意味が曖昧にならないように短く書く。
- 日本語文の中では、不自然な英日混在の「ルー語」を避ける。英語の普通名詞に自然な日本語訳がある場合は日本語で書く（例: `config を更新` ではなく `設定を更新`、`prompt の変更` ではなく `プロンプトの変更`）。ただし、製品名、コマンド名、ファイル名、API 名、CLI 引数、環境変数、GitHub ラベル名など、識別子として英語表記が必要な語はそのまま書いてよい。
- GitHub Issue / PR の本文やコメントも、公開利用者向けの英語文書を作る場合を除き、日本語で自然に書く。
- `README.md` はユーザー向け、`extensions/deadloop/README.md` は拡張の運用メモ、`docs/` は設計・実行基盤仕様に使う。
- 新しい大きな方針を決めた場合は、README だけに埋めず、必要に応じて `docs/` に設計メモまたは ADR を追加する。

## コミット前チェック

- `git status --short` で意図しないファイルが混ざっていないことを確認する。
- `extensions/deadloop/projects.json` や一時ファイルが staged されていないことを確認する。
- README / docs / プロンプトの変更は、実装と矛盾していないか読み直す。
- 自動化プロンプトを変えた場合は、GitHub に書き込む文面、ラベル遷移、停止条件を重点的に見直す。
