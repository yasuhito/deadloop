# pi-looper extension

Pi 本体から読み込まれる extension 実体です。通常は package root の `README.md` を読んでください。

## ローカル設定

この directory に実運用用の `projects.json` を置くこともできますが、リポジトリには含めません。公開用の雛形は `projects.example.json` です。

優先順位:

1. `PI_LOOPER_CONFIG`
2. `HERDR_LOOPER_CONFIG`（旧名互換）
3. この directory の `projects.json`

## 状態保存

状態と lock は `~/.pi/agent/pi-looper/` に保存します。

## 旧名互換

旧 `herdr-looper` からの移行のため、当面は `HERDR_LOOPER_*` と内部 `HEADR_*` 環境変数も読みます。新規設定では `PI_LOOPER_*` を使ってください。
