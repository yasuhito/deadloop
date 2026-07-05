# pi-looper

GitHub Issue から実装・PR 作成・レビュー・マージまでを Pi 上で自動で回すループエンジニアリングツール。このファイルはプロジェクトの用語集であり、実装の詳細は含めない。

## Language

**司令塔 (Coordinator)**:
pi-looper 拡張を読み込んで動く常駐 Pi セッション。automation を定期実行し、Worker やレビューエージェントを起動・監視する。
_Avoid_: メインセッション、親エージェント

**Worker (作業エージェント)**:
Issue coordinator が Herdr worktree に起動する、単一 issue を実装する使い捨ての Pi セッション。
_Avoid_: 実装エージェント、子エージェント

**レビューエージェント**:
PR reviewer が起動する、単一 PR をレビューする使い捨ての Pi セッション。Worker とは別概念で、モデル指定も独立している。
_Avoid_: レビュワー(automation の PR reviewer と混同するため)、review worker

**エージェント種別 (workerAgent)**:
operator がプロジェクト設定で選ぶ、Worker を動かす CLI エージェントの種類(`pi` / `claude` の列挙)。起動構文・prompt の渡し方・session 形式・promise 抽出方法が連動して決まる分岐キーであり、モデル指定とは独立。未設定は `pi`。
_Avoid_: 起動コマンドテンプレート、workerCommand

**モデル指定 (workerModel / reviewerModel)**:
operator がプロジェクト設定で固定する、Worker・レビューエージェントの使用モデル。サブスクリプション残量などの資源配分に基づく operator の意思決定であり、司令塔の裁量ではない。
_Avoid_: 低コストモデル許可、モデル切替ポリシー

**promise (完了報告)**:
Worker が作業終了時に、司令塔が起動ごとに採番した専用パスへ書く構造化された完了報告(complete / blocked)。完了判定の唯一の権威であり、エージェントの session ファイルや画面出力は判定に使わない。失敗時も必ず書く(黙って終了しない)。
_Avoid_: promise テキスト規約(`<promise>` タグ)、pane grep、session JSONL 抽出

**起動ポリシー (workerLaunchPolicy)**:
issue の難易度から `--thinking` レベルを選ぶための、司令塔向けの方針文。モデル選択はこのポリシーの管轄外。
_Avoid_: launch policy でのモデル許可
