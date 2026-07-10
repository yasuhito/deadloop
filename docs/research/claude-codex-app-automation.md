# Claude App / Codex App の自動化経路調査

- 調査日: 2026-07-10
- 問い: [Claude AppとCodex Appで成立する自動化経路を確認する](https://github.com/yasuhito/deadloop/issues/84)
- 対象: Anthropic と OpenAI の現行公式資料、および deadloop の現行境界

## 結論

Claude Desktop と ChatGPT desktop app の Codex は、どちらも **定期起動・隔離 worktree・無人のエージェント実行・結果表示**までを画面内で提供している。したがって、1回の定期セッション自身が deadloop core を呼び、1件だけ処理する試験経路を設計できる。ただし現行 deadloop には、そのための決定論的な一回実行入口がまだない。以下の App 内経路は、その入口を新設してから実機で検証する仮説であり、現在利用できる機能ではない。

ただし、両 App の定期実行は「決められたコマンドを直接起動するスケジューラ」ではなく、新しいエージェントセッションを起動する機能である。定期タスクや App 管理 worktree を外部プログラムが create / list / inspect / resume / remove する公開契約も一式では揃わない。このため、画面の完了通知やセッション状態を deadloop の `promise` に置き換え、App をそのまま第一級 runner とするのは早い。

最小の推奨順序は次のとおりである。

1. **今すぐ保証する経路**: Pi + Herdr を自動化ホスト兼 runner とし、既存の `workerAgent: "claude"` による Claude Code Worker に加えて `codex exec` Worker を小さく追加する。worktree、GitHub 状態、安全ゲート、`promise`、回収の所有者は変えない。[Claude agent support ADR](../adr/0002-agent-level-claude-support.md)
2. **実験的な App 内経路**: まず、候補選定から再照合までをLLM判断なしに1回だけ実行する deadloop コマンドを新設する。その後、各 App の定期タスクを隔離 worktree で動かし、固定した指示からそのコマンドだけを呼ぶ。`autoMerge: false` とし、画面通知ではなく GitHub と構造化結果を次回起動時に再照合する。二重 dispatch を避けるため、同じリポジトリで Pi の定期実行と併用しない。
3. **第一級 App 対応の候補**: Claude はローカル `claude -p`、Codex は `codex app-server` または Codex SDK をプログラムから制御し、deadloop 自身がスケジューラと worktree を所有する。これは公式のエージェント実行面を使うが、App の画面スケジューラだけで完結する経路ではない。
4. **クラウド runner は保留**: Claude Code Routines と Codex cloud は隔離実行には十分だが、起動から意味的完了、成果物回収、再開、workspace 回収までを deadloop が検証できる公開契約が不足する。

この結論は、当初の「Claude App内」「Codex App内」を直ちに第一級対応にする想定を狭める。90日内には **実験的経路として検証し、第一級対応は受入契約を満たしたものだけにする**のが安全である。

## 判定基準

ここでいう App 対応を、次の7能力へ分けた。

1. 定期起動
2. GitHub 認証と Issue / PR 操作
3. 隔離された作業場所
4. Worker の起動
5. 完了の検出
6. 同じ作業の再開
7. セッションと作業場所の回収

「通知が届いた」「最終回答が表示された」「プロセスが終了した」は、deadloop における意味的完了ではない。現行の `promise` は、起動ごとの専用パスに Worker が書く `complete | blocked` の構造化報告であり、セッションファイルや画面出力を完了判定に使わない。[deadloop CONTEXT](https://github.com/yasuhito/deadloop/blob/48ce2237d7eb0ad9dad5c7b82f9b2733ef15e81b/CONTEXT.md#L35-L41)

## Claude App / Claude Code

### ローカルの Claude Desktop 定期タスク

Claude Desktop の local scheduled task は、App の **Routines** から作成し、指定したローカルフォルダで新しいセッションを起動する。1分単位の予定、手動実行、タスクごとのモデル・権限モード、隔離 worktree を選べる。セッションは通常の Claude Code と同様に、ファイル編集、コマンド実行、commit、PR 作成ができる。[Desktop scheduled tasks](https://docs.anthropic.com/en/docs/claude-code/desktop-scheduled-tasks)

制約は明確である。

- App が開き、コンピュータが起きている間だけ起動する。スリープ中の予定は飛ばされ、復帰時は過去7日で最後に逃した1回だけを補う。
- Ask mode で未承認の操作が必要になると、利用者が承認するまで停止する。無人実行では許可を事前に狭く固定する必要がある。
- 過去実行は App の履歴で確認する。タスク削除は生成セッションを archive する。確認画面の **Also delete files on disk** を選んだ場合は、`~/.claude/scheduled-tasks/<task-name>/SKILL.md` と関連データも削除する。
- 公式資料は App 画面と会話からの作成・編集・停止を説明するが、外部プログラムが定期タスクの状態を取得し、実行を claim し、完了を購読する API は示していない。

CLI 側には、別の Worker を非対話で起動する `claude -p`、JSON / stream-json、JSON Schema 出力、セッション ID、`--resume` がある。この経路はプロセス終了と構造化出力をプログラムで観測できる。[Programmatic mode](https://docs.anthropic.com/en/docs/claude-code/headless) worktree も `claude --worktree` で作成できるが、非対話実行の worktree は自動回収されないため、所有者が `git worktree remove` を行う必要がある。[Claude Code worktrees](https://docs.anthropic.com/en/docs/claude-code/worktrees)

したがってローカルでは、**Desktop の定期セッション自身を Worker とみなす簡易経路**と、**外部スケジューラが `claude -p` を Worker として管理する経路**を分けるべきである。後者は deadloop の runner 契約に近い。

### Claude Code Routines / Code on the web

Claude Code Routines は Anthropic 管理環境で動き、定期予定、専用 bearer token への HTTP POST、GitHub の PR / release event から新しいクラウドセッションを起動できる。定期予定の最短間隔は1時間で、API 起動は session ID と URL を返す。GitHub event ごとのセッション再利用はなく、各 event が独立したセッションになる。[Claude Code Routines](https://docs.anthropic.com/en/docs/claude-code/routines)

各 run はリポジトリを新しく clone する。GitHub App または `/web-setup` で GitHub を認証し、既定では `claude/` 接頭辞の branch だけへ push できる。クラウドセッションは隔離 VM で動き、GitHub credential は VM に直接渡さず proxy が扱う。[Claude Code on the web](https://docs.anthropic.com/en/docs/claude-code/claude-code-on-the-web)

一方、Routine の公開 API 資料で確認できる起動結果は session ID と URL までである。同じ API 面に、run の status / result polling、完了 webhook、cancel、workspace list / remove は記載されていない。run は画面から開いて継続できるが、GitHub event 由来の複数 run は同一セッションへ合流しない。よって Routine は **自律した1回の処理**には向くが、外側の deadloop core が Worker handle と workspace handle を所有する runner にはまだ足りない。

なお、通常の Claude Chat にある GitHub integration は、特定 branch のファイル名と内容を同期する機能であり、commit history、PR、その他 metadata を取得しない。Claude Code の GitHub 認証とは別物である。[Claude GitHub integration](https://support.claude.com/en/articles/10167454-use-the-github-integration)

### Claude の能力表

| 能力 | Desktop local scheduled task | Code Routines / web | deadloop からの評価 |
|---|---|---|---|
| 定期起動 | あり。App と端末の稼働が必要 | あり。schedule / API / GitHub event | 起動自体は十分 |
| GitHub | ローカルの git / `gh` を利用可能 | GitHub App または同期した `gh` token | core 以外に label / merge を委ねない |
| 隔離 | App で worktree を選択可能 | run ごとの隔離 VM と fresh clone | cloud の workspace handle は非公開 |
| Worker 起動 | scheduled session、または `claude -p` | Routine fire または `claude --cloud` | local CLI が最も制御しやすい |
| 完了検出 | App 通知。CLI は exit と JSON | 人向け session。公開 polling API は未確認 | `promise` を維持する |
| 再開 | App 履歴、CLI `--resume` | 画面から継続、CLI `--teleport` | GitHub event run は毎回独立 |
| 回収 | App 履歴と手動削除。CLI worktree は所有者が回収 | session archive / delete は画面操作 | 外部から workspace 回収を検証できない |

利用条件にも注意が要る。Routines は Pro / Max / Team / Enterprise で Claude Code on the web が有効な場合に使え、組織管理者が無効化できる。claude.ai の subscription login が必要で、Console API key や Bedrock / Vertex 認証の CLI では `/schedule` を作れない。run 数と subscription usage にも上限がある。[Routines: usage and troubleshooting](https://docs.anthropic.com/en/docs/claude-code/routines#usage-and-limits)

## Codex App / Codex

### ChatGPT desktop app の scheduled tasks と worktree

Codex の scheduled task は、独立した run を毎回作る方式と、既存 task の文脈へ定期的に戻る方式を持つ。独立 run は複数 project と custom RRULE に対応し、結果は **Scheduled** の inbox に入る。既存 task の定期実行は、長い処理や PR の状態を同じ文脈で追う用途を公式に想定している。[Codex scheduled tasks](https://developers.openai.com/codex/app/automations)

ローカル project を使う場合、端末と ChatGPT desktop app の稼働が必要である。Git リポジトリでは local checkout または専用 background worktree を選べる。無人実行では、組織方針が許せば `approval_policy = "never"` を使い、通常の sandbox 設定に従う。公式資料は full access を避け、必要最小限の `workspace-write` と rule を推奨する。[Codex scheduled tasks: permissions](https://developers.openai.com/codex/app/automations)

App 管理 worktree は `$CODEX_HOME/worktrees` に detached HEAD で作られ、task ごとに同じ worktree を再利用する。既定では最近の15件を保持し、task の archive または保持上限超過で削除する。削除前に snapshot を保存し、再び task を開いたときに復元できる。実行中、pin 済み、permanent の worktree は自動削除しない。[Codex worktrees](https://developers.openai.com/codex/app/worktrees)

GitHub PR の情報を App に表示するには、ローカルに `gh` を入れ、`gh auth login` を済ませる必要がある。App は PR branch 上で PR の文脈、review comment、変更ファイルを表示できる。[Codex App code review](https://developers.openai.com/codex/app/review)

これらは人が App から扱うには十分だが、scheduled task と App 管理 worktree を外部プログラムが claim / list / remove する API は公式資料に示されていない。頻繁な予定は worktree を増やすため、公式の troubleshooting も不要 run の archive を勧めている。[Codex App troubleshooting](https://developers.openai.com/codex/app/troubleshooting)

### `codex exec` と `codex app-server`

ローカル Worker には、App の画面状態より安定した公式面が二つある。

- `codex exec` は CI や予定処理向けの非対話実行で、明示した sandbox、JSONL event、exit、JSON Schema、session ID、`codex exec resume` を提供する。既定は read-only であり、書き込みには `--sandbox workspace-write` を明示する。[Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- `codex app-server` は Codex の rich client 向け JSON-RPC 2.0 面である。安定した stdio transport から `thread/start`、`turn/start`、`turn/completed`、`thread/read`、`thread/resume`、`thread/archive`、`thread/delete` を扱える。`turn/completed` は `completed | interrupted | failed` と error を返し、thread status と item event も購読できる。WebSocket transport と background terminal cleanup は実験的なので、第一段階では使わない。[Codex app-server](https://developers.openai.com/codex/app-server)

app-server は thread / turn のライフサイクルを満たすが、ChatGPT desktop app の scheduled task や managed worktree を操作する API ではない。OpenAI も、独自製品への深い統合には app-server、job や CI の自動化には Codex SDK を使うよう案内する。したがって deadloop adapter は、**deadloop が git worktree を所有し、その中で app-server / SDK / `codex exec` のいずれかを起動する**形にすればよい。App の worktree と二重に所有してはならない。

### Codex cloud

Codex cloud は task ごとに隔離 container を作り、選んだ branch または commit SHA を checkout し、setup script の後にエージェントを実行する。完了時には回答と diff を表示し、PR 作成または follow-up ができる。agent phase の internet access は既定で無効で、container cache は最大12時間である。[Codex cloud environments](https://developers.openai.com/codex/cloud/environments)

`codex cloud exec`、task 一覧、差分の取得と適用は公式 CLI にあるため、起動と観測は Claude Routines よりプログラムに近い。[Codex CLI reference](https://developers.openai.com/codex/cli/reference.md) それでも、公開資料から cloud task の意味的結果を `promise` として安全に取得する契約、同一 task の自動再開、workspace の明示回収を一式で確認できない。cloud の内部 lifecycle を deadloop の所有権とみなさず、当面は調査対象に留める。

### Codex の能力表

| 能力 | ChatGPT desktop app local | `codex exec` / app-server / SDK | Codex cloud | deadloop からの評価 |
|---|---|---|---|---|
| 定期起動 | あり。App と端末の稼働が必要 | 外部 scheduler が必要 | 外部 scheduler から `codex cloud exec` を呼べる | App scheduler の API は未確認 |
| GitHub | local git と認証済み `gh` | 呼び出し環境の git / `gh` | 接続した GitHub repository | core だけが Issue / label / merge を行う |
| 隔離 | task ごとの managed worktree | deadloop 所有 worktree + sandbox | task ごとの隔離 container | 所有者を一つにすれば local は適合 |
| Worker 起動 | scheduled / manual task | `codex exec`、app-server `thread/start` / `turn/start` | `codex cloud exec` | local adapter が最小 |
| 完了検出 | inbox と通知 | JSONL / exit、app-server `turn/completed` | task status、回答、diff | いずれも `promise` と再照合する |
| 再開 | 同じ task / worktree、Handoff | `codex exec resume`、`thread/resume` | 画面の follow-up。自動再開契約は未確認 | local のプログラム面は十分 |
| 回収 | archive と保持上限で snapshot 後に削除 | `thread/archive` / `thread/delete`、git worktree remove | workspace の明示回収 API は未確認 | app-server は App worktree を回収しない |

## deadloop へ引き渡す判断

### 現行境界を維持する

- **deadloop core** が候補選定、GitHub Issue / PR 状態、安全ゲート、再試行、merge 可否を所有する。
- **runner** が worktree とエージェントのライフサイクルを所有する。現行 `RunnerAdapter` は create / open / list / remove worktree と start / list agent を要求する。[RunnerAdapter](https://github.com/yasuhito/deadloop/blob/48ce2237d7eb0ad9dad5c7b82f9b2733ef15e81b/src/runner.ts#L1-L52)
- **`promise`** だけを意味的完了の権威とし、App 通知、session summary、process exit、PR 作成は観測情報に留める。
- worktree は App と deadloop のどちらか一方だけが所有する。dirty / unpushed / uncommitted の可能性がある作業場所は自動破棄せず、場所と復旧方法を報告する。

これは先行調査で採用した、単一権威による再照合、runner handle の所有権、dirty 状態の保全、画面やセッションに依存しない完了判定とも一致する。[Symphony / Sandcastle 調査](./symphony-sandcastle-loop-design.md)

### downstream ticket への事実

- [deadloop coreと各アダプターの境界案を比較する](https://github.com/yasuhito/deadloop/issues/87): 自動化ホスト、workspace 所有者、agent lifecycle、現在のセッション自身が作業するか別 Worker を起動するかを別能力にする。App 内経路には、現在の `RunnerAdapter` と異なる **single-session host** の形が必要である。
- [deadloopの抽象化契約を確定する](https://github.com/yasuhito/deadloop/issues/88): scheduler / workspace / agent session / completion / cleanup を一枚の runner 名で暗黙に束ねず、能力と所有権を明示する。ただし GitHub 状態と安全ゲートは core から出さない。
- [推奨経路と第一級対応の受入契約を確定する](https://github.com/yasuhito/deadloop/issues/89): App 内経路は、第三者が予定起動、権限停止、`promise` 欠落、dirty worktree、App 再起動、重複起動から復旧できるまで実験的対応とする。
- ローカル Codex Worker の追加は既存のエージェントプロファイル境界に収まり、App / cloud adapter より先に検証できる。`codex exec` の認証、sandbox、JSONL、timeout、kill 後の作業保全、専用 `promise` パスへの書き込みをプロトタイプで確認する。

## 不足能力と検証項目

### 第一級 App 内経路に不足するもの

1. 定期タスクを LLM 判断なしに決められたコマンドとして起動する契約。
2. 外部プログラムによる scheduled run の claim、status、cancel、結果取得。
3. App 管理 worktree の create / list / dirty 判定 / remove を一貫して確認する契約。
4. App の通知や task 完了を `promise` へ安全に写像する規則。
5. App 再起動、sleep、権限待ち、利用上限、重複予定に対する再照合。

### read-only prototype で確認するもの

- Claude Desktop と ChatGPT desktop app で、隔離 worktree の定期タスクを1回実行し、sleep / App 再起動 / permission wait / missed run の表示を記録する。
- 同じリポジトリに対する2回の予定が重なった場合に、後続が skip、queue、並行のどれになるかを確認する。
- `claude -p` と `codex exec --json` を既存 Herdr worktree 内で実行し、構造化 `promise`、timeout、resume、dirty worktree 保全を確認する。
- `codex app-server` は stable stdio の thread / turn API だけを対象にし、実験的 WebSocket と process / background terminal API は使わない。
- すべて `autoMerge: false` のテスト用リポジトリで行い、App の GitHub identity には label、Issue close、merge、head branch delete を任せない。

## 一次資料

### Anthropic

- [Schedule recurring tasks in Claude Code Desktop](https://docs.anthropic.com/en/docs/claude-code/desktop-scheduled-tasks)
- [Automate work with routines](https://docs.anthropic.com/en/docs/claude-code/routines)
- [Use Claude Code on the web](https://docs.anthropic.com/en/docs/claude-code/claude-code-on-the-web)
- [Run Claude Code programmatically](https://docs.anthropic.com/en/docs/claude-code/headless)
- [Run parallel sessions with worktrees](https://docs.anthropic.com/en/docs/claude-code/worktrees)
- [Claude Code GitHub Actions](https://docs.anthropic.com/en/docs/claude-code/github-actions)
- [Use the GitHub integration](https://support.claude.com/en/articles/10167454-use-the-github-integration)

### OpenAI

- [Scheduled tasks](https://developers.openai.com/codex/app/automations)
- [Worktrees](https://developers.openai.com/codex/app/worktrees)
- [Code review in the app](https://developers.openai.com/codex/app/review)
- [Codex app troubleshooting](https://developers.openai.com/codex/app/troubleshooting)
- [Non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex app-server](https://developers.openai.com/codex/app-server)
- [Cloud environments](https://developers.openai.com/codex/cloud/environments)
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference.md)

## 限界

- App、CLI、クラウドは同じ製品名でも release cadence が異なり、CLI にある機能が App bundle にまだない場合がある。Codex 公式 troubleshooting もこの差を明記する。
- plan、OS、組織方針、段階的な公開により利用可否が異なる。公式資料の存在だけで対象アカウントに有効とはみなさない。
- 「API がない」とは断定していない。2026-07-10 時点の公開一次資料で、deadloop が依存できる契約を確認できない部分を不足としている。
- 本文は設計調査であり、App の実機 prototype、runner 実装、設定 schema 変更は行っていない。
