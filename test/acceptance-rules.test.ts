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
    config: { path: "cucumber.cjs", source: "module.exports = { default: { language: 'ja' } };" },
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

  it("rejects a scenario with two result steps", () => {
    const source = validFeature.replace(
      "* ならば 検証は安全のため拒否される",
      "* ならば 検証は安全のため拒否される\n* ならば コマンドは実行されない",
    );
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:5: scenario must contain exactly one result step (found 2)",
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

  it("rejects an assertion in a Given definition", () => {
    const source = validSteps.replace("this.tracked = true;", "assert.ok(true); this.tracked = true;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: Given step definition must not contain assertions",
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

  it("rejects a non-Japanese Cucumber language", () => {
    const config = { path: "cucumber.cjs", source: "module.exports = { default: { language: 'en' } };" };
    expect(checkAcceptanceRules(sources({ config }))).toContain(
      "cucumber.cjs: Cucumber language must be explicitly set to 'ja'",
    );
  });
});
