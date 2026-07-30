# GitHub Actions とマニフェストからの検証コマンド抽出調査

## 調査対象と結論

GitHub Issue [#182](https://github.com/yasuhito/deadloop/issues/182) の問いについて、2026-07-31 時点の次のチェックアウトを直接調べた。

- `deadloop`: 公開 `main` の `2a07e544a5d37f6ad4672001281036ed17f6ad0b`（[CI](https://github.com/yasuhito/deadloop/blob/2a07e544a5d37f6ad4672001281036ed17f6ad0b/.github/workflows/ci.yml)、[package.json](https://github.com/yasuhito/deadloop/blob/2a07e544a5d37f6ad4672001281036ed17f6ad0b/package.json)）。ローカル checkout の同ファイルも確認した。
- `qorraq/qorraq-prototype`: ローカル `master` の `072ba89945a04de7b44137756050e8861cdecdfe`（[CI](https://github.com/qorraq/qorraq-prototype/blob/072ba89945a04de7b44137756050e8861cdecdfe/.github/workflows/ci.yml)、[pyproject.toml](https://github.com/qorraq/qorraq-prototype/blob/072ba89945a04de7b44137756050e8861cdecdfe/pyproject.toml)、[Gemfile](https://github.com/qorraq/qorraq-prototype/blob/072ba89945a04de7b44137756050e8861cdecdfe/web/Gemfile)）。非公開リポジトリなのでリンク閲覧には権限が要る。

`run:` 文字列、`working-directory`、`env`、matrix、services、式や secrets への参照は機械抽出できる。しかし `uses:` action が作る環境、runner image の同梱物、式・秘密の実行時値、wrapper の副作用まで含めた「ローカルで同じ検証になる一個のコマンド」は `run:` だけから復元できない。以下は事実整理であり、deadloop の製品方針は提案しない。

## Actions から抽出できる情報と限界

公式構文上、`steps[*].run`、job/step の `working-directory` と `shell`、各階層の `env` を構造として取得できる（[workflow syntax: defaults.run](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_iddefaultsrun)、[steps.run](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsrun)）。同様に以下を取得できる。

- `uses` の action/ref/`with`。ただし action 内部のコマンドは、同じ ref の action source も解析しない限り得られない。
- `strategy.matrix` の静的な軸・`include`・`exclude`。各組合せは別 job になる（[公式 matrix](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations)）。
- `services` の image、port、env、health option（[公式 service containers](https://docs.github.com/en/actions/tutorials/use-containerized-services/use-docker-service-containers)）。
- `${{ ... }}` の式と参照 context。ただし `github.*`、`runner.*`、step output 等の値は実行 context なしに確定しない（[contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)、[expressions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions)）。
- `secrets.NAME` という依存の存在。値は取得できない（[公式 secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)）。

Ubuntu の既定 `run` shell は GitHub が fail-fast 用オプション付きで起動する一時 script であり、対話 shell への貼り付けと途中失敗時の意味まで同じとは限らない（[公式 shell 表](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsshell)）。

## deadloop: npm、1 job

[CI](https://github.com/yasuhito/deadloop/blob/2a07e544a5d37f6ad4672001281036ed17f6ad0b/.github/workflows/ci.yml) の `verify` job から抽出される `run` は次の 2 本だけである。

```sh
npm ci
npm run check
```

先行する `uses` は `actions/checkout@v4` と `actions/setup-node@v4`（Node 22、npm cache）。env、secrets、services、matrix、cwd override、明示 shell はない。

[package.json](https://github.com/yasuhito/deadloop/blob/2a07e544a5d37f6ad4672001281036ed17f6ad0b/package.json) の script 参照を再帰展開すると、`npm run check` は順に以下を行う。

```text
tsx src/check-acceptance-rules.ts
vitest run
tsx src/run-acceptance-tests.ts
biome check ... && biome lint ...
tsc --noEmit
bash -n extensions/deadloop/automations/*.sh
npm pack --dry-run
```

リポジトリルートで Node 22/npm と checkout を用意し `npm ci` を先に通せば、`npm run check` 自体はローカルでも文字列を変えず実行できる。ただし Node 導入は action 側、`bash` と glob の必要性は script 本文にあり、依存 package 一覧だけでは分からない。

## qorraq-prototype: Rails + Python + JavaScript、6 jobs

[CI](https://github.com/qorraq/qorraq-prototype/blob/072ba89945a04de7b44137756050e8861cdecdfe/.github/workflows/ci.yml) の全 `run` を実効 cwd/env とともに示す。YAML 上は 12 run steps、複数行を個別 shell command に分けると 14 commands である。

| job | 抽出コマンド | cwd / env | setup action 等 |
|---|---|---|---|
| `python_lint` | `uv sync --group dev --all-packages --extra test`; `uv run ruff check .`; `uv run ruff format --check .`; `uv run vulture`; `uv run mypy`; `uv run --package qorraq-cli --extra test pytest cli/tests`; `uv run python -m unittest discover -s tests` | root / 追加 env なし | checkout; setup-uv@v7, Python 3.13, cache |
| `scan_ruby` | `bundle exec brakeman --no-pager`; `bin/bundler-audit` | `web/` | checkout; setup-ruby@v1, `bundler-cache: true` |
| `scan_js` | `bin/importmap audit` | `web/` | checkout; Ruby/Bundler setup（npm setup なし） |
| `lint` | `bin/rubocop -f github` | `web/`; `RUBOCOP_CACHE_ROOT=tmp/rubocop` | checkout; Ruby/Bundler; actions/cache@v4 |
| `test` | `uv sync --group dev --all-packages --extra test`; `bin/rails db:test:prepare test` | 前者 root (`${{ github.workspace }}`)、後者 `web/`; 後者 `RAILS_ENV=test` | checkout; Ruby/Bundler; setup-uv/Python 3.13 |
| `system-test` | `bin/rails db:test:prepare test:system` | `web/`; `RAILS_ENV=test` | checkout; Ruby/Bundler; 失敗時 screenshot upload |

### 外部前提の列挙

- **services / DB:** `services:` は 0。外部 DB service はないが Rails test は `web/storage/test.sqlite3` を使い、`db:test:prepare` が DB を準備する（[database.yml](https://github.com/qorraq/qorraq-prototype/blob/072ba89945a04de7b44137756050e8861cdecdfe/web/config/database.yml)）。`sqlite3` gem も必要（[Gemfile](https://github.com/qorraq/qorraq-prototype/blob/072ba89945a04de7b44137756050e8861cdecdfe/web/Gemfile)）。「service なし」は「DB 準備なし」ではない。
- **env:** 検証 `run` step に明示された値は `RUBOCOP_CACHE_ROOT` と `RAILS_ENV`。workflow は cache action 用に `DEPENDENCIES_HASH` も宣言する。また GitHub-hosted runner は既定環境変数 `CI=true` を設定し（[公式 default environment variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables)）、qorraq の test 設定はその有無で eager load を切り替える（[test.rb](https://github.com/qorraq/qorraq-prototype/blob/072ba89945a04de7b44137756050e8861cdecdfe/web/config/environments/test.rb)）。database config は任意の `RAILS_MAX_THREADS` も読み、未設定時 5。
- **secrets / network:** `secrets.*` 参照は 0。ただし package/gem/action 取得にはネットワークが要り、ローカルに advisory database がなければ `bin/bundler-audit` も取得処理を行う。
- **setup actions:** 全 job が checkout。Python は setup-uv、Ruby 系 5 job は setup-ruby、test は両方。`bundler-cache: true` による bundle install は `run:` 行に現れない。
- **matrix:** 0。
- **cwd:** Ruby 系の job default は `web`。test の uv sync だけ `${{ github.workspace }}` で root に戻る。command 文字列だけを一律 root または一律 `web` で動かすと一致しない。
- **shell expressions:** 明示 shell はない。lint cache に `hashFiles(...)`、`runner.os`、env、branch/run ID 条件式、test/artifact path に `${{ github.workspace }}` がある。検証 command 本体には秘密式や matrix 値はない。
- **system test driver:** test group は Capybara と Selenium を含む（[Gemfile](https://github.com/qorraq/qorraq-prototype/blob/072ba89945a04de7b44137756050e8861cdecdfe/web/Gemfile)）が、この revision の system test は `rack_test` driver を指定する（[application_system_test_case.rb](https://github.com/qorraq/qorraq-prototype/blob/072ba89945a04de7b44137756050e8861cdecdfe/web/test/application_system_test_case.rb)）。したがって、この system test の実行前提に browser は含まれない。失敗時 artifact upload は検証後の観測処理である。

Ruby 3.4.7（[web/.ruby-version](https://github.com/qorraq/qorraq-prototype/blob/072ba89945a04de7b44137756050e8861cdecdfe/web/.ruby-version)）、Python 3.13、uv、bundle 済み gems、SQLite、`CI=true`、各 cwd/env を用意すれば、表のコマンド文字列自体は変更不要である。未準備のローカル環境へ `run` 行だけを抽出しても動かず、とくに bundle install と `CI=true` は `run:` 行に現れない。

## マニフェスト等から推論できること

| 情報源 | 分かること | それだけでは分からないこと | 今回の事実 |
|---|---|---|---|
| `package.json` | script 名・本文・参照関係、package 依存、記載時は engines | どの script が CI 必須か、cwd/env/service、OS package、未記載 runtime version | deadloop は `check` に集約。qorraq root の `docs:list` / `test:e2e` / `test:e2e:gauge` は CI 6 job から呼ばれない（[package.json](https://github.com/qorraq/qorraq-prototype/blob/072ba89945a04de7b44137756050e8861cdecdfe/package.json)） |
| `Gemfile` / lock | gems、groups、platform、version 制約/解決版 | test/lint command、CI 採用 task、DB 初期化順、env/service | Rails/SQLite/Brakeman/RuboCop/Selenium の存在は分かるが、`db:test:prepare test` は workflow から得る |
| `Rakefile` / `.rake` | 静的 task 定義の名前・依存・recipe。実行すればロード後 task を列挙可能 | 動的 load なしの完全列挙、どの task が CI 必須か | qorraq は application を require し `Rails.application.load_tasks` するだけ（[Rakefile](https://github.com/qorraq/qorraq-prototype/blob/072ba89945a04de7b44137756050e8861cdecdfe/web/Rakefile)） |
| `pyproject.toml` | Python 範囲、依存 group/extra、tool 対象・設定、project scripts、tox task があればその command | CI がどの tool/extra を何順で使うか、uv/pip/tox の選択、service/env | root は Ruff/Mypy/Vulture の対象、[CLI pyproject](https://github.com/qorraq/qorraq-prototype/blob/072ba89945a04de7b44137756050e8861cdecdfe/cli/pyproject.toml) は pytest extra/testpaths を示すが、uv flags・unittest 併用・順序は workflow にしかない |
| `Makefile` 等 | target、依存 target、recipe（変数/include/条件評価が必要な場合あり） | 慣例名 `test`/`check` が CI 必須か、外部前提 | 今回 2 repo の CI は Makefile を入口にしない |
| lock/version file | 解決版、対応 runtime version | 実行すべき検証、順序、cwd/env | qorraq Ruby は version file、Python は action 入力。deadloop Node 22 も action 入力 |
| `bin/*` | 内容まで解析すれば wrapper 処理 | 名前だけでは CI 採用可否や副作用 | qorraq は workflow が `bin/importmap` 等を明示するため入口だと確定 |

設定は相補的である。たとえば `[tool.mypy] files` は対象範囲を示すが、Mypy が必須という事実は workflow の `uv run mypy` が与える。逆に command だけでは実際の対象 path や lint rule は分からない。

## 比較表

| 観点 | deadloop | qorraq-prototype |
|---|---:|---:|
| jobs | 1 | 6 |
| run steps / 個別 commands | 2 / 2 | 12 / 14 |
| 集約入口 | `npm run check` | 単一入口なし |
| cwd | root | root と `web`、step override 1 |
| 検証 `run` step に明示された env | 0 | 2 種 |
| GitHub-hosted runner の暗黙 env | `CI=true` | `CI=true` |
| services / secrets / matrix | 0 / 0 / 0 | 0 / 0 / 0 |
| DB 操作 | 0 | Rails 2 jobs で SQLite prepare |
| setup action に隠れる準備 | Node 導入 | runtime 導入、Bundler install |
| ローカルで文字列を無変更実行 | setup + `CI=true` 後に可能 | setup + cwd/env + `CI=true` 復元後に可能。抽出行だけでは不可 |

## 残る不確実性

1. `ubuntu-latest` の同梱 tool / OS library は YAML に完全列挙されず、内容も将来固定ではない。
2. action の挙動は参照先実装にある。今回の `@v1` / `@v4` / `@v7` 等は commit SHA 固定でない。
3. script/task は任意コードを実行でき、静的解析だけで runtime 分岐、ネットワーク、生成物、子 process を完全確定できない。
4. secret 名や式は検出できても値は取れず、event による提供可否も実行 context 依存。
5. 「CI 記載 command」と「変更に必要十分なローカル検証」は別である。本調査は前者だけを扱い、選定方針を決めない。

## Sources

- Kept: [deadloop CI](https://github.com/yasuhito/deadloop/blob/2a07e544a5d37f6ad4672001281036ed17f6ad0b/.github/workflows/ci.yml) / [package.json](https://github.com/yasuhito/deadloop/blob/2a07e544a5d37f6ad4672001281036ed17f6ad0b/package.json) — commit-pinned primary source
- Kept: qorraq-prototype の上記 commit-pinned workflow/manifests — 6 job、cwd/env/DB の primary source（権限必要）
- Kept: GitHub の workflow syntax、contexts、expressions、services、secrets 公式資料 — Actions の実行意味
- Dropped: ブログ・CI command 推測記事 — primary source より根拠が弱い
- Dropped: 任意 OSS 例 — 必須 2 repo の全依存列挙を優先

## Gaps

実際のローカル実行試験は行っていない。「無変更実行可能」は記載された前提を満たす場合の構文・依存分析である。runner の暗黙依存を厳密に固定するには、対象 run の image release、各 action の解決 SHA/source、実行ログも保存する必要がある。qorraq の固定リンクの第三者検証には閲覧権限が必要である。
