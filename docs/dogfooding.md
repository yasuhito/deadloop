# Dogfooding pi-looper

pi-looper 自体の開発も、pi-looper で回します。

目的は、単に便利に開発することではありません。実際のリポジトリで「Issue を作るだけで実装ループが進む」運用を続けることで、公開前に安全性、設定しやすさ、失敗時の止まり方、プロンプトと決定論的スクリプトの境界を検証します。

## 基本方針

最初から自動マージまで有効にしません。段階的に試験運用します。

For public users, use the same safe rollout model:

1. **Issue coordination only** — enable `generic-issue-coordinator` first. It may create implementation PRs, but humans still review and merge.
2. **PR reviewer without auto-merge** — add `generic-pr-reviewer` only after issue coordination is reliable. Keep `autoMerge: false` so reviewed PRs are handed to `ready-for-human`.
3. **Conditional auto-merge** — consider `autoMerge: true` only after branch protection, CI, review expectations, manual approval/dry-run practices, and stop conditions are proven.

See [public-package-setup.md](public-package-setup.md) for the first-time setup checklist.


1. **Phase 1: 実装 PR 作成まで**
   - `generic-issue-coordinator` だけを有効にする。
   - エージェントに渡せる Issue を拾い、Herdr worktree の Pi 作業エージェントに実装させる。
   - 司令塔が検証して PR を作る。
   - PR レビューとマージは人間が行う。
2. **Phase 2: レビュー自動化を試す**
   - 安全制御が入ってから `generic-pr-reviewer` を有効にする。
   - 最初は自動マージを禁止し、人間確認に渡す運用で試す。
3. **Phase 3: 条件付き自動マージ**
   - 事前確認、手動承認、自動マージ無効化、失敗時停止条件が揃ってから検討する。

## なぜ Phase 1 から始めるか

現在の v0 は、条件が揃うと PR を squash merge して head branch を削除できます。これは便利ですが、pi-looper 自体の開発で最初から有効にするには強すぎます。

まずは Issue coordinator だけを使い、次を確認します。

- エージェントに渡せる Issue の契約が十分に具体的か
- 作業エージェントが `AGENTS.md` と README を読んで実装できるか
- `checkCommand` が適切に失敗を検出するか
- PR 作成までの引き継ぎが読みやすいか
- Herdr worktree の作成・完了検出・片付けが安定しているか

## 推奨ローカル設定

`projects.json` はローカル設定なので、リポジトリにコミットしません。ローカルパス、対象リポジトリ、`autoMerge` などの展開判断が入るため、公開パッケージには `projects.example.json` だけを含めます。例:

```json
{
  "projects": [
    {
      "id": "pi-looper",
      "enabled": true,
      "repoPath": "/home/yasuhito/Work/pi-looper",
      "githubRepo": "yasuhito/pi-looper",
      "baseBranch": "origin/main",
      "worktreeRoot": "/home/yasuhito/Work/herdr-worktrees/pi-looper/",
      "checkCommand": "npm test && npm run lint && npm run typecheck && bash -n extensions/pi-looper/automations/*.sh && python3 -m py_compile extensions/pi-looper/automations/*.py && npm pack --dry-run",
      "autoMerge": false,
      "workerInstructions": "AGENTS.md, README.md, docs/dogfooding.md, and relevant files must be read before making changes. Follow the one-expectation-per-test rule.",
      "automations": [
        {
          "id": "pi-looper:issue-coordinator",
          "name": "pi-looper issue coordinator",
          "schedule": "*/10 * * * *",
          "promptFile": "generic-issue-coordinator.prompt.md",
          "precheckFile": "generic-issue-coordinator.precheck.sh",
          "precheckTimeoutSeconds": 60
        }
      ]
    }
  ]
}
```

`generic-pr-reviewer` は Phase 1 では入れません。レビュー自動化を試す場合だけ、別コミットで有効にします。その場合も最初は `autoMerge: false` のままにし、レビューエージェントの確認と検証が終わった PR を `ready-for-human` に渡す運用で試します。`autoMerge: true` は Phase 3 まで使いません。

