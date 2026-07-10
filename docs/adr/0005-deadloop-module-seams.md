---
status: accepted
---

# Use case workflows as deadloop's primary module seams

[deadloop coreと各アダプターの境界案を比較する](https://github.com/yasuhito/deadloop/issues/87) で、ユースケース別ワークフロー、純粋な状態遷移と型付き副作用、永続ジョブとリースによる調停の3案を比較した。deadloop はユースケース別の深いワークフローを主要なインターフェースとし、永続的な試行識別子や鮮度確認など、後二案の安全要素だけを具体的な失敗モードに応じて内部へ取り込む。汎用ワークフローエンジンや分散ジョブ基盤は、第二の実行経路で必要性を実証するまで導入しない。

## Module seams

### deadloop core

core は次のユースケースを公開する。

```ts
interface DeadloopWorkflows {
  coordinateIssue(project: ProjectId, invocation: HostInvocation): Promise<CoordinateIssueOutcome>;
  advanceImplementation(attempt: ImplementationAttemptId): Promise<ImplementationOutcome>;
  reviewPullRequest(project: ProjectId, invocation: HostInvocation): Promise<ReviewOutcome>;
  advanceReview(attempt: ReviewAttemptId): Promise<ReviewProgressOutcome>;
}
```

各ワークフローは、GitHub の観測、候補選定、安全ゲート、状態遷移、失敗時の補償を一つの深いモジュールにまとめる。GitHub の汎用 CRUD は公開せず、`claimForImplementation`、`mergeIfCurrent` のような目的別ポートを使う。設定読込、cron、Pi API、Herdr、CLI の argv、プロンプト搬送は core に含めない。

### Automation host

Automation host は時刻、定期実行、排他、設定の組み立て、試行状態の保存、再試行、停止通知、UI だけを担当する。Issue や PR の選定、レビュー可否、マージ可否は判断しない。

Pi 拡張を最初の host とする。将来の Node cron、Claude App、Codex App は同じワークフローを呼ぶ別の host であり、Pi の `sendUserMessage` 契約を模倣しない。App 内の定期実行は、管理された作業領域の再発見と回復を実証できるまで実験的対応とする。

### Execution runtime and launchers

ワークフローは worktree、tab、pane、CLI argv を認識しない。実装用とレビュー用の目的別 launcher を呼ぶ。

```ts
interface ImplementationLauncher {
  launch(request: ImplementationLaunchRequest): Promise<WorkerHandle>;
}

interface ReviewerLauncher {
  launch(request: ReviewerLaunchRequest): Promise<ReviewerHandle>;
}
```

launcher は execution runtime、agent program、試行成果物の保存先を組み合わせる。execution runtime は所有権付き workspace、session、観測、cleanup を担い、Herdr の workspace ID や tab は実装内部へ隠す。cleanup は試行の所有権と作業領域の状態を確認し、未知・dirty・未 push の作業を削除しない。

Agent 固有差分は葉の `AgentProgram` に閉じ込める。

```ts
interface AgentProgram {
  preflight(context: AgentLaunchContext): Promise<PreflightResult>;
  invocation(context: AgentLaunchContext): AgentInvocation;
  completionChannel(context: AgentLaunchContext): CompletionChannel;
}
```

Pi、Claude、Codex のコマンド、モデル・思考レベルの写像、権限、sandbox、プロンプト搬送、完了報告方法はここで変換する。promise file は Herdr のローカル実装で利用できるが、core の契約にはしない。

### Review policy

レビュー方針は、GitHub、CI、外部レビュー、レビューエージェント、ローカル検証から得た事実を受け取り、純粋な directive を返す。

```ts
type ReviewDirective =
  | { kind: "wait"; reasons: readonly string[] }
  | { kind: "request-external-review"; reviewers: readonly ExternalReviewer[] }
  | { kind: "launch-reviewer"; reason: string }
  | { kind: "block"; reasons: readonly string[] }
  | { kind: "handoff-human"; reasons: readonly string[] }
  | { kind: "merge"; expectedHeadSha: GitSha };
```

レビューエージェントの完了報告は証拠であり、マージ権限ではない。レビュー、検証、マージは同じ head SHA に結び付ける。`autoMerge: false` は必ず人へ引き渡す。マージ直前に head、draft、必須チェック、必要な承認、信頼済み方針を再取得し、変化していればマージせず再評価する。

## Minimum durability and safety

汎用 event/effect engine を導入しなくても、最初から次を契約に含める。

- Host invocation、implementation attempt、review attempt に決定的な識別子を持たせる。
- 外部副作用の前に試行意図を保存し、不明な失敗後は再観測してから再試行する。
- Issue の claim は期待ラベル、PR 操作は期待 head SHA を伴う。
- Agent 起動は同じ attempt ID で既存 session を発見できるようにする。
- 完了報告は attempt ID、対象 revision、状態、要約、検証結果を含む。
- GitHub コメントなど重複し得る副作用には決定的な marker を付ける。
- マージ capability は `autoMerge` が明示された構成だけへ渡す。

GitHub とローカル状態を跨ぐ完全な exactly-once は保証しない。競合、不明、部分成功を区別し、安全停止と再観測を優先する。

## Considered options

**Pure transition plus typed effects** は、再生可能性と単体試験に最も優れる。しかし、現時点では一つの reducer、effect interpreter、receipt journal の型と永続化を先に設計する負担が大きく、Pi + Herdr の具体的な改善を遅らせる。ワークフロー内部で複雑な回復が繰り返されると実証された場合に再検討する。

**Durable job and lease reconciler** は、再起動、重複 tick、複数 host に最も強い。しかし、現状の第一級経路は単一マシン上の Pi + Herdr であり、SQLite、lease、schema migration、共有 store を先に導入するのは過剰である。第二の独立 host、複数プロセス、または App 管理作業領域の回復が具体的に必要になった時点で再検討する。

## Consequences

最初の抽出対象は汎用 `RunnerAdapter` の拡張ではなく、現行 driver から `coordinateIssue` と `reviewPullRequest` を分離することである。次に監視を `advanceImplementation` と `advanceReview` へ移し、Pi + Herdr の launcher を組み立てる。その後、Codex または Claude の二つ目の `AgentProgram` で seam を検証する。

`src/herdr-runner.ts` の Herdr 応答正規化と、現行の純粋な Issue / PR 選定ロジックは再利用できる。一方、同期・非同期の二重 runner interface、暗黙の Herdr 生成、launcher subprocess の二重境界、標準経路での monitor prompt 依存は段階的に解消する。
