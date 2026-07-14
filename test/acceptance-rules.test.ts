import { describe, expect, it } from "vitest";

import { checkAcceptanceRules, type AcceptanceSource } from "../src/check-acceptance-rules";

const validFeature = `# 機能: 安全な検証

追跡ファイルを隠さないことを保証する。

## シナリオ: 追跡ファイルがある場合は検証を拒否する

* 前提 実行用ディレクトリに追跡ファイルがある
* もし 通常検証を開始する
* ならば 検証は安全のため拒否される
`;

const validSteps = `
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
Given("実行用ディレクトリに追跡ファイルがある", function () { this.tracked = true; });
When("通常検証を開始する", function () { this.code = 1; });
Then("検証は安全のため拒否される", function () { assert.equal(this.code, 1); });
`;

function sources(overrides: Partial<AcceptanceSource> = {}): AcceptanceSource {
  return {
    config: {
      path: "cucumber.cjs",
      source:
        "module.exports = { default: { paths: ['acceptance/features/**/*.feature.md'], requireModule: ['tsx/cjs'], require: ['acceptance/steps/**/*.ts', 'acceptance/support/**/*.ts'], language: 'ja', strict: true } };",
    },
    features: [{ path: "acceptance/features/safety.feature.md", source: validFeature }],
    stepDefinitions: [{ path: "acceptance/steps/safety.steps.ts", source: validSteps }],
    helpers: [],
    ...overrides,
  };
}

