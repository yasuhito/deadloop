# pi-looper 拡張

Pi 本体から読み込まれる拡張の実体です。通常はパッケージルートの `README.md` を読んでください。

## ローカル設定

通常は `~/.pi/agent/pi-looper/projects.json` に実運用用の設定を置きます。このディレクトリに `projects.json` を置くこともできますが、リポジトリには含めません。公開用の雛形は `projects.example.json` です。`projects.json` はローカルパス、GitHub リポジトリ、展開判断を含むローカル設定なのでコミットしません。PR reviewer の自動マージは安全のため既定で無効です。必要な場合だけプロジェクト設定に `"autoMerge": true` を明示します。Worker は `workerAgent` で `"pi"` / `"claude"` を選べ、未設定時は `"pi"` です。`"claude"` を使う場合は対象リポジトリのルートで operator が一度 `claude` を対話起動し、workspace trust を受け入れておきます。初回導入は [../../docs/public-package-setup.md](../../docs/public-package-setup.md) の Phase 1 から始めてください。

優先順位:

1. `PI_LOOPER_CONFIG`
2. `~/.pi/agent/pi-looper/projects.json`
3. このディレクトリの `projects.json`

## 状態保存

状態と lock は `~/.pi/agent/pi-looper/` に保存します。

## 状況レポートと doctor 診断

Pi コマンド `/pi-looper-status` は、有効なプロジェクトの運用者向けレポートを短く表示します。ローカルプロジェクト設定、pi-looper の状態ファイル、GitHub Issue / PR ラベル、Herdr 作業用 worktree を読み、人間が複数のコマンド結果を手で突き合わせなくても、ループが何を待っているか分かるようにします。

Pi コマンド `/pi-looper-doctor` は、ループが止まったときの既知の失敗モードを読み取り専用で診断します。所見ごとにコピペ可能な確認コマンドまたは解決コマンドを表示しますが、自動修復はしません。所見が無い場合は「問題なし」と表示します。

GitHub Issue / PR キューや worktree の問題に加えて、`state.json` の自動化エントリから次を検知します。precheck が code 126/127 でスキップされ続けている場合(precheck スクリプトの不在・実行不能)、同じ失敗が 3 スロット以上連続している場合(ループの空回り)、3 スロット以上試行が途絶えている場合(司令塔セッション停止の疑い)です。判定は入力注入の純関数、`state.json` の読み取りは収集層で行い、doctor は書き込みをしません。

GitHub の claim ラベルと `herdr agent list` を突き合わせ、実行主体のいない claim(stuck claim)も検知します。`agent:reviewing` の付いた open PR に対応するレビューエージェント(`<projectId>-pr-<PR>-reviewer`)が Herdr で working でない場合は「中断されたレビュー claim」として `gh pr edit <PR> -R <repo> --remove-label agent:reviewing` を提示します。`agent:in-progress` の付いた open issue に対応する Worker(`<projectId>-issue-<N>-worker`)が Herdr に存在しない場合は「中断された実装 claim」として、worktree の未回収コミット確認(`git -C <worktreePath> log <baseBranch>..HEAD --oneline`)と、確認後の再 queue コマンドを 2 段で提示します。run の中断による選定スキップ(沈黙停止)を運用者が見つけられるようにするための可視化で、自動回復はしません。

`workerAgent: "claude"` のプロジェクトでは、`~/.claude.json` を読み取り専用で確認し、リポジトリのルートが workspace trust を受け入れていない場合に所見を出します。claude Worker は対話モードで起動するため、未 trust だと初回起動が trust ダイアログでブロックされます。解決には `cd <repoPath> && claude` を一度実行して trust ダイアログを受け入れます。`~/.claude.json` が無い・読めない・不正な場合はエラーにせず「trust 状態を確認できない」所見を出します。

## Herdr の片付け

`issue-coordinator` は Issue 選択前に `automations/cleanup-completed-worker-worktrees.py` を呼び、マージ済み / close 済み PR に対応する clean な Herdr linked worktree だけを決定論的に片付けます。削除可否はプロンプトでは判断しません。

## Issue coordinator の決定処理

`issue-coordinator` は Issue 候補選定、除外ラベル判定、本文の `## Blocked by` / `Depends on #N` と GitHub Relationships metadata の依存判定を `automations/issue-coordinator-decisions.py` で決定論的に行います。プロンプトはその結果を使って進行管理と Gate 以降の判断に集中します。

## PR reviewer の決定処理

`pr-reviewer` は PR 候補選定、未完了検証、Copilot / CodeRabbit の外部レビュー待機、古い marker 判定を `automations/pr-reviewer-decisions.py` で決定論的に行います。プロンプトはその結果を使って進行管理と最終判断に集中します。
