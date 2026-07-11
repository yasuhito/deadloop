# PROTOTYPE — 60〜90秒のdeadloop標準デモ

> **反応を得るための使い捨ての試作品です。** Issue「[一つの素材を流用できるdeadloop標準デモを試作する](https://github.com/yasuhito/deadloop/issues/93)」の判断用であり、完成した宣伝素材ではありません。実際の試験利用で撮影した素材へ置き換えた後、この文書と補助スクリプトは削除または正式な制作手順へ吸収します。

## この試作品が答える問い

テスト用Issueへのラベル付与から、Workerの実装、検証、PR作成、deadloopレビュー、`ready-for-human`での安全な停止までを、誤解を招かず60〜90秒で示し、README、Slack、部会、Xへ同じ素材を流用できるか。

## 結論

**75秒の無音ターミナル映像を標準素材にする。** 実行全体をその場で早送りするのではなく、破棄可能な公開リポジトリで一度だけ本物のループを完走し、4つの節目でGitHubから取得した証拠を、一定時間の再演として見せる。

この方式なら、モデルやCIの待ち時間を隠すために安全ゲートを短絡せず、URL付きの実在するIssue / PRを根拠にできる。映像には常に「実行証拠からの再演」であることを表示し、ライブ実行や75秒での完走を主張しない。

## 75秒の構成

| 時間 | 画面 | 伝えること | 根拠 |
|---:|---|---|---|
| 0〜15秒 | Issueと2つの適格ラベル | 小さなIssueを明示的にキューへ入れる | `queued-issue.json` |
| 15〜33秒 | `agent:in-progress`と短い説明 | Herdrの所有worktreeでWorkerを動かし、不明なら安全停止する | `working-issue.json` |
| 33〜51秒 | PR、commit数、check結果、head SHA | 現在のheadに対して検証する | `reviewed-pr.json` |
| 51〜65秒 | 同じhead SHAのPRと`ready-for-human` | deadloopレビュー後、自動マージせず人間へ判断を渡す | `handoff-pr.json` |
| 65〜75秒 | タイトルカード | 「GitHub Issues in, reviewed PRs out.」と導入URL | 固定文 |

標準デモでは、実装コードの詳細、設定全項目、Claude / Codex経路、自動マージを説明しない。対象利用者が最初に知るべき「何を入れるか」「何を保証するか」「どこで止まるか」だけに絞る。

## 撮影手順の試作

補助スクリプトは [`deadloop-standard-demo.sh`](deadloop-standard-demo.sh) に置いた。`gh`と`jq`で公開GitHub情報の必要項目だけを保存し、`asciinema`でタイトルカードを含む約75秒を収録する。再演前には、必要ラベル、成功したcheck、PRの状態、`autoMerge: false`の撮影方針、検証時と引き渡し時のhead SHA一致を決定論的に確認し、不足や不一致があれば録画しない。

このリポジトリには、まだ実際の試験用リポジトリから取得したcast / GIF / MP4を置いていない。試作段階では個人環境のURLや誤った成功表示を固定素材としてコミットせず、Issue #94で募集を始める前に作者の破棄可能な公開リポジトリで一度収録し、公開可能性と3問の理解確認を通った成果物だけをREADME候補にする。

### 1. 本物の試験実行を用意する

- 機密情報のない破棄可能な公開リポジトリを使う。
- `autoMerge: false`を固定する。
- 60〜90秒で実装できると約束するのではなく、通常の安全ゲートを通して完走させる。
- Issue / PRのタイトルとURLを公開してよいことを撮影前に確認する。

### 2. 4つの節目を取得する

```bash
export DEADLOOP_DEMO_REPO=owner/disposable-demo
export DEADLOOP_DEMO_ISSUE=12
export DEADLOOP_DEMO_DIR=/tmp/deadloop-demo-evidence
export DEADLOOP_DEMO_AUTO_MERGE=false

bash docs/prototypes/deadloop-standard-demo.sh capture queued
bash docs/prototypes/deadloop-standard-demo.sh capture working

export DEADLOOP_DEMO_PR=13
bash docs/prototypes/deadloop-standard-demo.sh capture reviewed
bash docs/prototypes/deadloop-standard-demo.sh capture handoff
```

各コマンドは、その節目に到達した時だけ実行する。`reviewed`ではcheckが現在のheadに対して完了していること、`handoff`ではdeadloopレビュー後のPRに`ready-for-human`があることを操作者が確認する。再演時にスクリプトもラベル、check、PR状態、head SHAの整合を検証するが、GitHub外のpromise内容そのものは公開証拠へ含めない。

### 3. 再演を確認して収録する

```bash
bash docs/prototypes/deadloop-standard-demo.sh replay
bash docs/prototypes/deadloop-standard-demo.sh record
```

再演は約75秒で、各画面に実在するIssue / PR URLを表示する。録画前にタイトル、ラベル、check結果、公開可能範囲を目視確認する。GitHubのタイトルに含まれる制御文字は表示前に除去する。

### 4. GIFとMP4へ変換する

```bash
bash docs/prototypes/deadloop-standard-demo.sh render
```

試作では`agg`と`ffmpeg`を使い、`/tmp/deadloop-standard-demo/`へGIFとMP4を出す。タイトルカードは収録に含まれる。BGM、音声、製品別の説明は再利用性を下げるため標準素材へ入れない。必要な試作用ツールは`gh`、`jq`、`asciinema`、`agg`、`ffmpeg`であり、公開素材を作る時点で実際に使ったバージョンをIssueコメントへ記録する。

## 発信面ごとの流用

同じMP4 / GIFを切り直さず使い、周囲の文だけ変える。

- **README**: GIFまたは静止画4枚。直下に「実行時間ではなく、実行証拠の65秒再演」と明記し、安全な導入手順へリンクする。
- **Slackの個人チャンネル**: MP4 + 「Pi + Herdr利用者2〜3人を募集。`autoMerge: false`の試験用リポジトリで文書だけの導入を観察したい」という短文。
- **部会**: 同じMP4を流し、前後に5分だけ「現在の安全契約」「試験で確認したい障壁」を口頭で補う。
- **X**: 同じMP4 + 一文の価値提案 + GitHub URL。第三者完走前は「試験利用者募集」と明記し、一般提供済みの成功率を示唆しない。

字幕を焼き込まなくても意味が通る画面構成にし、英語の公開文面を正とする。日本語の募集文は投稿側に置く。これにより一つの映像を編集し直さず使える。

## 試験利用者から実映像を得る条件

標準デモの初版は作者の破棄可能リポジトリで作ってよい。第三者のIssue / PRを使う場合は、[第三者導入観察票](third-party-onboarding-observation.md)の同意とは別に、次を個別確認する。

- Issue / PR URL、タイトル、リポジトリ名を公開してよい。
- 所要時間、停止、復旧の記録を公開してよい。
- 参加を断っても試験利用を続けられる。
- トークン、ローカルパス、通知、非公開コメントが映っていない。

同意が一つでもない場合、その参加者の画面は使わず、匿名化した集計だけを募集結果へ使う。

## 採用判断の基準

2〜3人へ無音で見せ、視聴直後に次の3問を聞く。

1. deadloopへ何を入力し、何が出てくると理解したか。
2. PRは自動でマージされたと思うか。
3. 65秒は実際の処理時間だと思うか、実行後の再演だと思うか。

3人中2人以上が「Issueを入れるとレビュー済みPRができる」「マージ前に人へ渡す」「65秒は再演」と答えれば構成を採用する。一つでも誤解が共通した場合は、映像を長くせず該当画面の見出しを直す。

## 今回はしないこと

- 安全ゲートを省いて実処理を90秒以内に収めること。
- 架空の成功画面だけを「ライブ実行」として見せること。
- 自動マージを標準デモへ含めること。
- Pi / Claude Code / Codex Workerを一つの映像で比較すること。
- App内の実験的経路を第一級対応のように見せること。
- 参加者の画面や非公開リポジトリを暗黙に使用すること。
- README、Slack、部会、Xごとに別の映像を制作すること。

## Wayfindingで確定した判断

- 最初の標準素材は、75秒前後の無音ターミナル映像とする。
- 実在する公開Issue / PRから4つの節目を取得し、待ち時間だけを除いた再演として表示する。
- 第一の訴求は「GitHub Issues in, reviewed PRs out.」、安全上の終点は`ready-for-human`とする。
- 素材はREADME、Slack、部会、Xで同一のものを使い、試験利用者募集または導入案内の文面だけを変える。
- 第三者完走が確認できるまでは、一般公開の成功事例ではなく試験利用者募集の素材として扱う。
