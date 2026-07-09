# Dogfooding deadloop

deadloop 自体の開発も、deadloop で回します。

目的は、単に便利に開発することではありません。実際のリポジトリで「Issue を作るだけで実装ループが進む」運用を続けることで、公開前に安全性、設定しやすさ、失敗時の止まり方、プロンプトと決定論的スクリプトの境界を検証します。

## 基本方針

最初から自動マージまで有効にしません。段階的に試験運用します。

For public users, use the same safe rollout model:

1. **Issue coordination only** — enable `issue-coordinator` first. It may create implementation PRs, but humans still review and merge.
2. **PR reviewer without auto-merge** — add `pr-reviewer` only after issue coordination is reliable. Keep `autoMerge: false` so reviewed PRs are handed to `ready-for-human`.
3. **Conditional auto-merge** — consider `autoMerge: true` only after branch protection, CI, review expectations, manual approval/dry-run practices, and stop conditions are proven.

See [public-package-setup.md](public-package-setup.md) for the first-time setup checklist.


1. **Phase 1: 実装 PR 作成まで**
   - `issue-coordinator` だけを有効にする。
   - エージェントに渡せる Issue を拾い、Herdr worktree の Pi 作業エージェントに実装させる。
   - オーケストレータが検証して PR を作る。
   - PR レビューとマージは人間が行う。
2. **Phase 2: レビュー自動化を試す**
   - 安全制御が入ってから `pr-reviewer` を有効にする。
   - 最初は自動マージを禁止し、人間確認に渡す運用で試す。
3. **Phase 3: 条件付き自動マージ**
   - 事前確認、手動承認、自動マージ無効化、失敗時停止条件が揃ってから検討する。

## なぜ Phase 1 から始めるか

現在の v0 は、条件が揃うと PR を squash merge して head branch を削除できます。これは便利ですが、deadloop 自体の開発で最初から有効にするには強すぎます。

まずは Issue coordinator だけを使い、次を確認します。

- エージェントに渡せる Issue の契約が十分に具体的か
- 作業エージェントが `AGENTS.md` と README を読んで実装できるか
- `checkCommand` が適切に失敗を検出するか
- PR 作成までの引き継ぎが読みやすいか
- Herdr worktree の作成・完了検出・片付けが安定しているか

## 推奨設定

対象リポジトリの trusted base branch に `deadloop.json` がある場合、そのリポジトリは deadloop 管理対象として扱います。deadloop は現在の git リポジトリから `repoPath`、GitHub リポジトリ、base branch、標準の Herdr worktree ルートを推定します。

`projects.json` はローカル上書き設定なので、リポジトリにコミットしません。`autoMerge`、独自の `worktreeRoot`、`deadloop.json` を持たないリポジトリなど、ローカルの展開判断が必要な場合だけ使います。

共有してレビューしたい実行方針は、対象リポジトリの trusted base branch にある `deadloop.json` へ移せます。deadloop は `baseBranch` からだけ読み、PR branch 側の変更はその PR 自身の判断に使いません。ローカル `projects.json` に同じ key がある場合はローカル値が優先されます。

ローカルで `autoMerge` などを上書きする場合の最小例:

```json
{
  "projects": [
    {
      "id": "deadloop",
      "repoPath": "/home/yasuhito/Work/deadloop",
      "autoMerge": false
    }
  ]
}
```

`pr-reviewer` を使う場合も最初は `autoMerge: false` のままにし、レビューエージェントの確認と検証が終わった PR を `ready-for-human` に渡す運用で試します。`autoMerge: true` は Phase 3 まで使いません。

## 起動方法

ローカル作業ツリーから試す場合:

```bash
pi install /home/yasuhito/Work/deadloop
cd /home/yasuhito/Work/deadloop
pi
```

一時的に試すだけなら、install せずに次でもよいです。

```bash
cd /home/yasuhito/Work/deadloop
pi -e /home/yasuhito/Work/deadloop
```

別の設定ファイルを使う場合だけ `DEADLOOP_CONFIG=/path/to/projects.json` を指定します。

## 必要なラベル

最初に GitHub 側へラベルを作成します。

```bash
gh label create ready-for-agent --repo yasuhito/deadloop --color 0e8a16 || true
gh label create agent:implement --repo yasuhito/deadloop --color 1d76db || true
gh label create agent:in-progress --repo yasuhito/deadloop --color fbca04 || true
gh label create agent:review --repo yasuhito/deadloop --color 5319e7 || true
gh label create agent:reviewing --repo yasuhito/deadloop --color c2e0c6 || true
gh label create agent:blocked --repo yasuhito/deadloop --color b60205 || true
gh label create ready-for-human --repo yasuhito/deadloop --color d93f0b || true
gh label create needs-info --repo yasuhito/deadloop --color fef2c0 || true
gh label create needs-triage --repo yasuhito/deadloop --color f9d0c4 || true
```

## 試験運用用 Issue の書き方

Issue coordinator が拾うには、Issue に次の両方のラベルを付けます。

- `ready-for-agent`
- `agent:implement`

Issue 本文には、少なくとも `## Agent Brief` または `## What to build` と、`## Acceptance criteria` または `## 受け入れ条件` を含めます。詳しい Gate 条件は README の「エージェントに渡せる Issue の書き方」と `extensions/deadloop/automations/issue-coordinator.prompt.md` の `### 3. Gate` 節に合わせます。

```markdown
## Agent Brief
何を作るかを具体的に書く。

## Acceptance criteria
- 満たすべき条件を書く。
- 検証コマンドを書く。

## Out of scope
今回やらないことを書く。
```

変更範囲、対象ファイル、期待する挙動を分けて書きたい場合は、`## Agent Brief` の代わりに `## What to build` を使っても構いません。

## 最初に試験運用する Issue

最初の題材は安全制御がよいです。

例:

```markdown
# Add safety controls for dogfooding

## Agent Brief
deadloop の試験運用を安全に進めるため、PR reviewer の自動マージを設定で止められるようにする。

## What to build
- project 設定に `autoMerge` または同等の安全フラグを追加する。
- `pr-reviewer` プロンプトに、そのフラグが無効の場合はマージせず `ready-for-human` に渡す方針を反映する。
- 既定値は安全側に倒す。
- README または docs に設定例を追記する。

## Acceptance criteria
- 既定設定では自動マージが有効にならない。
- `npm test` が通る。
- `npm run lint` が通る。
- `npm run typecheck` が通る。
- `bash -n extensions/deadloop/automations/*.sh` が通る。
- `npm pack --dry-run` にローカル設定やキャッシュが含まれない。

## Out of scope
- tmux 実行基盤の追加。
- レビューエージェントの全面的な再設計。
```

## 標準検証

deadloop 自体の変更やパッケージ内容を確認するときは、次を標準検証として使います。

```bash
npm test
npm run lint
npm run typecheck
bash -n extensions/deadloop/automations/*.sh
npm pack --dry-run
```

`npm pack --dry-run` では、`extensions/deadloop/projects.json`、キャッシュ、worktree の生成物、`node_modules/` などのローカル生成物がパッケージに含まれていないことも確認します。

## 停止条件

次の状態になったら自動処理を止め、人間が確認します。

- worktree に未コミット差分が残っている
- 作業エージェントが promise ファイルに `status: "blocked"` を書いた
- `checkCommand` が失敗した
- PR が draft のまま
- 外部レビューや CI が失敗した
- プロンプトが想定外に push / マージ / ラベル操作を作業エージェントに許している
