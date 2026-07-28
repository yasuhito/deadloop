# Symphony / Sandcastle の自動コメント言語調査

- 調査日: 2026-07-14
- 対象: [`openai/symphony`](https://github.com/openai/symphony/tree/4cbe3a9699a73b862466c0b157ceca0c1985d6d7)、[`mattpocock/sandcastle`](https://github.com/mattpocock/sandcastle/tree/e99f832f26dc9d245c019a9ddd19fa5dee792427)
- 背景: [deadloop PR #132](https://github.com/yasuhito/deadloop/pull/132)

## 結論

調査した版の Symphony と Sandcastle には、公開コメント用の明示的な言語・ロケール設定も、Issue / PR の本文から言語を自動判定する仕組みもない。どちらも英語のプロンプトや定型文が出力を暗黙に英語へ寄せる一方、Issue / PR の本文をモデルへ渡すため、モデルが入力言語へ偶然追随する余地はある。

| 対象 | 明示的な言語設定 | 入力からの自動判定 | プロンプトによる暗黙の傾向 | 保証された言語選択 |
|---|---:|---:|---:|---:|
| Symphony | なし | なし | あり（参照 `WORKFLOW.md` は英語） | なし |
| Sandcastle | なし | なし | あり（同梱テンプレートと定型文は英語） | なし |

したがって、両者とも「入力本文と同じ言語で返す」ことを製品の契約にはしていない。

## Symphony

Symphony core はスケジューラ、runner、tracker reader であり、コメント投稿などの業務処理は coding agent とリポジトリ所有の workflow prompt に委ねる。設定スキーマには tracker、polling、workspace、hooks、agent、Codex 等があるが、language / locale はない。[SPEC: responsibility boundary](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L24-L58) [SPEC: configuration](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/SPEC.md#L293-L419) [Elixir configuration schema](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/config/schema.ex#L35-L231)

`PromptBuilder` は attempt と正規化済み Issue をテンプレートへ渡すだけで、言語判定や locale の導出を挟まない。Issue モデルにも title、description、state、labels 等はあるが locale はない。日本語本文はモデルへの材料にはなるものの、「日本語で返す」という決定論的契約にはならない。[PromptBuilder](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/prompt_builder.ex#L8-L25) [Issue model](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/lib/symphony_elixir/linear/issue.ex#L6-L42)

参照 `WORKFLOW.md` は英語で、workpad、blocker brief、review reply 等の公開文を英語の見出しと指示で生成する。ただし Markdown 本文が per-issue prompt template なので、利用リポジトリが「公開文は日本語で」と追加することはできる。これは locale 機能ではなく、プロンプトによるリポジトリ方針である。[Reference workflow](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L40-L105) [Public comment instructions](https://github.com/openai/symphony/blob/4cbe3a9699a73b862466c0b157ceca0c1985d6d7/elixir/WORKFLOW.md#L305-L340)

## Sandcastle

Sandcastle は任意のプロンプトを agent に渡す汎用実行器である。公開 API は `promptFile` / `prompt` と `promptArgs` を提供するが、language / locale は提供しない。同梱 simple-loop も、遮断時の Issue コメントや完了説明を英語で指示する。[README: API](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/README.md#L62-L91) [Simple-loop prompt](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/src/templates/simple-loop/prompt.md#L1-L55)

同リポジトリの自動化例は、`gh issue view … --comments` の結果や PR diff、コメントを英語プロンプトへ差し込む。モデルの summary、inline comment、reply を構造検証して GitHub payload へ移すが、言語を検出・変換する処理はない。[Implementation workflow](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.sandcastle/agent-workflows/implement/implement.ts#L9-L27) [Review prompt](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.sandcastle/agent-workflows/review/prompt.md#L1-L44) [Review workflow](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.sandcastle/agent-workflows/review/review.ts#L23-L68) [Review output](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.sandcastle/agent-workflows/shared/review-output.ts#L47-L81)

決定論的な公開文も英語固定である。実装 workflow は拒否・失敗コメントと PR 本文を英語で組み立て、PR title だけ `Fix #N: ${ISSUE_TITLE}` とする。そのため日本語 Issue では、タイトルの一部だけが日本語で本文が英語になる可能性がある。[Implementation GitHub workflow](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement.yml#L45-L66) [PR creation and comments](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-implement.yml#L154-L184) [Review GitHub workflow](https://github.com/mattpocock/sandcastle/blob/e99f832f26dc9d245c019a9ddd19fa5dee792427/.github/workflows/agent-review.yml#L70-L97)

## deadloop PR #132 との対応

PR #132 は title / description が日本語なのに、自動投稿は英語の修復開始文、日本語または英語のレビュー、英語の修復完了文が混在している。[日本語レビュー例](https://github.com/yasuhito/deadloop/pull/132#issuecomment-4965630782) [英語レビュー例](https://github.com/yasuhito/deadloop/pull/132#issuecomment-4965791983)

これは入力言語から一貫した出力言語が自然に決まらないことを示す。モデル生成文だけでなく、TypeScript が組み立てる固定文にも同じ言語方針を適用する必要がある。

## deadloop への選択肢

### 推奨: 明示設定を主、限定的な自動判定を補助にする

`deadloop.json` の信頼済みリポジトリ設定に、例えば `publicTextLanguage: "ja" | "en" | "auto"` を置く。

- `ja` / `en`: agent の自由文と決定論的な固定文の双方へ適用する。
- `auto`: PR を扱う場合は PR title/body、Issue を扱う場合は Issue title/body を決定論的な関数で判定し、曖昧または混在ならリポジトリ既定へ戻す。
- 既定値: 公開パッケージとしては `en` が後方互換性を保ちやすい。日本語中心のリポジトリは `ja` を明示する。

明示設定は予測可能でテストしやすい。`auto` は利便性があるが、短文、コード断片、混在スレッド、最新コメントとの不一致について優先順位を仕様化する必要がある。

### 軽量案: プロンプトだけに言語指示を加える

全公開文生成プロンプトへ「Issue / PR とコメントへ投稿する文は日本語」のような共通指示を注入する。変更量は小さいが、固定英語文字列は別途直す必要があり、モデル逸脱も決定論的には防げない。

### 非推奨: モデルの自然な言語追随だけに依存する

Symphony と Sandcastle の双方に保証がなく、PR #132 でも実際に揺れている。英語のプロンプト、固定文、セッションごとの差によって簡単に混在する。

## 実装時の設計上の注意

- 言語の選択は LLM ではなく TypeScript の純粋関数で決め、選択済み言語だけをプロンプトへ渡す。
- 修復開始、レビュー結果、修復完了、失敗・遮断、PR 本文を一つの公開文言語契約に含める。
- 言語別の固定文は散在させず、公開コメント描画の境界へ集約する。
- fixture / snapshot で、同じイベント群が選択言語に統一されることを検証する。

## 限界

本稿の結論は上記固定 commit の公開された orchestrator、設定、テンプレート、workflow に限定する。各 agent provider のモデルが入力言語へ自然追随する確率は非決定的で、一次資料から保証・測定できない。
