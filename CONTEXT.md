# deadloop

GitHub Issue から実装・PR 作成・レビュー・マージまでを Pi 上で自動で回すループエンジニアリングツール。このファイルはプロジェクトの用語集であり、実装の詳細は含めない。

## Language

**オーケストレータ (Orchestrator)**:
deadloop 拡張を読み込んで動く常駐 Pi セッション。automation を定期実行し、Worker やレビューエージェントを起動・監視する。
_Avoid_: オーケストレーター(表記ゆれ。長音符なしに統一)、司令塔(旧称)、コーディネーター(automation の issue coordinator と混同するため)、ルーパー(プロダクト名 deadloop と衝突し、ループの主体は schedule のため)、メインセッション、親エージェント

**Worker (作業エージェント)**:
Issue coordinator が Herdr worktree に起動する、単一 issue を実装する使い捨てのエージェントセッション。どの CLI で動くかはエージェント種別が決める。
_Avoid_: 実装エージェント、子エージェント、Pi セッション(pi 固定を含意するため)

**レビューエージェント**:
PR reviewer が起動する、単一 PR をレビューする使い捨てのエージェントセッション。Worker とは別概念で、モデル指定も独立している。
_Avoid_: レビュワー(automation の PR reviewer と混同するため)、review worker

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

**promise (完了報告)**:
Worker が作業終了時に、オーケストレータが起動ごとに採番した専用パスへ書く構造化された完了報告(complete / blocked)。完了判定の唯一の権威であり、エージェントの session ファイルや画面出力は判定に使わない。失敗時も必ず書く(黙って終了しない)。
_Avoid_: promise テキスト規約(`<promise>` タグ)、pane grep、session JSONL 抽出

**起動ポリシー (workerLaunchPolicy)**:
issue の難易度から `low` / `medium` / `high` のレベルを選ぶための、オーケストレータ向けの方針文。モデル選択やエージェント固有フラグ名はこのポリシーの管轄外。
_Avoid_: launch policy でのモデル許可、`--thinking` / `--effort` 固定の方針文

**doctor 診断**:
operator が 1 コマンドで実行する、既知の失敗モードの読み取り専用診断。所見ごとにコピペ可能な確認コマンドまたは解決コマンドを提示するが、自動修復はしない。
_Avoid_: 自動修復、オーケストレータセッション自身の設定鮮度診断
