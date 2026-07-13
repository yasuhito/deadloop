# 完了報告は push 型の promise ファイル契約に一本化する

Worker の完了検知はこれまで「assistant テキストに `<promise>COMPLETE</promise>` を出力させ、司令塔が Pi session JSONL をパースして抽出する」pull 型だった。エージェントレベル対応(ADR 0002)でこの方式を claude に広げるには、非公開の内部形式である claude session JSONL への結合・sidechain(サブエージェント発言)の除外・herdr 経由の session パス解決が必要になり、エージェントを足すたびにパーサが増える。これを避け、**worker 自身が終了時に司令塔指定のパスへ JSON を書く push 型契約**に pi / claude 共通で移行する。

## Status

Accepted.

## Decision

- 司令塔は Worker 起動ごとに一意な promise ファイルパスを採番し、worker prompt で指示する。現在の配置は [ADR 0010](0010-runtime-artifact-isolation.md) に従い `<deadloopStateDir>/runs/<uuid>/promise.json` とする。uuid は claude の `--session-id` と共用し、同一 issue のリトライ起動時に前回 worker の古い報告を誤読することを構造的に排除する(Orca の dispatchId 権威に相当)。
- ペイロードは `{"status":"complete"|"blocked","reason":...,"summary":"3文要約(何をした・何が分かった・何が残っている)"}`。
- 規約: **失敗も必ず書く。黙って終了しない**(blocked も promise である)。
- `extract-worker-promise.ts` の前身にあった session JSONL パース・`--pane-id` 解決は廃止し、「指定パスの JSON を読んで検証する」薄い helper に置き換える。`<promise>` テキスト規約も廃止する。
- エージェントの session ファイル・pane 出力・Herdr `agent_status` は完了判定に使わない(監視ヒントのみ)。

## Considered Options

- **agent 別 JSONL パーサ**: claude の session 形式(`~/.claude/projects/<cwd スラッグ>/<uuid>.jsonl`)に対応させる案。`--session-id` 採番でパスは決定的になるが、(1) deadloop が制御できない非公開形式に完了検知を結合する、(2) エージェント追加ごとにパーサが増える、(3) 現行の正規表現抽出には worker が promise を「引用」した場合の誤検出リスクが残る。却下。
- **push 型ファイル契約(採用)**: Orca ADE(stablyai/orca)の実装調査が決め手。Orca は claude session JSONL のパーサを持ちながら**チャット UI 描画専用**とし、完了の権威は worker 自身が送る `worker_done` メッセージに限定している(「terminal 出力は状態監視用、結果抽出には structured payload を使え」)。

## Consequences

- pi Worker のテンプレートも移行が必要(テンプレートは deadloop が一元所有、変更は 1 箇所)。
- 「worker が書き忘れる」失敗モードは、現行運用の督促手順(promise 無し → worker に出力を依頼)をそのまま流用して緩和する。Orca 同様、無報告 idle の worker を自動で失敗扱いにはしない。
