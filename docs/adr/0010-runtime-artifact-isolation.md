# 実行成果物をプロジェクト検証から隔離する

deadloop のプロンプトと promise は `~/.pi/agent/deadloop/runs/<uuid>/` に置き、対象worktree内へ作らない。プロジェクトの検証コマンドは deadloop の検証ラッパーを通し、既存の未追跡 `.deadloop` と `.pi-subagents` をworktree外へ一時隔離してから実行し、成功・失敗・タイムアウト・中断のすべてで復元を試みる。復元に失敗した場合は、隔離先と一時worktreeを保全して両方の場所を記録し、`/deadloop-doctor` で表示する。どちらかに追跡対象ファイルがあれば隠さず、検証を安全側に失敗させる。これにより、再帰的なJSON整形検査へ実行成果物が混入する問題を、各利用リポジトリのignore設定に依存せず防ぐ。

## Status

Accepted.

## Consequences

promise の完了報告契約と起動ごとの一意性は維持するが、ADR 0003に記録されたworktree内のパスはこの決定で置き換える。検証中に同じ場所へ新しい成果物が作られた場合は両方を保持し、内容が衝突する古いファイルには `.deadloop-preserved-<n>` を付けて証拠を失わない。
