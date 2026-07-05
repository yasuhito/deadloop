# Worker はエージェントレベルで Claude Code CLI に対応する(ADR 0001 を supersede)

ADR 0001 は「Claude 対応はモデルレベル(Pi の Anthropic OAuth)で行う」と決めたが、その直後に Anthropic のポリシー変更が判明した: サードパーティアプリ(Pi 含む)経由の Claude サブスクリプション OAuth 利用は、プラン枠ではなく extra usage(追加課金)から引かれる。Max プランの枠を消化できるのは第一者アプリ = Claude Code CLI だけである。「Codex サブスク残量の代替として Claude サブスク枠で Worker を回す」という当初目的には、ADR 0001 が却下したエージェントレベル対応が必要になったため、本 ADR で supersede する。

## Status

Accepted. Supersedes [ADR 0001](0001-model-level-claude-support.md).

## Decision

- `projects.json` に **`workerAgent: "pi" | "claude"`**(列挙、未設定 = `pi`)を追加する。エージェントの差は起動コマンド 1 行ではなく「起動構文・prompt の渡し方・完了報告の読み方・thinking 相当の対応付け」の連動セットなので、operator が書ける自由記述コマンドテンプレートは採らない。列挙は `normalizeProject` で検証し、typo は即エラーにする(モデル名の無検証パススルーとは性質が違う: エージェント種別は pi-looper 自身の分岐キー)。
- `workerModel` は無検証パススルーのまま、**選択したエージェントが理解する形式**で operator が書く(pi: `provider/id`、claude: `opus` / `claude-opus-4-8` 等)。
- claude Worker は**対話モード**で起動する(`-p` 非対話はプロセスが終了し、Herdr の監視と督促が使えなくなる)。prompt はファイルの中身をポジショナル引数で渡す。司令塔が `--session-id <uuid>` を採番し、`--permission-mode bypassPermissions` を付ける(使い捨て worktree 内の無人実行で、Pi の full-auto と同じ信頼レベル)。
- thinking 対応は `--thinking low/medium/high`(pi)→ `--effort low/medium/high`(claude)の写像。`workerLaunchPolicy` は「難易度→レベル」の方針文に純化し、フラグ名はエージェント種別が決める。
- Herdr の `agent_status` は監視ヒントに格下げする。完了判定の権威は promise ファイル([ADR 0003](0003-promise-file-contract.md))のみ。claude に対する Herdr のハード要件は「起動できて pane が生存する」だけ。
- スコープは Worker のみ。レビューエージェントの claude 対応は後続とし、設定スキーマだけ対称に拡張できる形を保つ。

## Consequences

- 実装前に使い捨てプロトタイプで 4 点を検証する: 長い日本語 prompt の引数渡し、フラグの組み合わせ、promise ファイルの遵守率、pane 送信による督促。
- ADR 0001 の「実行基盤を追加してもエージェント CLI は Pi のまま」という前提は失効する。
