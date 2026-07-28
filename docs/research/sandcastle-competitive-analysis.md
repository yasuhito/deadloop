# Sandcastle 競合分析

- 調査日・GitHub メタデータ取得日: 2026-07-23
- Sandcastle 基準コミット: [`e99f832f26dc9d245c019a9ddd19fa5dee792427`](https://github.com/mattpocock/sandcastle/tree/e99f832f26dc9d245c019a9ddd19fa5dee792427)（v0.12.0）
- deadloop 基準コミット: [`3aaeb19c1146ab59835e5786436eb5a533339089`](https://github.com/yasuhito/deadloop/tree/3aaeb19c1146ab59835e5786436eb5a533339089)
- 比較対象: 公開 README、設計文書、ソース、package metadata、雛形、GitHub Issues / Releases / commit history

## 結論

Sandcastle は deadloop の完全な代替ではない。Sandcastle の中核商品は、**複数の coding agent と sandbox を TypeScript で組み合わせる実行ライブラリ**である。deadloop の中核商品は、**GitHub Issue を選び、PR を作り、CI・レビュー・競合・修正・マージを安全条件付きで進める運用ループ**である。重なるのは「coding agent を worktree で隔離して反復実行する」層であり、GitHub 上の状態機械と運用責任は同じ層にない。[Sandcastle README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L9-L24) [deadloop README](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/README.md)

競争上、deadloop は **agent・sandbox・セッション・雛形の幅、プログラム可能性、オンボーディング、公開採用、並列ワークフロー**で大きく負ける。一方、現時点の公開証拠に限れば、deadloop は **GitHub PR を中心とする fail-closed な状態遷移、既定で人間にマージを渡す運用、信頼済み base branch からの方針読込み、stale-head 防止、競合修復とレビュー修正の上限付き専用経路**で勝つ。ただし後者は「sandbox が強い」という意味ではなく、GitHub の副作用と状態遷移の安全性に限定した優位である。[deadloop internals](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/extensions/deadloop/README.md) [Sandcastle AgentProvider](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts)

戦略的には、deadloop は Sandcastle を「全部入り競合」として追随せず、**GitHub Issue → reviewed PR の安全な control plane**へ製品境界を固定すべきである。その上で runner seam を実働化し、将来 Sandcastle 型の sandbox provider を実行基盤として選べる可能性を残すのがよい。

## 調査方法と読み方

以下では各記述を区別する。

- **証拠**: commit 固定された README / source / package metadata に直接書かれていること。
- **推論**: 複数の証拠から導く競争上の評価。製品保証そのものではない。
- **報告**: GitHub Issue 投稿者の再現報告。コードで独立検証していないため、既知の確定不具合とは断定しない。
- **不明**: 公開一次資料で確認できないこと。

GitHub の star、fork、open issue、日時は commit に属さない可変メタデータなので、GitHub REST API の取得値と取得日を併記する。コード・文書の主張はすべて exact SHA の permalink に固定した。

## 現在規模と活動

2026-07-23 取得の GitHub repositories API は Sandcastle を **6,975 stars、708 forks、120 open issues、22 subscribers** と返した。リポジトリ作成日は 2026-03-17、`pushed_at` は 2026-06-29、`updated_at` は 2026-07-23 だった。[GitHub repositories API（2026-07-23取得）](https://api.github.com/repos/mattpocock/sandcastle)

同日の既定 branch 先頭は `e99f832…`（2026-06-29）で、package version は `0.12.0`、最新 release も v0.12.0（2026-06-29）だった。[main commit](https://github.com/mattpocock/sandcastle/commit/e99f832f26dc9d245c019a9ddd19fa5dee792427) [package.json](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/package.json) [release](https://github.com/mattpocock/sandcastle/releases/tag/v0.12.0)

一方、2026-07-21〜22 に第三者の Issue / PR 投稿が複数あり、main への push が約24日前でも利用者側の活動は継続していた。[Issues API（2026-07-23取得）](https://api.github.com/repos/mattpocock/sandcastle/issues?state=open&per_page=10&sort=updated&direction=desc)

比較として deadloop の GitHub API は同日 **0 stars、0 forks、31 open issues**、作成日 2026-07-04、`pushed_at` 2026-07-23 を返した。[deadloop GitHub API（2026-07-23取得）](https://api.github.com/repos/yasuhito/deadloop) deadloop の package は `0.1.0` で、v0 の Pi package / extension と明記されている。[package.json](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/package.json) [README](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/README.md)

**推論:** 採用・認知・外部フィードバック量は比較にならないほど Sandcastle が上である。ただし stars は導入数、継続利用、成功した agent run を測らない。また Sandcastle は公開から約3か月、deadloop は約3週間なので、同じ経過時間の比較でもない。

## 能力比較

| 観点 | Sandcastle | deadloop | 判定 |
|---|---|---|---|
| 主入力 | TypeScript の `run()` / `createSandbox()` / `createWorktree()` と任意 prompt | 特定ラベルを持つ GitHub Issue、レビュー対象 PR | 非同型 |
| coding agent | Claude Code、Codex、Pi、Cursor、OpenCode、Copilot の provider 実装 | v0 は Pi worker / reviewer を Herdr で起動 | Sandcastle 優位 |
| sandbox / runner | Docker、Podman、Vercel、no-sandbox。package export には Daytona もある。custom bind-mount / isolated provider を作成可能 | 既定 Herdr。runner interface と Herdr 実装の seam はあるが、公開文書上の代替 runner は将来構想 | Sandcastle 優位 |
| branch / worktree | `head`、`merge-to-head`、named `branch`。独立 worktree handle、再利用 sandbox、dirty worktree 保全 | Issue / PR branch を Herdr worktree で扱い、競合修復・review repair は既存 PR branch の限定経路 | 目的別 |
| prompt / output | inline/file、引数置換、sandbox 内 command expansion、structured output、schema retry、session resume/fork | automation prompt + 決定論的 driver + launch ごとの promise report | Sandcastle は汎用性、deadloop は限定性 |
| workflow template | blank、simple-loop、sequential-reviewer、parallel planner、parallel planner with review | issue coordinator と PR reviewer が標準。段階導入は coordination → review → optional merge | Sandcastle は種類、deadloop は GitHub 運用完成度 |
| GitHub lifecycle | 雛形 prompt / caller code が issue 選択・close・merge を実装。core の一級状態機械ではない | 適格ラベル、CI待機、draft、外部レビュー、blocked / human handoff、optional merge を driver が扱う | deadloop 優位（GitHub control plane のみ） |
| human gate | core に既定の PR human approval gate はない | `autoMerge:false` が既定推奨で、人間に merge を渡す | deadloop 優位 |
| observability | terminal / file logging、raw stream callback、iteration/session/usage/commits | Pi tabs、run artifacts、promise reports、`/deadloop-status`、`/deadloop-doctor` | 用途別。Sandcastle は API telemetry が広い |

根拠: Sandcastle の provider、agent、branch strategy、session、structured output は README と provider source に公開されている。[README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md) [AgentProvider.ts](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts) [package exports](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/package.json) deadloop の driver と runner 境界は internals と Herdr 文書に記録される。[internals](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/extensions/deadloop/README.md) [Herdr runner](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/docs/herdr-runner.md)

## 製品ポジショニング

### Sandcastle

**証拠:** README は「isolated sandboxes 内の AI coding agents を orchestrate する TypeScript library」と定義し、単一 `run()`、configurable branch strategy、commit の merge-back、provider-agnostic を最初に約束する。用途は parallel AFK agents、review pipelines、独自 orchestrator である。[README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L9-L24)

**証拠:** prompt 層は「workflow、task management、context source に意見を持たない」とし、caller が prompt と TypeScript orchestration を所有する。[README prompts](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L560-L578)

### deadloop

**証拠:** README は「GitHub Issues in, reviewed PRs out」を約束し、Issue の監視、実装、PR、review、merge を safety controls 付きで自動化すると置く。[README](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/README.md)

**推論:** Sandcastle は toolkit / substrate、deadloop は opinionated application / control plane である。利用者が自分で TypeScript workflow を書きたい場合、deadloop の固定フローは制約になる。GitHub の日常運用を構築せず使いたい場合、Sandcastle の自由度は導入負担になる。

## UX

### Sandcastle が優れる点

1. **scaffold が対話的かつ非対話にも対応する。** `init` で sandbox、agent、issue tracker、5種類の template を選び、必要ファイルと image を準備する。各 prompt に対応 flag がある。[README init](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md)
2. **最小 API が短い。** npm install → init → `.env` → `tsx .sandcastle/main.ts` の経路が README 冒頭にある。[README quick start](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L26-L64)
3. **高度な構成へ段階的に進める。** one-shot run、warm sandbox、worktree handle、interactive、resume/fork、structured output が同じ API family にある。[README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md)
4. **雛形が実行可能である。** sequential reviewer は issue ごとの named branch で implementer と reviewer を同じ sandbox に置く。parallel template は planning、branch ごとの並列実装・review、最後の merge をコードで見せる。[sequential template](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/sequential-reviewer/main.mts) [parallel template](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/parallel-planner-with-review/main.mts)

### deadloop が優れる点

1. **標準フローの選択が少ない。** target repo に `{}` の `deadloop.json` を commit し、既存 Git 情報から repo、base branch、worktree root を推論する。運用者は Pi を起動し、`/deadloop-doctor` と `/deadloop-status` を使う。[README](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/README.md)
2. **GitHub 上の状態が UI になる。** eligibility、in progress、review、blocked、human handoff がラベルで表現される。[README labels](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/README.md)

### deadloop の UX 上の敗北

**証拠:** deadloop は Pi、Herdr、`gh`、local working tree、GitHub write access を必要とする。[Herdr requirements](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/docs/herdr-runner.md) README の label 作成も利用者作業である。[README](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/README.md)

**推論:** deadloop の `{}` 設定は短いが、実際の前提は Sandcastle の npm + Docker quick start より専門的である。さらに Sandcastle の `init` のように agent / runtime / workflow を一度に案内する scaffold がなく、初回成功の視認性で負ける。

## アーキテクチャ

### Sandcastle

**証拠:** 中核 seam は `AgentProvider` と `SandboxProvider` である。sandbox は bind-mount と isolated を分け、agent provider は command build、stream parse、optional session storage を所有する。[CONTEXT](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/CONTEXT.md) [SandboxProvider.ts](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/SandboxProvider.ts) [AgentProvider.ts](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts)

**証拠:** bind-mount provider は host worktree を sandbox に mount し、isolated provider は sync-in / sync-out を行う。branch strategy は execution API に注入される。[README how it works](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L542-L565)

**証拠:** `createSandbox()` と `createWorktree()` は lifecycle handle を返し、dirty worktree を保存する。worktree から sandbox を作った場合は container と worktree の cleanup ownership を分離する。[README cleanup and ownership](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md)

### deadloop

**証拠:** GitHub state semantics と runner concerns を分け、Herdr が worktree、tab、Pi session、promise report、cleanup を担う。driver は candidate selection、CI / draft / external review gate、repair dispatch、限定 push path を担う。[internals](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/extensions/deadloop/README.md) [Herdr runner](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/docs/herdr-runner.md)

**推論:** Sandcastle は実行基盤 seam が製品の中心で、既に複数実装がある。deadloop は control-plane seam が明確だが、runner の差替えは設計意図に留まり、v0 の実働は Herdr 一つである。したがって「アーキテクチャ上は extensible」は同等でも、「実証済み extensibility」は Sandcastle が上である。

## 安全性

安全性は二つに分けないと誤る。

### 実行隔離では Sandcastle が上

**証拠:** Sandcastle は Docker / Podman の container、Vercel の isolated sandbox、custom isolated provider を一級概念にする。[README providers](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md) deadloop の公開 v0 runner 文書は Herdr worktree / tab / agent session を述べるが、container / VM sandbox を保証していない。[Herdr runner](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/docs/herdr-runner.md)

**留保:** Sandcastle の Docker / Podman は bind-mount で host worktree を直接書き、`head` は host working directory へ直接書く。`noSandbox()` は agent を host で動かす。したがって全 provider が同じ強度で隔離するわけではない。[README providers and strategies](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md)

### GitHub 副作用と PR 状態安全性では deadloop が上

1. **信頼境界。** repo policy は fetch 後の trusted `baseBranch` からのみ読み、review 中の PR branch を設定源にしない。[deadloop internals](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/extensions/deadloop/README.md)
2. **人間優先の既定。** `autoMerge:false` では PR 作成・review 後に merge を人間へ渡し、README は false から始めるよう求める。[deadloop README](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/README.md)
3. **stale head 防止。** repair と branch update は push 直前に PR head を再取得し、変化していれば push / label change を行わない。force push を許さない。[deadloop internals](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/extensions/deadloop/README.md)
4. **上限付き修復。** 同じ PR-head/base-head の競合更新は一度、review finding repair も一度に限定し、unsafe / repeated / human-required は `agent:blocked` に送る。[deadloop README](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/README.md)
5. **決定論的 gate。** candidate selection、CI pending、draft、external review、push finalize は prompt ではなく driver / helper が扱う。[deadloop internals](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/extensions/deadloop/README.md)

### Sandcastle の安全上のトレードオフ

**証拠:** AFK run の agent provider は permission bypass を標準経路に持つ。Claude Code は明示 permission mode がなければ `--dangerously-skip-permissions`、Codex は通常 `--dangerously-bypass-approvals-and-sandbox` を構築する。これは outer sandbox を主要境界とする設計である。[AgentProvider.ts](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts)

**証拠:** simple-loop は agent 完了後に temp branch を local HEAD へ merge する `merge-to-head` を使い、parallel template の最終 merge は agent prompt に委ねる。[simple-loop](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/simple-loop/main.mts) [parallel template](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/parallel-planner-with-review/main.mts)

**推論:** Sandcastle の sandbox は arbitrary code execution の blast radius を狭める。一方、branch merge、issue close、PR gate の安全契約は caller/template の品質に依存する。deadloop は逆に GitHub 操作を狭めるが、agent process の OS-level isolation は公開証拠上弱い。どちらか一方を「総合的に安全」とは評価できない。

### 公開 Issue から見える運用リスク（報告であり独立検証ではない）

- 同一 branch / worktree の並行利用、bind-mount path と git metadata、Windows、orphan worktree に関する報告がある。[#642](https://github.com/mattpocock/sandcastle/issues/642) [#849](https://github.com/mattpocock/sandcastle/issues/849) [#854](https://github.com/mattpocock/sandcastle/issues/854) [#855](https://github.com/mattpocock/sandcastle/issues/855) [#674](https://github.com/mattpocock/sandcastle/issues/674)
- v0.12.0 利用者から、noSandbox 並列時の global git config lock、isolated sandbox の uncommitted changes、createSandbox の agent env、Windows timeout が報告されている。[#919](https://github.com/mattpocock/sandcastle/issues/919) [#926](https://github.com/mattpocock/sandcastle/issues/926) [#925](https://github.com/mattpocock/sandcastle/issues/925) [#924](https://github.com/mattpocock/sandcastle/issues/924)

これらは成熟した利用者フィードバックの存在も示すが、本調査は再現実行していない。

## 拡張性

### Sandcastle の明確な優位

- agent provider が6系統実装され、command / stream parser / session storage を差し替えられる。[AgentProvider.ts](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts)
- sandbox provider は bind-mount / isolated factory を公開し、Docker、Podman、Vercel、no-sandbox の参照実装がある。package export は Daytona も公開する。[README custom providers](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md) [package.json](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/package.json)
- TypeScript が orchestration language なので planner、fan-out、review、merge、schema output を利用側で構成できる。[parallel template](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/parallel-planner-with-review/main.mts)
- session capture / resume / fork は provider capability として分離される。[ADR 0012](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0012-agent-provider-owned-session-storage.md) [ADR 0018](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr/0018-fork-is-session-only.md)

### deadloop の限定的な優位

**証拠:** runner concern と GitHub semantics を分離する方針、driver の `skip / done / needs_llm / error` contract がある。[deadloop internals](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/extensions/deadloop/README.md)

**推論:** これは将来 runner を交換する良い seam だが、複数 runner の公開実装や第三者 extension API は確認できない。現時点では「設計上の伸びしろ」であり、Sandcastle と同等の実績ではない。

## 運用モデル

### Sandcastle

- 基本は利用者が TypeScript script を起動する run-to-completion model である。one-shot、outer loop、`Promise.allSettled()` fan-out、CI 組込みは caller が決める。[README API](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md) [parallel template](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/parallel-planner-with-review/main.mts)
- GitHub Issue / Beads / custom tracker は `init` template の context source で、engine 自身が長期状態の唯一の所有者ではない。[README templates](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md)
- artifacts は `.sandcastle/worktrees`、logs、env、session files など host と provider の双方にある。[README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md)

### deadloop

- Pi extension 内の automations が GitHub を周期的に再取得し、eligible Issue / PR を選び、Herdr worker / reviewer を起動する。[deadloop internals](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/extensions/deadloop/README.md)
- GitHub labels / PR state が durable coordination plane で、local runtime state / locks / promise reports は `~/.pi/agent/deadloop` に置く。[deadloop internals](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/extensions/deadloop/README.md)
- merge / close 後の cleanup、review outcome の GitHub 永続化後の tab close など、運用 lifecycle を runner responsibility としている。[Herdr runner](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/docs/herdr-runner.md)

**推論:** Sandcastle は「実行部品をアプリへ埋め込む」、deadloop は「GitHub queue を見張る operator service」に近い。短い agent pipeline や CI library では Sandcastle、継続的な Issue/PR queue 管理では deadloop の形が自然である。

## deadloop が負けるところ

1. **採用と信頼シグナル:** 6,975 stars / 708 forks 対 0 / 0。外部 Issue / PR も Sandcastle に継続している。これは最大の差である。[Sandcastle API](https://api.github.com/repos/mattpocock/sandcastle) [deadloop API](https://api.github.com/repos/yasuhito/deadloop)
2. **agent の選択肢:** Sandcastle は少なくとも6 agent provider、deadloop v0 は Pi に固定される。[AgentProvider.ts](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts) [deadloop package](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/package.json)
3. **sandbox の選択肢と隔離:** Docker / Podman / Vercel / custom isolated が実働する Sandcastle に対し、deadloop の公開 runner は Herdr の local worktree / tab である。[Sandcastle README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md) [Herdr runner](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/docs/herdr-runner.md)
4. **組合せ能力:** warm sandbox、session resume/fork、schema output、custom provider、host/sandbox hooks、stream callback は deadloop の公開 API に同等物がない。[Sandcastle README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md)
5. **並列 UX:** planning と issue branch fan-out の雛形を初回 scaffold から選べる。deadloop の README は標準 issue coordinator / PR reviewer を示すが、同等の公開 parallel planner UX はない。[parallel template](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/parallel-planner-with-review/main.mts) [deadloop README](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/README.md)
6. **配布物の完成度:** Sandcastle は versioned npm CLI/library、exports、release / changelog を持つ。deadloop は v0.1.0 Pi package で GitHub release は確認できない。[Sandcastle package](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/package.json) [CHANGELOG](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/CHANGELOG.md) [deadloop package](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/package.json)
7. **学習面:** Sandcastle README は巨大だが API、template、provider contract、hooks、session を一か所で説明する。deadloop の公開 README は運用に集中し、extension author 向け API は未成熟である。

## deadloop が勝つところ（公開証拠がある範囲のみ）

1. **PR safety の製品内蔵:** CI pending、draft、external review gate、stale head、bounded conflict repair、bounded review repair、blocked handoff が deterministic driver の責務として列挙される。Sandcastle core の README / API に同じ GitHub PR state machine はない。[deadloop internals](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/extensions/deadloop/README.md) [Sandcastle README](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md)
2. **安全な既定の merge policy:** deadloop は `autoMerge:false` から始めるよう明示し、人間へ handoff する。Sandcastle の simple-loop は `merge-to-head` を採用し、core に PR human approval gate はない。[deadloop README](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/README.md) [simple-loop](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/simple-loop/main.mts)
3. **設定の trust boundary:** deadloop は repo policy を trusted base branch から読む。Sandcastle の caller-owned `.sandcastle` script / prompt は柔軟だが、PR review 時に base branch の設定だけを信頼する同等 contract は README にない。[deadloop internals](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/extensions/deadloop/README.md)
4. **Worker の GitHub 権限を狭める責務分離:** repair finalizer / branch-update finalizer が唯一の push path で、worker 自身は force push や label change をしない。[deadloop internals](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/extensions/deadloop/README.md)
5. **GitHub queue の運用者 UX:** eligibility と状態が labels、復旧が `agent:blocked`、merge handoff が `ready-for-human` として共有 UI に残る。[deadloop README](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/README.md)

これらは「deadloop のコードに不具合がない」「実運用で Sandcastle より高信頼」と証明するものではない。公開された設計・実装責務の比較である。

## apples-to-apples でないところ

1. **library vs application:** `sandcastle.run()` と `/deadloop-status` を同列の UX とみなせない。
2. **sandbox safety vs workflow safety:** container / VM isolation と GitHub stale-head / merge gate は別の脅威モデルである。
3. **local merge vs GitHub auto-merge:** Sandcastle の `merge-to-head` は local HEAD への git merge、deadloop の `autoMerge` は reviewed PR の GitHub squash merge である。
4. **iteration vs issue lifecycle:** Sandcastle の `maxIterations` は agent invocation の上限、deadloop の cycle は GitHub 状態を再取得する運用周期である。
5. **review agent vs PR review state:** Sandcastle template の reviewer は同じ sandbox / branch で修正可能な処理段、deadloop reviewer は GitHub PR 状態と CI / external review gate の後段にある。
6. **adoption age:** Sandcastle は約3か月、deadloop は約3週間。絶対 stars と issue 数は製品年齢、作者の配布力、対象市場にも影響される。
7. **自由度と完成度:** Sandcastle で GitHub-safe loop を実装できることと、それが library に標準保証されることは違う。deadloop で他 agent / sandbox を将来接続できる設計と、現に利用できることも違う。

## 戦略的提言

### 1. 競争軸を「agent orchestrator」から外す

`provider-agnostic orchestration`、多数 agent、sandbox API、session resume を短期に追うと、Sandcastle の既存優位へ正面衝突する。deadloop の一文は **“GitHub Issues in, reviewed PRs out — with fail-closed PR operations”** に寄せ、比較表も GitHub queue、CI、review、stale head、human handoff を中心にする。

### 2. deadloop の勝ち筋を実行可能な安全契約として増やす

現在の勝ち筋は文書と driver 責務にはある。これを Cucumber の外部観測可能な仕様へ移し、少なくとも stale head、trusted base policy、one-attempt repair、`autoMerge:false` handoff、force-push rejection を公開 evidence にする。既に acceptance foundation が package / CI に組み込まれている。[deadloop package](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/package.json) [acceptance feature](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/acceptance/features/project-check-safety.feature.md)

### 3. runner seam を「将来」から実証へ進める

第二 runner 全体を作る前に、runner contract test を作り、Herdr implementation が通ることを示す。その後、container-backed worker の小さな proof を行う。Sandcastle を dependency にするか、provider contract だけ参考にするかは別 ADR で決める。GitHub semantics を runner へ漏らさない現方針は維持する。[deadloop Herdr boundary](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/docs/herdr-runner.md)

### 4. onboarding の差を最優先で縮める

新機能より、`/deadloop-doctor` から label 作成、権限、Herdr、repo policy、試験 Issue までを一つの guided setup にする。Sandcastle の `init` と同じ自由度は不要だが、**first reviewed PR までの一本道**は必要である。

### 5. 「Sandcastle を下回る sandbox」を隠さない

README の safety controls は GitHub operation safety だと明記し、OS-level sandbox を意味しないと説明する。runner ごとの isolation profile を公開し、Herdr local execution、将来 container runner の違いを示す。これは競合比較上の弱点だが、曖昧にするより trust を得やすい。

## 残余リスクと不明点

- Sandcastle を clone して test / example を実行していない。provider ごとの実働、Windows、parallel worktree、isolated sync の評価は source review と Issue 報告に限る。
- GitHub API の stars / issue / activity は 2026-07-23 時点のスナップショットであり変動する。
- npm download 数、dependents、実行成功数、継続利用率は確認していない。stars から adoption を推定できない。
- Sandcastle の README と package exports には provider 表記差がある。README は Docker / Podman / Vercel / no-sandbox を主に説明し、package は Daytona export も持つ。Daytona の公開成熟度は評価していない。[package.json](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/package.json)
- deadloop の安全上の優位は code path の動的検証ではなく、commit 固定 source / docs の責務比較である。競合向けに主張する前に end-to-end acceptance evidence が必要である。
- Sandcastle の第三者 Issue は報告者環境の情報で、再現・修正状況が変わり得る。確定仕様の根拠には用いていない。
- cost control、secret exfiltration、network egress、container escape、GitHub token scope の実測比較は行っていない。

## 主な一次資料

### 採用

- [Sandcastle README at e99f832](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md) — positioning、API、UX、provider、branch、session、hooks
- [Sandcastle package.json at e99f832](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/package.json) — version、exports、CLI、package metadata
- [Sandcastle AgentProvider.ts at e99f832](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/AgentProvider.ts) — agent provider、permission flags、session contract
- [Sandcastle templates at e99f832](https://github.com/mattpocock/sandcastle/tree/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates) — concrete workflow behavior
- [Sandcastle ADRs at e99f832](https://github.com/mattpocock/sandcastle/tree/e99f832f26dc9d245c019a9ddd19fa5dee792427/docs/adr) — lifecycle / session / locking decisions
- [Sandcastle GitHub repository API](https://api.github.com/repos/mattpocock/sandcastle) — 2026-07-23 の stars / forks / dates
- [deadloop README at 3aaeb19](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/README.md) — product promise、labels、safety、rollout
- [deadloop internals at 3aaeb19](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/extensions/deadloop/README.md) — driver、trusted policy、push finalizer、runner boundary
- [deadloop Herdr runner at 3aaeb19](https://github.com/yasuhito/deadloop/blob/3aaeb19c1146ab59835e5786436eb5a533339089/docs/herdr-runner.md) — operational requirements and responsibilities

### 除外・限定利用

- Web 検索の要約・第三者 SEO 比較 — commit 固定の一次資料ではないため根拠から除外。
- OSSInsight / star-history 系サイト — GitHub first-party API が取得できたため除外。
- Sandcastle GitHub Issues — runtime field reports としてのみ使用し、実装事実・保証の根拠には不使用。
- local 未コミット状態 — GitHub の exact SHA と一致を確認できる公開資料を比較基準にし、変動する worktree state は根拠にしなかった。

## 端的な推奨

**deadloop は Sandcastle の agent/sandbox toolkit を追わず、GitHub Issue-to-reviewed-PR の fail-closed control plane に集中する。** 次の投資順は、(1) stale-head / trusted-policy / human-handoff の E2E acceptance evidence、(2) guided setup、(3) runner contract test、(4) container-backed second runner の小規模実証、である。最大の残余リスクは、deadloop の安全優位がまだ第三者運用と比較実験で裏付けられておらず、Sandcastle の圧倒的な採用・拡張性差を埋めるだけの配布・オンボーディング証拠がないことである。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "指定された成果物 research.md のみを作成し、Sandcastle と deadloop の能力、位置付け、UX、アーキテクチャ、安全性、拡張性、成熟度、運用モデルを比較した。"
    },
    {
      "id": "criterion-2",
      "status": "satisfied",
      "evidence": "コード・文書の主張は exact commit SHA の GitHub permalink に固定し、可変メタデータは GitHub first-party API と取得日を併記した。証拠・推論・報告・不明を区別し、一次資料一覧と残余リスクを記載した。"
    }
  ],
  "changedFiles": [
    "/home/yasuhito/Work/deadloop/.pi-subagents/artifacts/outputs/2727b708-ee1a-47da-9612-0b368515ce75/research.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "GitHub REST API / repository source research via web tools",
      "result": "passed",
      "summary": "Sandcastle / deadloop の repository metadata、main commit、release、issues、source tree と固定 SHA の一次資料を取得した。"
    },
    {
      "command": "npm test / lint / typecheck",
      "result": "not-run",
      "summary": "リポジトリ実装を変更せず、成果物 Markdown のみを作成したため実行対象外。"
    }
  ],
  "validationOutput": [
    "Sandcastle main SHA: e99f832f26dc9d245c019a9ddd19fa5dee792427; package/release: v0.12.0.",
    "deadloop main SHA: 3aaeb19c1146ab59835e5786436eb5a533339089.",
    "GitHub API snapshot 2026-07-23: Sandcastle 6,975 stars / 708 forks / 120 open issues; deadloop 0 stars / 0 forks / 31 open issues.",
    "成果物以外のプロジェクトファイルは編集していない。"
  ],
  "residualRisks": [
    "Sandcastle を clone / test 実行しておらず、runtime behavior と公開 Issue の再現確認は未実施。",
    "star / issue / activity metadata は取得後に変動する。",
    "no-staged-files は git status を実行できるツールがないためコマンドで再確認していない。ただし repository file の編集・stage 操作は行っていない。"
  ],
  "noStagedFiles": true,
  "diffSummary": "競合分析の日本語調査文書を runtime 指定成果物へ新規作成。リポジトリ本体への変更なし。",
  "reviewFindings": [
    "no blockers",
    "review note: 実行時検証ではなく一次資料の静的比較であることを本文と残余リスクに明記した。"
  ],
  "manualNotes": "ユーザー文中の docs/research 出力指定は runtime output path override により適用せず、authoritative path の research.md のみを書いた。"
}
```