## 起動方法

ローカル作業ツリーから試す場合:

```bash
pi install /home/yasuhito/Work/pi-looper
mkdir -p ~/.pi/agent/pi-looper
$EDITOR ~/.pi/agent/pi-looper/projects.json
cd /home/yasuhito/Work/pi-looper
pi
```

一時的に試すだけなら、install せずに次でもよいです。

```bash
cd /home/yasuhito/Work/pi-looper
pi -e /home/yasuhito/Work/pi-looper
```

別の設定ファイルを使う場合だけ `PI_LOOPER_CONFIG=/path/to/projects.json` を指定します。

## 必要なラベル

最初に GitHub 側へラベルを作成します。

```bash
gh label create ready-for-agent --repo yasuhito/pi-looper --color 0e8a16 || true
gh label create agent:implement --repo yasuhito/pi-looper --color 1d76db || true
gh label create agent:in-progress --repo yasuhito/pi-looper --color fbca04 || true
gh label create agent:review --repo yasuhito/pi-looper --color 5319e7 || true
gh label create agent:reviewing --repo yasuhito/pi-looper --color c2e0c6 || true
gh label create agent:blocked --repo yasuhito/pi-looper --color b60205 || true
gh label create ready-for-human --repo yasuhito/pi-looper --color d93f0b || true
gh label create needs-info --repo yasuhito/pi-looper --color fef2c0 || true
gh label create needs-triage --repo yasuhito/pi-looper --color f9d0c4 || true
```

## 試験運用用 Issue の書き方

Issue coordinator が拾うには、Issue に次の両方のラベルを付けます。

- `ready-for-agent`
- `agent:implement`

Issue 本文には、少なくとも `## Agent Brief` または `## What to build` と、`## Acceptance criteria` または `## 受け入れ条件` を含めます。詳しい Gate 条件は README の「エージェントに渡せる Issue の書き方」と `extensions/pi-looper/automations/generic-issue-coordinator.prompt.md` の `### 3. Gate` 節に合わせます。

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
pi-looper の試験運用を安全に進めるため、PR reviewer の自動マージを設定で止められるようにする。

## What to build
- project 設定に `autoMerge` または同等の安全フラグを追加する。
- `generic-pr-reviewer` プロンプトに、そのフラグが無効の場合はマージせず `ready-for-human` に渡す方針を反映する。
- 既定値は安全側に倒す。
- README または docs に設定例を追記する。

## Acceptance criteria
- 既定設定では自動マージが有効にならない。
- `npm test` が通る。
- `npm run lint` が通る。
- `npm run typecheck` が通る。
- `bash -n extensions/pi-looper/automations/*.sh` が通る。
- `python3 -m py_compile extensions/pi-looper/automations/*.py` が通る。
- `npm pack --dry-run` にローカル設定やキャッシュが含まれない。

## Out of scope
- tmux 実行基盤の追加。
- レビューエージェントの全面的な再設計。
```

## 標準検証

pi-looper 自体の変更やパッケージ内容を確認するときは、次を標準検証として使います。

```bash
npm test
npm run lint
npm run typecheck
bash -n extensions/pi-looper/automations/*.sh
python3 -m py_compile extensions/pi-looper/automations/*.py
npm pack --dry-run
```

`npm pack --dry-run` では、`extensions/pi-looper/projects.json`、キャッシュ、worktree の生成物、`node_modules/`、Python バイトコードがパッケージに含まれていないことも確認します。

## 停止条件

次の状態になったら自動処理を止め、人間が確認します。

- worktree に未コミット差分が残っている
- 作業エージェントが promise ファイルに `status: "blocked"` を書いた
- `checkCommand` が失敗した
- PR が draft のまま
- 外部レビューや CI が失敗した
- プロンプトが想定外に push / マージ / ラベル操作を作業エージェントに許している