describe("acceptance test rules", () => {
  it("accepts one Japanese scenario with one result and one assertion", () => {
    expect(checkAcceptanceRules(sources())).toEqual([]);
  });

  it("rejects front matter", () => {
    expect(
      checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source: `---\n${validFeature}` }] })),
    ).toContain("bad.feature.md: front matter is not allowed");
  });

  it("rejects TOML front matter", () => {
    expect(
      checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source: `+++\n${validFeature}` }] })),
    ).toContain("bad.feature.md: front matter is not allowed");
  });

  it("rejects a language directive", () => {
    expect(
      checkAcceptanceRules(sources({
        features: [{ path: "bad.feature.md", source: `# language: ja\n${validFeature}` }],
      })),
    ).toContain("bad.feature.md:1: language directives are not allowed");
  });

  it("rejects a language directive after the Feature description", () => {
    const source = validFeature.replace(
      "追跡ファイルを隠さないことを保証する。",
      "追跡ファイルを隠さないことを保証する。\n\n# language: ja",
    );
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:5: language directives are not allowed",
    );
  });

  it("rejects prose before the Feature heading", () => {
    expect(
      checkAcceptanceRules(sources({
        features: [{ path: "bad.feature.md", source: `前置きの説明\n\n${validFeature}` }],
      })),
    ).toContain("bad.feature.md:1: file must start with an explicit Feature heading");
  });

  it("rejects hyphen Step bullets", () => {
    const source = validFeature.replaceAll(/^\* /gm, "- ");
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:7: Step bullets must use '*' (found '-')",
    );
  });

  it("rejects plus Step bullets", () => {
    const source = validFeature.replaceAll(/^\* /gm, "+ ");
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:7: Step bullets must use '*' (found '+')",
    );
  });

  it("rejects a scenario with two result steps", () => {
    const source = validFeature.replace(
      "* ならば 検証は安全のため拒否される",
      "* ならば 検証は安全のため拒否される\n* ならば コマンドは実行されない",
    );
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:5: scenario must contain exactly one result step (found 2)",
    );
  });

  it("counts a Feature Background result in each scenario", () => {
    const source = validFeature.replace(
      "## シナリオ:",
      "## 背景:\n\n* ならば 共通の結果がある\n\n## シナリオ:",
    );
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:9: scenario must contain exactly one result step (found 2)",
    );
  });

  it("counts a Rule Background result in each scenario", () => {
    const source = validFeature.replace(
      "## シナリオ:",
      "## ルール: 安全規則\n\n### 背景:\n\n* ならば 共通の結果がある\n\n### シナリオ:",
    );
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:11: scenario must contain exactly one result step (found 2)",
    );
  });

  it("rejects And after Then", () => {
    const source = validFeature.replace(
      "* ならば 検証は安全のため拒否される",
      "* ならば 検証は安全のため拒否される\n* かつ コマンドは実行されない",
    );
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:10: And/But after Then is not allowed",
    );
  });

  it("rejects a Then definition without an assertion", () => {
    const source = validSteps.replace("assert.equal(this.code, 1);", "this.observed = this.code;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: Then step definition must contain exactly one direct assertion (found 0)",
    );
  });

  it("rejects a Then definition with two assertions", () => {
    const source = validSteps.replace(
      "assert.equal(this.code, 1);",
      "assert.equal(this.code, 1); assert.ok(this.tracked);",
    );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: Then step definition must contain exactly one direct assertion (found 2)",
    );
  });

  it("counts element-access assertions when rejecting two assertions in Then", () => {
    const source = validSteps.replace(
      "assert.equal(this.code, 1);",
      'assert["equal"](this.code, 1); assert.equal(this.code, 1);',
    );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: Then step definition must contain exactly one direct assertion (found 2)",
    );
  });

  it("rejects an assertion in a Given definition", () => {
    const source = validSteps.replace("this.tracked = true;", "assert.ok(true); this.tracked = true;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: Given step definition must not contain assertions",
    );
  });

  it("counts an imported expect matcher as one assertion", () => {
    const source = validSteps
      .replace('import assert from "node:assert/strict";', 'import { expect } from "vitest";')
      .replace("assert.equal(this.code, 1);", "expect(this.code).toBe(1);");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "expect.steps.ts", source }] }))).toEqual([]);
  });

  it("does not treat an unbound expect name as an assertion", () => {
    const source = validSteps.replace("assert.equal(this.code, 1);", "expect(this.code);");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: Then step definition must contain exactly one direct assertion (found 0)",
    );
  });

  it("rejects assertions for an aliased CommonJS Given binding", () => {
    const source = `
const assert = require("node:assert/strict");
const { Given: setup, When, Then } = require("@cucumber/cucumber");
setup("前提", function () { assert.ok(true); });
When("操作", function () { this.code = 1; });
Then("結果", function () { assert.equal(this.code, 1); });
`;
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: Given step definition must not contain assertions",
    );
  });

  it("rejects missing assertions for an aliased CommonJS Then binding", () => {
    const source = `
const assert = require("node:assert/strict");
const { Given, When, Then: outcome } = require("@cucumber/cucumber");
Given("前提", function () { this.tracked = true; });
When("操作", function () { this.code = 1; });
outcome("結果", function () { this.observed = this.code; });
`;
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: Then step definition must contain exactly one direct assertion (found 0)",
    );
  });

  it("rejects an assertion in an aliased When definition", () => {
    const source = validSteps
      .replace("Given, Then, When", "Given, Then, When as action")
      .replace(
        'When("通常検証を開始する", function () { this.code = 1; });',
        'action("通常検証を開始する", function () { assert.ok(true); this.code = 1; });',
      );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:5: When step definition must not contain assertions",
    );
  });

  it("rejects an aliased Then definition without an assertion", () => {
    const source = validSteps
      .replace("Given, Then, When", "Given, Then as outcome, When")
      .replace(
        'Then("検証は安全のため拒否される", function () { assert.equal(this.code, 1); });',
        'outcome("検証は安全のため拒否される", function () { this.observed = this.code; });',
      );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: Then step definition must contain exactly one direct assertion (found 0)",
    );
  });

  it("rejects an aliased defineStep definition without an assertion", () => {
    const source = validSteps
      .replace("Given, Then, When", "Given, defineStep as step, When")
      .replace(
        'Then("検証は安全のため拒否される", function () { assert.equal(this.code, 1); });',
        'step("検証は安全のため拒否される", function () { this.observed = this.code; });',
      );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: defineStep is not allowed; use Given, When, or Then",
    );
  });

  it("rejects an assertion in an acceptance helper", () => {
    const helpers = [
      { path: "acceptance/support/helper.ts", source: 'import assert from "node:assert/strict"; assert.ok(true);' },
    ];
    expect(checkAcceptanceRules(sources({ helpers }))).toContain(
      "acceptance/support/helper.ts: assertions are not allowed in acceptance helpers",
    );
  });

  it("rejects an assert/strict assertion in an acceptance helper", () => {
    const helpers = [
      { path: "acceptance/support/helper.ts", source: 'import assert from "assert/strict"; assert.ok(true);' },
    ];
    expect(checkAcceptanceRules(sources({ helpers }))).toContain(
      "acceptance/support/helper.ts: assertions are not allowed in acceptance helpers",
    );
  });

  it("rejects an assert/strict assertion in a Given definition", () => {
    const source = validSteps
      .replace('import assert from "node:assert/strict";', 'import assert from "assert/strict";')
      .replace("this.tracked = true;", "assert.ok(true); this.tracked = true;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: Given step definition must not contain assertions",
    );
  });

  it("rejects a strict named import assertion in an acceptance helper", () => {
    const helpers = [
      {
        path: "acceptance/support/helper.ts",
        source: 'import { strict as assert } from "node:assert"; assert.ok(true);',
      },
    ];
    expect(checkAcceptanceRules(sources({ helpers }))).toContain(
      "acceptance/support/helper.ts: assertions are not allowed in acceptance helpers",
    );
  });

  it("rejects a strict named import assertion in a Given definition", () => {
    const source = validSteps
      .replace('import assert from "node:assert/strict";', 'import { strict as assert } from "node:assert";')
      .replace("this.tracked = true;", "assert.ok(true); this.tracked = true;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: Given step definition must not contain assertions",
    );
  });

  it("rejects a strict named import assertion in a When definition", () => {
    const source = validSteps
      .replace('import assert from "node:assert/strict";', 'import { strict as assert } from "node:assert";')
      .replace("this.code = 1;", "assert.ok(true); this.code = 1;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:5: When step definition must not contain assertions",
    );
  });

  it("rejects an assertion in a local helper within a step definition file", () => {
    const source = validSteps.replace(
      'Given("実行用ディレクトリに追跡ファイルがある", function () { this.tracked = true; });',
      'function helper() { assert.ok(false); }\nGiven("実行用ディレクトリに追跡ファイルがある", function () { helper(); this.tracked = true; });',
    );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts: assertions are not allowed outside step definition callbacks",
    );
  });

  it.each([
    ["language", "language='en'"],
    ["strict", "strict=false"],
    ["dryRun", "dryRun=true"],
    ["retry", "retry=2"],
    ["paths", "paths=[]"],
  ])("rejects a subsequent mutation of Cucumber %s", (_name, mutation) => {
    const config = sources().config;
    config.source += `\nmodule.exports.default.${mutation};`;
    expect(checkAcceptanceRules(sources({ config }))).toContain(
      "cucumber.cjs: a literal default Cucumber profile is required",
    );
  });

  it("uses the last duplicate Cucumber property value", () => {
    const config = sources().config;
    config.source = config.source.replace("language: 'ja'", "language: 'ja', language: 'en'");
    expect(checkAcceptanceRules(sources({ config }))).toContain(
      "cucumber.cjs: Cucumber language must be explicitly set to 'ja'",
    );
  });

  it("rejects a spread in the Cucumber profile", () => {
    const config = sources().config;
    config.source = config.source.replace("default: {", "default: { ...other,");
    expect(checkAcceptanceRules(sources({ config }))).toContain(
      "cucumber.cjs: a literal default Cucumber profile is required",
    );
  });

  it("rejects a computed Cucumber profile property", () => {
    const config = sources().config;
    config.source = config.source.replace("language: 'ja'", "['language']: 'ja'");
    expect(checkAcceptanceRules(sources({ config }))).toContain(
      "cucumber.cjs: a literal default Cucumber profile is required",
    );
  });

  it("rejects enabled Cucumber dry-run mode", () => {
    const config = sources().config;
    config.source = config.source.replace("strict: true", "strict: true, dryRun: true");
    expect(checkAcceptanceRules(sources({ config }))).toContain(
      "cucumber.cjs: Cucumber dry-run mode must not be enabled",
    );
  });

  it("rejects Cucumber retries", () => {
    const config = sources().config;
    config.source = config.source.replace("strict: true", "strict: true, retry: 3");
    expect(checkAcceptanceRules(sources({ config }))).toContain(
      "cucumber.cjs: Cucumber retry must be omitted or explicitly set to 0",
    );
  });

  it("rejects a non-Japanese Cucumber language", () => {
    const config = sources().config;
    config.source = config.source.replace("language: 'ja'", "language: 'en'");
    expect(checkAcceptanceRules(sources({ config }))).toContain(
      "cucumber.cjs: Cucumber language must be explicitly set to 'ja'",
    );
  });

  it("rejects disabled strict mode", () => {
    const config = sources().config;
    config.source = config.source.replace("strict: true", "strict: false");
    expect(checkAcceptanceRules(sources({ config }))).toContain(
      "cucumber.cjs: Cucumber strict mode must be explicitly enabled",
    );
  });

  it("rejects a widened feature path", () => {
    const config = sources().config;
    config.source = config.source.replace("acceptance/features/**/*.feature.md", "**/*.feature.md");
    expect(checkAcceptanceRules(sources({ config }))).toContain(
      "cucumber.cjs: Cucumber paths must target only acceptance/features/**/*.feature.md",
    );
  });

  it("rejects a missing tsx registration", () => {
    const config = sources().config;
    config.source = config.source.replace("requireModule: ['tsx/cjs']", "requireModule: []");
    expect(checkAcceptanceRules(sources({ config }))).toContain("cucumber.cjs: Cucumber must register tsx/cjs");
  });

  it("rejects missing TypeScript support code paths", () => {
    const config = sources().config;
    config.source = config.source.replace(
      "require: ['acceptance/steps/**/*.ts', 'acceptance/support/**/*.ts']",
      "require: ['acceptance/steps/**/*.ts']",
    );
    expect(checkAcceptanceRules(sources({ config }))).toContain(
      "cucumber.cjs: Cucumber support code paths must target the TypeScript acceptance directories",
    );
  });
});
