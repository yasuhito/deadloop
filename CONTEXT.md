# deadloop

GitHub Issue から実装・PR 作成・レビュー・マージまでを Pi 上で自動で回すループエンジニアリングツール。このファイルはプロジェクトの用語集であり、実装の詳細は含めない。

## Language

**deadloop core**:
GitHub Issue / PR の状態遷移、安全ゲート、ループ上の判断を担う、実行環境に依存しない中核。定期実行、worktree / session 管理、エージェント CLI ごとの差異は含めない。
_Avoid_: 共通実装、Pi 拡張本体、Herdr runner

**Automation host**:
deadloop core を定期または手動で呼び出し、試行回数と次回実行時刻を管理する実行主体。Issue / PR の選定、再試行可否、安全ゲートは判断せず、deadloop core の結果に従う。Pi 拡張、Claude App、Codex Appはそれぞれ別の Automation host になり得る。
_Avoid_: スケジューラ(定期実行だけを含意するため)、オーケストレータ(Pi上の具体的なhostだけを指すため)

**対応経路 (Support path)**:
Automation host、実行基盤、Agent programの検証対象となる組み合わせ。製品名単体ではなく、この組み合わせごとに第一級対応または実験的対応を判定する。
_Avoid_: 対応製品、全組み合わせの暗黙の保証

**第一級対応 (First-class support)**:
共通の受入契約を満たし、公開文書だけを使った作者以外の完走確認を終えた対応経路。利用者へ推奨できる。
_Avoid_: 実装済み、動作例あり、公式対応

**実験的対応 (Experimental support)**:
受入契約の一部が未達または未確認で、既知の制約と未確認能力を明示して試験する対応経路。利用者への推奨や自動マージの許可を含まない。
_Avoid_: 第一級対応、推奨経路

**オーケストレータ (Orchestrator)**:
deadloop 拡張を読み込んで動く常駐 Pi セッション。Automation host の一種としてautomationを定期実行し、Worker やレビューエージェントを起動・監視する。
_Avoid_: オーケストレーター(表記ゆれ。長音符なしに統一)、司令塔(旧称)、コーディネーター(automation の issue coordinator と混同するため)、ルーパー(プロダクト名 deadloop と衝突し、ループの主体は schedule のため)、メインセッション、親エージェント

**試行 (attempt)**:
一つのIssue実装またはPRレビューを一度遂行する単位。外部副作用より前に一意に識別され、復旧中は同じ試行として追跡される。明確な失敗後に再実行するときは新しい試行となる。完了報告は試行と対象revisionに結び付く。
_Avoid_: run(定期実行やプロセス起動と混同するため)、session(エージェントの会話状態を指すため)、retry(試行間の関係だけを指すため)

**Worker (作業エージェント)**:
Issue coordinator が Herdr worktree に起動する、単一 issue を実装する使い捨てのエージェントセッション。どの CLI で動くかはエージェント種別が決める。
_Avoid_: 実装エージェント、子エージェント、Pi セッション(pi 固定を含意するため)

**レビューエージェント**:
PR reviewer が起動する、単一 PR をレビューする使い捨てのエージェントセッション。Worker とは別概念で、モデル指定も独立している。
_Avoid_: レビュワー(automation の PR reviewer と混同するため)、review worker

**実行基盤 (Execution runtime)**:
試行に結び付いたworkspaceとsessionの所有権を持ち、起動、観測、停止、安全な後片付けを提供する基盤。GitHubの状態や再試行可否は判断せず、未知またはdirtyな作業領域を保全する。Herdrは実行基盤の一種。
_Avoid_: runner(実装上のinterface名と混同するため)、Automation host(定期実行や試行管理の主体を指すため)、エージェント種別(Pi / Claude / Codexの差異を指すため)

**エージェント種別 (workerAgent)**:
operator がプロジェクト設定で選ぶ、Worker を動かす CLI エージェントの種類(`pi` / `claude` の列挙)。起動構文・prompt の渡し方・session 形式・promise 抽出方法が連動して決まる分岐キーであり、モデル指定とは独立。未設定は `pi`。
_Avoid_: 起動コマンドテンプレート、workerCommand

**エージェントプロファイル (AgentProfile)**:
エージェント種別ごとの起動時差分(argv の形・prompt の渡し方・レベル写像・前提条件)を記述した、コード内の型付きテーブル。エージェント種別の列挙検証もここから導出される唯一の情報源。追加はプロトタイプ検証とテストを伴う PR で行い、operator 設定では拡張できない。
_Avoid_: 外部プロファイル設定、ユーザー定義エージェント

**ランチャー (launch-agent)**:
オーケストレータがエージェント(Worker / レビューエージェント)を起動するときに呼ぶ唯一のコマンド。エージェントプロファイルから argv を組み立て、シェルを介さずに実行基盤の起動コマンドを実行し、前提条件を fail-fast で検査する。
_Avoid_: プロンプトテンプレート内の起動コマンド分岐、argv 印字ヘルパー

**エージェント起動フロー (Agent launch flow)**:
オーケストレータが Worker / レビューエージェントを起動するために、実行基盤の worktree / tab を用意し、prompt / promise パスを作り、ランチャーを呼ぶ一連の手順。GitHub Issue / PR の選定やラベル状態遷移は含めない。
_Avoid_: GitHub Issue / PR の状態遷移、candidate selection、review gate

**モデル指定 (workerModel / reviewerModel)**:
operator がプロジェクト設定で固定する、Worker・レビューエージェントの使用モデル。サブスクリプション残量などの資源配分に基づく operator の意思決定であり、オーケストレータの裁量ではない。
_Avoid_: 低コストモデル許可、モデル切替ポリシー

**完了報告 (Completion report)**:
Workerまたはレビューエージェントが試行の終了時に提出する、試行、対象revision、結果、要約、検証またはレビュー証拠を含む構造化報告。意味的な完了判定の唯一の権威だが、GitHub状態の変更やmergeを許可する命令ではない。
_Avoid_: process終了、画面出力、session状態、エージェントの最終回答

**promise**:
Pi + Herdr経路で、起動ごとの専用パスを使って完了報告を搬送する仕組み。完了報告そのものの形式やdeadloop coreの公開契約とは区別する。
_Avoid_: 完了報告との同一視、promiseテキスト規約(`<promise>`タグ)、pane grep、session JSONL抽出

**起動ポリシー (workerLaunchPolicy)**:
issue の難易度から `low` / `medium` / `high` のレベルを選ぶための、オーケストレータ向けの方針文。モデル選択やエージェント固有フラグ名はこのポリシーの管轄外。
_Avoid_: launch policy でのモデル許可、`--thinking` / `--effort` 固定の方針文

**doctor 診断**:
operator が 1 コマンドで実行する、既知の失敗モードの読み取り専用診断。所見ごとにコピペ可能な確認コマンドまたは解決コマンドを提示するが、自動修復はしない。
_Avoid_: 自動修復、オーケストレータセッション自身の設定鮮度診断
