# Cucumber Markdown と JavaScript 実行環境の制約

調査日: 2026-07-14  
対象: deadloop Issue [#103](https://github.com/yasuhito/deadloop/issues/103)（親課題 [#102](https://github.com/yasuhito/deadloop/issues/102)）

## 結論

Cucumber-JS の Markdown with Gherkin（以下 MDG）は、`.feature.md`、Markdown 見出し形式の Gherkin 要素、箇条書き形式のステップ、日本語方言、TypeScript のステップ定義という組合せを公式実装で実行できる。Cucumber-JS は既定でも `features/**/*.{feature,feature.md}` を探索するため、**制約を明文化し、依存版を固定し、実際の組合せを試作で固定化するなら**、Issue #102 が求める実行可能な受け入れ仕様の正本に採用できる。[Cucumber-JS configuration](https://github.com/cucumber/cucumber-js/blob/main/docs/configuration.md#finding-your-features) [Gherkin MDG specification](https://github.com/cucumber/gherkin/blob/main/MARKDOWN_WITH_GHERKIN.md)

ただし、次の二点は正本の設計を左右する。

1. MDG 内の通常の説明文は人間が Markdown として読める一方、パーサーは認識しない行を `Empty` として扱い、AST の `description` を空にする。説明文を実行結果、Messages、JSON などから構造化して回収する設計にはできない。[MDG parsing notes](https://github.com/cucumber/gherkin/blob/main/MARKDOWN_WITH_GHERKIN.md#some-notes-about-parsing-mdg) [matcher source](https://github.com/cucumber/gherkin/blob/main/javascript/src/GherkinInMarkdownTokenMatcher.ts)
2. YAML フロントマターは MDG の公式仕様に定義されていない。しかも明示的な Feature 見出しがないと「文書の最初の行」を Feature 名にするため、先頭の `---` はメタデータ境界ではなく Feature 名になり得る。**フロントマターを正本の規約には採用しない**のが安全である。[MDG feature rule](https://github.com/cucumber/gherkin/blob/main/MARKDOWN_WITH_GHERKIN.md#markdown-with-gherkin) [matcher `match_FeatureLine`](https://github.com/cucumber/gherkin/blob/main/javascript/src/GherkinInMarkdownTokenMatcher.ts#L128-L151)

## 調査結果

### 1. Markdown 形式

**公式に扱える。** MDG は GFM の厳密な上位集合として文書化され、ファイル名は `.feature.md` でなければならない。Cucumber-JS 7.3.0 で「experimental support」として追加され、現在の Cucumber-JS 13.0.0 は `@cucumber/gherkin` 41.0.0 に依存し、既定探索パターンにも `.feature.md` を含めている。[MDG specification](https://github.com/cucumber/gherkin/blob/main/MARKDOWN_WITH_GHERKIN.md) [Cucumber-JS 7.3.0 release](https://github.com/cucumber/cucumber-js/releases/tag/v7.3.0) [Cucumber-JS 13 package manifest](https://github.com/cucumber/cucumber-js/blob/v13.0.0/package.json) [path resolver source](https://github.com/cucumber/cucumber-js/blob/main/src/paths/paths.ts#L58-L78)

MDG 固有の構文制約は次のとおりである。

- Feature、Rule、Background、Scenario、Scenario Outline、Examples は、翻訳されたキーワードも含め、1 個以上の `#` を前置した Markdown 見出しにする。
- Given、When、Then、And、But は `*` または `-` を前置した箇条書きにする。現行 JavaScript 実装は CommonMark の箇条書き記号として `+` も認識し、公式単体テストもあるが、仕様文とのずれを避けるため deadloop では `*` に統一する。
- Data Table と Examples の表は GFM 表で、Gherkin の表として認識させるには 2〜5 空白で字下げする。
- Doc String は fenced code block、タグは `` `@tag` `` の形で対象要素の直前に置く。

根拠: [MDG parsing rules](https://github.com/cucumber/gherkin/blob/main/MARKDOWN_WITH_GHERKIN.md#markdown-with-gherkin)、[JavaScript matcher tests](https://github.com/cucumber/gherkin/blob/main/javascript/test/GherkinInMarkdownTokenMatcherTest.ts)、[Markdown support commit](https://github.com/cucumber/cucumber-js/commit/913d843261efe7b6af68515e3fe4168eb83cd568)

**判断:** 受け入れ仕様の正本として採用可能。ただし `.md` ではなく `.feature.md` に限定し、見出し、箇条書き、表の字下げを CI で実行確認する。通常の Markdown の見出しや箇条書きが翻訳済み Gherkin キーワードの形に偶然一致すると構文として認識されるため、実行対象ファイルでは自由記述の書式にも注意が必要である。[matcher regular expressions](https://github.com/cucumber/gherkin/blob/main/javascript/src/GherkinInMarkdownTokenMatcher.ts)

### 2. 説明文

**表示用 Markdown としては扱えるが、Gherkin の構造化された説明文としては扱えない。** 公式 MDG 文書は「認識されない全行を `Empty` とみなす」「そのため `GherkinDocument` AST の description は空で、JSON formatter に Scenario の description は出ない」と明記する。[MDG parsing notes](https://github.com/cucumber/gherkin/blob/main/MARKDOWN_WITH_GHERKIN.md#some-notes-about-parsing-mdg)

これは「説明を書けない」という意味ではない。ソース `.feature.md` は通常の GFM として閲覧でき、`@cucumber/react` の MDG component は元の Markdown と実行結果を組み合わせて描画できると公式文書にある。ただし Issue #102 は別レポート生成を対象外としているため、deadloop では GitHub 上の原文を正本として読み、説明文を AST やレポートから再生成しないのが最小で安全である。[MDG rendering](https://github.com/cucumber/gherkin/blob/main/MARKDOWN_WITH_GHERKIN.md#rendering-mdg-with-results) [Issue #102](https://github.com/yasuhito/deadloop/issues/102)

**判断:** Feature/Rule/Scenario の意図や安全上の注記は Markdown 本文に書いてよいが、それらがテスト実行・機械検査へ伝わるとはみなさない。機械判定が必要な情報は Scenario、Step、Tag、設定ファイルのいずれかに置く。説明文の存在や内容を Cucumber Messages/JSON で検査する要件は設けない。

### 3. フロントマター

**公式対応を確認できないため不採用とする。** MDG 仕様は GFM 上位集合、Gherkin 構文、タグ、表、Doc String を規定するが、YAML/TOML フロントマターの構文・値・保持・出力を規定していない。[MDG specification](https://github.com/cucumber/gherkin/blob/main/MARKDOWN_WITH_GHERKIN.md)

さらに JavaScript matcher は最初に明示的な Feature 見出しを認識できなければ、その最初の行自体を FeatureLine として採用する。したがって、例えば先頭の `---` は YAML の開始として解釈される保証がなく、Feature 名 `---` になり得る。残りの非 Gherkin 行も metadata として保持されず、単に空行相当にされる。[matcher source](https://github.com/cucumber/gherkin/blob/main/javascript/src/GherkinInMarkdownTokenMatcher.ts#L128-L151) [empty-line handling](https://github.com/cucumber/gherkin/blob/main/javascript/src/GherkinInMarkdownTokenMatcher.ts#L75-L108)

**判断:** 正本にフロントマターを置かない。分類には公式の Tag、所有・補足情報には通常の Markdown 本文、機械が必要とする設定には既存の決定論的な設定を使う。将来必要になった場合も、Cucumber の機能と称さず、deadloop 独自の事前処理として別途設計・テストする。

### 4. 日本語 Gherkin

**公式に扱えるが、MDG では言語指定が文書単位ではなく実行全体の設定になる。** Gherkin はキーワードの多言語翻訳を公式に提供し、日本語 `ja` も公式 dialect データに含まれる。[Cucumber localisation](https://cucumber.io/docs/gherkin/languages) [official dialect data](https://github.com/cucumber/gherkin/blob/main/gherkin-languages.json)

MDG matcher は選択された dialect の Feature/Scenario/Step 等の翻訳から正規表現を作るため、日本語キーワードも Markdown 見出し・箇条書きとして認識できる。一方、ソースには「Markdown では `# language: ...` ヘッダーを意図的にサポートせず、Cucumber-JS の `--language` で全体指定する」と明記される。Cucumber-JS の既定言語は `en` である。[matcher constructor and language decision](https://github.com/cucumber/gherkin/blob/main/javascript/src/GherkinInMarkdownTokenMatcher.ts#L25-L74) [configuration `language`](https://github.com/cucumber/cucumber-js/blob/main/docs/configuration.md#options)

**判断:** 試験導入では `language: 'ja'` を Cucumber 設定に必須指定する。`.feature.md` に `# language: ja` は書かない。Issue #102 の「最初は日本語、後に全面英語化」は、同一実行内の暗黙の混在ではなく、設定の `ja` から `en` への明示的切替として行う。英語化移行中に両方を同時実行する必要が生じた場合は、プロファイルまたは実行を分ける設計を先に試作する。

### 5. TypeScript のステップ定義

**公式に扱えるが、Cucumber が TypeScript を直接実行するのではなく JIT 変換器を登録する。** 公式 Cucumber-JS 文書は `tsx` を推奨する。CommonJS では `requireModule: ['tsx/cjs']` と `require: ['…/**/*.ts']`、ESM では登録用ファイルと `import` を使う。[Cucumber-JS transpiling guide](https://github.com/cucumber/cucumber-js/blob/main/docs/transpiling.md)

現行 deadloop は `package.json` の `type` が `commonjs`、TypeScript 6.0 系、`tsconfig.json` が `module`/`moduleResolution: Node16` なので、最小構成は CommonJS 手順の `tsx/cjs` である。Cucumber-JS 13.0.0 自身も TypeScript 6 と `tsx` を開発に用いるが、これは deadloop の組合せ互換性を保証するものではないため試作が必要である。[Cucumber-JS v13 manifest](https://github.com/cucumber/cucumber-js/blob/v13.0.0/package.json) [deadloop package.json](../../package.json) [deadloop tsconfig.json](../../tsconfig.json)

Cucumber-JS 13.0.0 が対応する Node は `22 || 24 || >=26` で、Node 20 と 25 は対象外になった。deadloop CI は Node 22 なので現状は対応範囲内である。[v13 release](https://github.com/cucumber/cucumber-js/releases/tag/v13.0.0) [v13 engines](https://github.com/cucumber/cucumber-js/blob/v13.0.0/package.json#L121-L127) [deadloop CI](../../.github/workflows/ci.yml)

**判断:** `@cucumber/cucumber` と `tsx` を開発依存に固定し、CommonJS の公式例から始める。TypeScript のステップ定義は既定の自動探索対象（JS/CJS/MJS）ではないため、`require` glob を明示しなければならない。[support-code path rules](https://github.com/cucumber/cucumber-js/blob/main/docs/configuration.md#finding-your-code) [path resolver source](https://github.com/cucumber/cucumber-js/blob/main/src/paths/paths.ts#L104-L125)

## deadloop への含意

### 現行構成との適合

- `package.json` は CommonJS、CI は Node 22 であり、Cucumber-JS 13 + `tsx/cjs` の公式対応範囲に入る。
- 現在の `npm test` は `vitest run` のみである。Issue #102 の方針どおり、小関数、実装詳細、静的ファイル検査は Vitest に残し、公開仕様、状態遷移、安全契約だけを Cucumber へ段階移行する。[Issue #102](https://github.com/yasuhito/deadloop/issues/102)
- 導入時は Cucumber 用スクリプトを追加し、最終的に `npm run check` が Vitest と Cucumber の双方を必ず実行するようにする必要がある。試作段階では既存 `npm test` の意味を不用意に変えず、独立コマンドで再現性を確認してから統合する。
- `package.json` の公開対象は `docs/*.md` であり、現在の `docs/research/*.md` は npm package へ含まれる保証がない。この調査資料はリポジトリ内の判断記録であり、将来公開パッケージにも含めるなら別 Issue で `files` を見直すべきである。[deadloop package.json](../../package.json)
- Issue #102 の「1 シナリオ・1 Then・1観測結果・1 assertion」は Cucumber 自体の制約ではない。シナリオ原文の静的検査と、ステップ定義のレビュー/規約を deadloop 側で設計する必要がある。とくに MDG の通常説明文は AST に残らないため、構文規約の検査対象は Pickle/AST だけで足りるかを試作で確かめる。

### 安全な採用条件

以下を満たすまでは「全面移行可能」と判断しない。

1. `@cucumber/cucumber` と `tsx` を lockfile で固定し、Node 22 の CI で再現する。
2. 対象を `.feature.md` に限定し、設定で `language: 'ja'` を明示する。
3. フロントマターを禁止し、説明文はソース閲覧用で機械可読ではないと規約化する。
4. 既存の決定論的な fixture/helper を TypeScript step から呼び、Cucumber 導入のために製品コードや安全境界を複製しない。
5. undefined、ambiguous、pending、parse error、実 assertion failure の全てで CI が非 0 終了することを確認する（既定 `strict` は `true`）。[configuration options](https://github.com/cucumber/cucumber-js/blob/main/docs/configuration.md#options)
6. Markdown 原文を唯一の受け入れ仕様とし、README 等には転載せずリンクするという Issue #102 の方針を維持する。

## 推奨する最小試作

実装用の後続 Issue では、次だけを一つの小さな試作として追加する。

1. **依存と実行環境**: Node 22、`@cucumber/cucumber` 13.x（試作時の正確な版を lock）、`tsx` 4.x、現行 TypeScript 6.x、CommonJS。
2. **設定**: CommonJS の `cucumber.cjs` で `paths` を試作ファイル一つに限定し、`language: 'ja'`、`requireModule: ['tsx/cjs']`、TypeScript step の `require` glob、`strict: true` を明示する。
3. **仕様ファイル**: `*.feature.md` 一つ。先頭を明示的な日本語 Feature 見出しにし、短い通常 Markdown 説明、Rule、Scenario、`*` 箇条書きの日本語 Given/When/Then を含める。フロントマター、表、Doc String、Scenario Outline、並列実行は最初の試作に入れない。
4. **シナリオ**: Issue coordinator の公開状態遷移または安全停止条件から、副作用を伴わない代表例を一つだけ選ぶ。1 Scenario、1 Then、1観測結果、step 内 1 assertion とし、既存の決定論的関数を呼ぶ。
5. **否定確認**: 同じ fixture を使い、(a) 正常成功、(b) assertion の意図的失敗、(c) 未定義 step、(d) `language: 'ja'` を外した場合の parse failure、(e) `.feature.md` の自動探索、(f) TypeScript source map による失敗位置、をそれぞれ独立に観測する。
6. **説明文の確認**: ソースは GitHub で意図どおり描画されること、Cucumber の Messages/JSON では description が空であることを確認し、後者に依存する機能を作らない。
7. **統合判断**: 試作が安定した後だけ Cucumber を `npm run check` に組み込み、`npm test` との責務分担を決める。既存 Vitest の移行や日本語全面移行はこの試作に含めない。

表と Doc String は公式対応だが、Issue #102 の初回目的に不要で、字下げ・fence の規則を増やす。必要な受け入れ例が現れた時点で、それぞれ一機能ずつ独立した試作を追加する方が安全である。

## 確認できない点・残余リスク

- **中:** MDG は 7.3.0 の導入時に experimental と明記されたが、現行 13.0.0 のリリース情報や MDG 文書には、JavaScript 版について安定化を宣言した明確な記述を確認できなかった。長期互換性は通常の `.feature` より慎重に扱い、版更新時に日本語 MDG の回帰試験を必須にする。[v7.3.0 release](https://github.com/cucumber/cucumber-js/releases/tag/v7.3.0) [v13.0.0 release](https://github.com/cucumber/cucumber-js/releases/tag/v13.0.0)
- **中:** 公式 matcher テストではフランス語 MDG を確認できるが、日本語 MDG を Cucumber-JS、Node 22、tsx、deadloop の現行設定で端から端まで実行する一次資料は確認できなかった。dialect データと実装上は対応するが、上記試作を採用条件にする。[matcher test](https://github.com/cucumber/gherkin/blob/main/javascript/test/GherkinInMarkdownTokenMatcherTest.ts) [dialect data](https://github.com/cucumber/gherkin/blob/main/gherkin-languages.json)
- **中:** フロントマターは仕様外であり、現行実装で一見実行できても metadata の意味・保持・互換性は保証されない。禁止が最も安全である。
- **低:** `main` ブランチの公式文書は未リリース機能を含み得ると明記される。実装時は採用した Cucumber-JS tag の文書・依存版・lockfile を基準に再確認する。[configuration warning](https://github.com/cucumber/cucumber-js/blob/main/docs/configuration.md#configuration)
- **低:** MDG の説明文は AST に残らないため、将来 formatter や仕様索引を追加すると期待とのずれが生じる。原文リンクを正とする限り、現行 Issue #102 の範囲では阻害しない。

## 採否

**条件付き採用を推奨する。** 正本は日本語 `.feature.md`、言語は設定で `ja`、ステップ定義は CommonJS + `tsx/cjs` の TypeScript、説明文は原文閲覧専用、フロントマターは禁止、とする。この境界なら Issue #102 の試験導入へ進める。日本語 MDG の端から端の試作と失敗時の CI 終了確認を通過するまでは、全面移行を承認しない。

## 主な一次資料

- [Cucumber Gherkin: Markdown with Gherkin](https://github.com/cucumber/gherkin/blob/main/MARKDOWN_WITH_GHERKIN.md)
- [Gherkin JavaScript Markdown matcher source](https://github.com/cucumber/gherkin/blob/main/javascript/src/GherkinInMarkdownTokenMatcher.ts)
- [Gherkin JavaScript Markdown matcher tests](https://github.com/cucumber/gherkin/blob/main/javascript/test/GherkinInMarkdownTokenMatcherTest.ts)
- [Cucumber-JS configuration](https://github.com/cucumber/cucumber-js/blob/main/docs/configuration.md)
- [Cucumber-JS transpiling](https://github.com/cucumber/cucumber-js/blob/main/docs/transpiling.md)
- [Cucumber-JS 13.0.0 release](https://github.com/cucumber/cucumber-js/releases/tag/v13.0.0)
- [Cucumber-JS 13.0.0 package manifest](https://github.com/cucumber/cucumber-js/blob/v13.0.0/package.json)
- [Cucumber localisation](https://cucumber.io/docs/gherkin/languages)
