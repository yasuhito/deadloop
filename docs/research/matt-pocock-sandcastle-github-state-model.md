# Matt Pocock Sandcastle の GitHub 状態モデル調査

- 調査日: 2026-08-26
- 対象: [`mattpocock/sandcastle`](https://github.com/mattpocock/sandcastle/tree/e99f832f26dc9d245c019a9ddd19fa5dee792427) の dogfood workflow（`.github/workflows/` の agent 系ファイル）
- 問い: [deadloop issue #238](https://github.com/yasuhito/deadloop/issues/238)
- 関連: [`symphony-sandcastle-loop-design.md`](symphony-sandcastle-loop-design.md)（ライブラリ本体と Symphony との比較）、[ADR 0032](../adr/0032-github-is-the-workflow-state-source-of-truth.md)

## エグゼクティブサマリー

Sandcastle リポジトリ自身の運用（dogfood）は、ライブラリの sandbox 機構ではなく、GitHub Actions 上で「ラベル付けイベントを一度だけ消費し、作業中と停止をラベルで表す」方式で回っている。要求は `agent:explore` / `agent:implement` / `agent:review` / `agent:update-branch` の付与イベントであり、ワークフロー起動時に要求ラベルを削除して消費し、`agent:blocked` を外してから `agent:in-progress` を付ける。失敗時は `agent:blocked` を付け、「Re-add `agent:<role>` to retry.」というコメントとともに終わり、再試行は同じ要求ラベルの再付与だけで表現される。同一対象の直列化は GitHub Actions の `concurrency` グループで行い、ローカル出力は GitHub への反映まで共有状態にならない。deadloop はこの状態モデルを既定として採用する。ただし、force push、エージェント実行への検証委任、CI concurrency への排他委任、単一環境前提は採用しない。

## 1. 調査の読み方

対象は Sandcastle リポジトリが自分の開発に使っている workflow ファイル群である。ライブラリ API（`run()`、sandbox provider、branch strategy）ではなく「GitHub の何を状態として読み書きしているか」だけを記録する。引用はすべて commit `e99f832f26dc9d245c019a9ddd19fa5dee792427` に固定した一次資料である。

## 2. ラベル語彙

dogfood workflow が読み書きするラベルは次の 3 群に分かれる。

**Agent request labels（要求・一回限りのイベント）**

- `agent:explore` — Issue の実装前調査（[agent-explore.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-explore.yml#L9)）
- `agent:implement` — Issue 実装（[agent-implement.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement.yml#L10)）と PR 実装・修復（[agent-implement-pr.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement-pr.yml#L10)）
- `agent:review` — PR レビュー（[agent-review.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-review.yml#L7)）
- `agent:update-branch` — マージ競合時のブランチ更新（[agent-update-branch.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-update-branch.yml#L25-L26)）

トリガーはすべて `types: [labeled]` 付きの `issues:` / `pull_request_target:` イベントであり（例: [agent-review.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-review.yml#L4-L5)）、要求は「そのラベルが付いた瞬間のイベント」を一単位とする。要求ラベルは作業中や所有権を表さない。

**Current-state labels（現在状態）**

- `agent:in-progress`
- `agent:blocked`

`agent:reviewing` のような中間状態は存在しない。要求ラベルと現在状態ラベルの併存もない。1 つの対象が持つのは、待機中の要求イベントか、現在状態か、停止かである。

## 3. 要求の消費パターン

全ワークフロー共通の最初のステップは、要求ラベルの削除による消費と現在状態への遷移である。PR レビューでは:

```yaml
gh pr edit "$PR_NUMBER" --remove-label "agent:review" || true
gh pr edit "$PR_NUMBER" --remove-label "agent:blocked" || true
gh pr edit "$PR_NUMBER" --add-label "agent:in-progress"
```

[agent-review.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-review.yml#L27-L31)。Issue 側も同型で、explore なら `agent:explore` を消す（[agent-explore.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-explore.yml#L25-L29)、[agent-update-branch.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-update-branch.yml#L33-L37)、[agent-implement.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement.yml#L97-L102)、[agent-implement-pr.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement-pr.yml#L33-L38)）。

開始前検査に落ちた場合の拒否も「要求を消費して `agent:blocked` + 理由コメント」で表す。sub-issue を持つ Issue や既存 PR がある Issue に対しては、`agent:implement` を外して blocked へ移し、理由をコメントする（[agent-implement.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement.yml#L51-L62)）。閉じた PR への `agent:implement` も要求を外して拒否コメントだけ残す（[agent-implement-pr.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement-pr.yml#L28-L30)）。要求が消費済みなので、原因を直しても自動では再実行されず、再付与が必要になる。

## 4. 失敗・再試行・完了の表現

失敗時の後処理は全ワークフローで同型である:

```yaml
printf '`agent:review` run failed.\n\n**Reason:** %s\n\n**Workflow run:** %s\n\nRe-add `agent:review` to retry.\n' ...
gh pr edit "$PR_NUMBER" --add-label "agent:blocked" || true
```

[agent-review.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-review.yml#L113-L124)。そして成功・失敗を問わず最後に `agent:in-progress` を外す（[agent-review.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-review.yml#L127-L129)）。同じ構造が explore / implement / update-branch にもある（[agent-explore.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-explore.yml#L63-L79)、[agent-implement.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement.yml#L195-L211)、[agent-implement-pr.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement-pr.yml#L157-L173)、[agent-update-branch.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-update-branch.yml#L107-L123)）。

つまり再試行の唯一の入口は「blocked な対象に要求ラベルをもう一度付ける」ことであり、workflow ファイル自身がそれをコメントで案内する。期限切れ claim の自動再開のような経路はない。

## 5. 直列化

同一対象の並行実行は GitHub Actions の `concurrency` グループで防ぐ。PR を mutate する 3 ワークフロー（review / implement-pr / update-branch）は同じ `agent-mutate-pr-<番号>` グループを共有し、Issue 側は role ごとのグループを持つ（[agent-review.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-review.yml#L12-L14)、[agent-implement-pr.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement-pr.yml#L12-L14)、[agent-update-branch.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-update-branch.yml#L17-L19)、[agent-explore.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-explore.yml#L12-L14)、[agent-implement.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement.yml#L12-L14)）。`cancel-in-progress: false` で、後発要求は先発の完了後に順番に流れる。この待ち行列の意味は「後から付けられた要求ほど後に処理される」であり、deadloop の役割別優先順位とは異なる。

## 6. ループの連鎖

実装が成功すると、新規 branch を push し（[agent-implement.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement.yml#L157-L160)）、draft PR を作り（[agent-implement.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement.yml#L162-L176)）、PR に `agent:review` を付けてレビューへ引き渡す（[agent-implement.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement.yml#L178-L193)）。レビュー成功時は review 投稿後に `gh pr ready` で draft を ready へ変える（[agent-review.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-review.yml#L89-L91)）。人間への引き渡しは「ready になり、agent ラベルが全部外れた PR」として表現され、専用ラベルは使わない。

## 7. deadloop が採用する点

1. **要求 = 一回限りの labeled イベント**。消費は要求ラベルの削除、識別はタイムライン上のイベント id。
2. **現在状態は `agent:in-progress` / `agent:blocked` の 2 値**。要求と状態の併存で「止まっているがまだ求められている」を表さない。deadloop では停止が前の時点の要求を保持しない。
3. **再試行 = 要求ラベルの再付与**。ローカルコマンドや journal からの自動復帰は置かない。
4. **人間への引き渡し = ready + agent ラベルなし**。
5. **draft PR → `agent:review` → レビュー → ready / merge の連鎖**。

## 8. deadloop が意図的に変える点

1. **非 force push**。新規 branch の push に force を使う（[agent-implement.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement.yml#L159)）方式を採らず、既存 PR branch の更新は head-SHA lease 付きでも（[agent-implement-pr.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement-pr.yml#L88)、[agent-review.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-review.yml#L70)、[agent-update-branch.yml](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-update-branch.yml#L85)）、deadloop は exact-head 非-force push と expected-object-ID fast-forward lease だけを許す。
2. **必須検証**。push・ready 化・マージの前に、対象 revision に結び付いた検証成功記録を要求する。Sandcastle の dogfood にはこのゲートがない。
3. **stale reconciler**。concurrency グループは実行環境の直列化であり、クラッシュしたホストや古い内部状態の照合はしない。deadloop は毎 tick、GitHub 状態と timeline 由来の claim と実行基盤の生存を照合し、内部理由だけで要求を隠さない。
4. **分散 claim**。GitHub Actions 単一環境ではなく、複数マシン・複数 identity が同じリポジトリを担当できる。所有者は公開タイムラインと設定済み identity 集合から決定論的に導く。
