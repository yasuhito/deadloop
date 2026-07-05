# Claude 対応はエージェントレベルではなくモデルレベルで行う

**Status: superseded by [ADR 0002](0002-agent-level-claude-support.md)** — Anthropic のポリシー変更(サードパーティアプリ経由の Claude サブスク OAuth は extra usage 課金)により前提が崩れたため。

Codex サブスクリプションの残量対策として Worker / レビューエージェントを Claude でも動かせるようにするにあたり、Claude Code CLI を第 2 のワーカーエージェントとして起動できるようにする案(エージェントレベル対応)を退け、Pi のマルチプロバイダ抽象と Claude サブスクリプション OAuth に乗るモデルレベル対応を採用した。Pi は `--model anthropic/claude-*` で Claude サブスクリプションをそのまま使えるため、起動コマンドの抽象化・`<promise>` プロトコルの再検証・Herdr 待機条件の対応といったエージェントレベル対応のコストに見合う利点がなかった。

## Considered Options

- **エージェントレベル対応**: `herdr agent start ... -- pi ...` の `pi` を差し替え可能にし、Claude Code CLI をワーカーとして起動する。プロンプトテンプレート・promise 抽出・待機条件が全て CLI ごとに分岐し、工数と壊れやすさが大きい。却下。
- **モデルレベル対応(採用)**: pi-looper は Pi 専用のまま、モデルだけを切り替える。

## Consequences

- モデル選択は `projects.json` の `workerModel` / `reviewerModel`(Pi の `provider/id` 形式、無検証でそのまま `--model` に渡す)で operator が固定する。設定時は司令塔が無条件に `--model` を付け、issue 難易度による上書きは認めない。
- `workerLaunchPolicy` の役割は `--thinking` の選択方針だけに純化し、「低コストモデル許可」などモデル選択に関する散文は持たない。
- 将来 tmux などの実行基盤を追加する場合も、エージェント CLI は Pi のままである前提が維持される。この前提を崩す(Claude Code 等を直接起動する)場合はこの ADR を supersede すること。
