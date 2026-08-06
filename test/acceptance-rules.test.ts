import { describe, expect, it } from "vitest";

import { checkAcceptanceRules, type AcceptanceSource } from "../src/check-acceptance-rules";

const validFeature = `# Feature: Safe verification

Ensure that tracked files are not hidden.

## Scenario: Reject verification when a tracked file exists

* Given the runtime directory contains a tracked file
* When normal verification starts
* Then verification is rejected for safety
`;

const validSteps = `
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
Given("the runtime directory contains a tracked file", function () { this.tracked = true; });
When("normal verification starts", function () { this.code = 1; });
Then("verification is rejected for safety", function () { assert.equal(this.code, 1); });
`;

function sources(overrides: Partial<AcceptanceSource> = {}): AcceptanceSource {
  return {
    config: {
      path: "cucumber.cjs",
      source:
        "module.exports = { default: { paths: ['acceptance/features/**/*.feature.md'], requireModule: ['tsx/cjs'], require: ['acceptance/steps/**/*.ts', 'acceptance/support/**/*.ts'], language: 'en', strict: true } };",
    },
    features: [{ path: "acceptance/features/safety.feature.md", source: validFeature }],
    stepDefinitions: [{ path: "acceptance/steps/safety.steps.ts", source: validSteps }],
    helpers: [],
    ...overrides,
  };
}

describe("acceptance test rules", () => {
  it("accepts one English scenario with one result and one assertion", () => {
    expect(checkAcceptanceRules(sources())).toEqual([]);
  });

  it("rejects a residual Japanese Feature keyword", () => {
    const source = validFeature.replace("# Feature:", "# 機能:");
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:1: Japanese Gherkin keywords are not allowed",
    );
  });

  it("rejects a residual Japanese step keyword", () => {
    const source = validFeature.replace("* Given", "* 前提");
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:7: Japanese Gherkin keywords are not allowed",
    );
  });

  it("rejects Japanese prose in a Feature title", () => {
    const source = validFeature.replace("Safe verification", "安全な verification");
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:1: Japanese prose is not allowed",
    );
  });

  it("rejects Japanese prose in a Feature description", () => {
    const source = validFeature.replace("Ensure that tracked files are not hidden.", "追跡 files are not hidden.");
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:3: Japanese prose is not allowed",
    );
  });

  it("rejects Japanese prose in a Scenario title", () => {
    const source = validFeature.replace("Reject verification", "検証を reject");
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:5: Japanese prose is not allowed",
    );
  });

  it("rejects Japanese prose in a registered step expression", () => {
    const source = validSteps.replace("normal verification starts", "通常 verification starts");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:5: registered step expression must not contain Japanese prose",
    );
  });

  it("allows Japanese in a backtick-delimited Feature literal", () => {
    const source = validFeature.replace("a tracked file", "the literal `停止`");
    const stepDefinitions = validSteps.replaceAll("a tracked file", "the literal `停止`");
    expect(checkAcceptanceRules(sources({ features: [{ path: "literal.feature.md", source }], stepDefinitions: [{ path: "literal.steps.ts", source: stepDefinitions }] }))).toEqual([]);
  });

  it("allows Japanese in a backtick-delimited registered step literal", () => {
    const source = validFeature.replace("normal verification starts", "status `停止` is observed");
    const stepDefinitions = validSteps.replace("normal verification starts", "status `停止` is observed");
    expect(checkAcceptanceRules(sources({ features: [{ path: "literal.feature.md", source }], stepDefinitions: [{ path: "literal.steps.ts", source: stepDefinitions }] }))).toEqual([]);
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
      "Ensure that tracked files are not hidden.",
      "Ensure that tracked files are not hidden.\n\n# language: ja",
    );
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:5: language directives are not allowed",
    );
  });

  it("rejects prose before the Feature heading", () => {
    expect(
      checkAcceptanceRules(sources({
        features: [{ path: "bad.feature.md", source: `introductory prose\n\n${validFeature}` }],
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
      "* Then verification is rejected for safety",
      "* Then verification is rejected for safety\n* Then the command is not run",
    );
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:5: scenario must contain exactly one result step (found 2)",
    );
  });

  it("counts a Feature Background result in each scenario", () => {
    const source = validFeature.replace(
      "## Scenario:",
      "## Background:\n\n* Then a shared result exists\n\n## Scenario:",
    );
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:9: scenario must contain exactly one result step (found 2)",
    );
  });

  it("counts a Rule Background result in each scenario", () => {
    const source = validFeature.replace(
      "## Scenario:",
      "## Rule: Safety rule\n\n### Background:\n\n* Then a shared result exists\n\n### Scenario:",
    );
    expect(checkAcceptanceRules(sources({ features: [{ path: "bad.feature.md", source }] }))).toContain(
      "bad.feature.md:11: scenario must contain exactly one result step (found 2)",
    );
  });

  it("rejects And after Then", () => {
    const source = validFeature.replace(
      "* Then verification is rejected for safety",
      "* Then verification is rejected for safety\n* And the command is not run",
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

  it("does not count a shadowed assertion namespace in Then", () => {
    const source = validSteps.replace(
      "assert.equal(this.code, 1);",
      "const assert = { ok() {} }; assert.ok(true);",
    );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: Then step definition must contain exactly one direct assertion (found 0)",
    );
  });

  it("rejects a block-local CommonJS assertion in Given", () => {
    const source = validSteps.replace(
      "this.tracked = true;",
      'const hidden = require("node:assert/strict"); hidden.ok(true); this.tracked = true;',
    );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: Given step definition must not contain assertions",
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

  it("rejects a bound assertion alias in a Given definition", () => {
    const source = validSteps
      .replace(
        'import { Given, Then, When } from "@cucumber/cucumber";',
        'import { Given, Then, When } from "@cucumber/cucumber";\nconst hidden = assert.ok.bind(assert);',
      )
      .replace("this.tracked = true;", "hidden(true); this.tracked = true;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:5: Given step definition must not contain assertions",
    );
  });

  it("rejects an assertion through a local assertion alias in a Given definition", () => {
    const source = validSteps
      .replace('import { Given, Then, When } from "@cucumber/cucumber";', 'import { Given, Then, When } from "@cucumber/cucumber";\nconst hiddenAssert = assert;')
      .replace("this.tracked = true;", "hiddenAssert.ok(true); this.tracked = true;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:5: Given step definition must not contain assertions",
    );
  });

  it("rejects a block-local assertion function alias in a Given definition", () => {
    const source = validSteps.replace(
      "this.tracked = true;",
      "const hidden = assert.ok; hidden(true); this.tracked = true;",
    );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: Given step definition must not contain assertions",
    );
  });

  it("rejects an assigned assertion function alias in a Given definition", () => {
    const source = validSteps
      .replace(
        'import { Given, Then, When } from "@cucumber/cucumber";',
        'import { Given, Then, When } from "@cucumber/cucumber";\nlet hidden = () => {};\nhidden = assert.ok;',
      )
      .replace("this.tracked = true;", "hidden(true); this.tracked = true;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: Given step definition must not contain assertions",
    );
  });

  it("rejects an assertion in a Given definition", () => {
    const source = validSteps.replace("this.tracked = true;", "assert.ok(true); this.tracked = true;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: Given step definition must not contain assertions",
    );
  });

  it("rejects an assertion invoked with Function.prototype.call in a Given definition", () => {
    const source = validSteps.replace("this.tracked = true;", "assert.ok.call(assert, true); this.tracked = true;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: Given step definition must not contain assertions",
    );
  });

  it("rejects an assertion invoked with Reflect.apply in a Given definition", () => {
    const source = validSteps.replace("this.tracked = true;", "Reflect.apply(assert.ok, assert, [true]); this.tracked = true;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: Given step definition must not contain assertions",
    );
  });

  it("rejects a destructuring-assignment assertion alias in a Given definition", () => {
    const source = validSteps
      .replace(
        'import { Given, Then, When } from "@cucumber/cucumber";',
        'import { Given, Then, When } from "@cucumber/cucumber";\nlet ok;\n({ ok } = assert);',
      )
      .replace("this.tracked = true;", "ok(true); this.tracked = true;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: Given step definition must not contain assertions",
    );
  });

  it("rejects a destructured assertion from an assertion namespace in Given", () => {
    const source = validSteps
      .replace('import { Given, Then, When } from "@cucumber/cucumber";', 'import { Given, Then, When } from "@cucumber/cucumber";\nconst { ok } = assert;')
      .replace("this.tracked = true;", "ok(true); this.tracked = true;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:5: Given step definition must not contain assertions",
    );
  });

  it("rejects a parenthesized assertion namespace call in Given", () => {
    const source = validSteps.replace("this.tracked = true;", "(assert).ok(true); this.tracked = true;");
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
setup("precondition", function () { assert.ok(true); });
When("action", function () { this.code = 1; });
Then("result", function () { assert.equal(this.code, 1); });
`;
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: Given step definition must not contain assertions",
    );
  });

  it("rejects an assertion in a direct-require Cucumber Given registration", () => {
    const source = `
require("@cucumber/cucumber").Given("the runtime directory contains a tracked file", function () { require("node:assert/strict").ok(true); });
`;
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:2: Given step definition must not contain assertions",
    );
  });

  it("rejects a direct-require Cucumber Then registration without an assertion", () => {
    const source = `
require("@cucumber/cucumber").Then("verification is rejected for safety", function () {});
`;
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:2: Then step definition must contain exactly one direct assertion (found 0)",
    );
  });

  it("rejects a Cucumber Then registration invoked with Reflect.apply", () => {
    const source = `
import { Then } from "@cucumber/cucumber";
Reflect.apply(Then, undefined, ["verification is rejected for safety", () => {}]);
`;
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:3: indirect Cucumber Then registration is not allowed",
    );
  });

  it("rejects a Cucumber Then registration invoked with Function.prototype.call", () => {
    const source = `
import { Then } from "@cucumber/cucumber";
Then.call(undefined, "verification is rejected for safety", () => {});
`;
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:3: indirect Cucumber Then registration is not allowed",
    );
  });

  it("rejects a Cucumber Then registration invoked with Function.prototype.apply", () => {
    const source = `
import { Then } from "@cucumber/cucumber";
Then.apply(undefined, ["verification is rejected for safety", () => {}]);
`;
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:3: indirect Cucumber Then registration is not allowed",
    );
  });

  it("rejects a bound Cucumber Then.call registration", () => {
    const source = `
import { Then } from "@cucumber/cucumber";
const outcome = Then.call.bind(Then, undefined);
outcome("verification is rejected for safety", () => {});
`;
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: indirect Cucumber Then registration is not allowed",
    );
  });

  it("counts a direct-require assertion in a Then registration", () => {
    const source = validSteps.replace(
      "assert.equal(this.code, 1);",
      'assert.equal(this.code, 1); require("node:assert/strict").ok(true);',
    );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: Then step definition must contain exactly one direct assertion (found 2)",
    );
  });

  it("rejects missing assertions for an aliased CommonJS Then binding", () => {
    const source = `
const assert = require("node:assert/strict");
const { Given, When, Then: outcome } = require("@cucumber/cucumber");
Given("precondition", function () { this.tracked = true; });
When("action", function () { this.code = 1; });
outcome("result", function () { this.observed = this.code; });
`;
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: Then step definition must contain exactly one direct assertion (found 0)",
    );
  });

  it("rejects a bound Then registration without an assertion", () => {
    const source = validSteps
      .replace(
        'import { Given, Then, When } from "@cucumber/cucumber";',
        'import { Given, Then, When } from "@cucumber/cucumber";\nconst outcome = Then.bind(null);',
      )
      .replace(
        'Then("verification is rejected for safety", function () { assert.equal(this.code, 1); });',
        'outcome("verification is rejected for safety", function () {});',
      );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:7: Then step definition must contain exactly one direct assertion (found 0)",
    );
  });

  it("rejects an assertion in an aliased When definition", () => {
    const source = validSteps
      .replace("Given, Then, When", "Given, Then, When as action")
      .replace(
        'When("normal verification starts", function () { this.code = 1; });',
        'action("normal verification starts", function () { assert.ok(true); this.code = 1; });',
      );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:5: When step definition must not contain assertions",
    );
  });

  it("rejects an assertion in a namespace-imported Given definition", () => {
    const source = validSteps
      .replace(
        'import { Given, Then, When } from "@cucumber/cucumber";',
        'import * as cucumber from "@cucumber/cucumber";',
      )
      .replaceAll(/\b(Given|Then|When)\(/g, "cucumber.$1(")
      .replace("this.tracked = true;", "assert.ok(true); this.tracked = true;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: Given step definition must not contain assertions",
    );
  });

  it("rejects an assertion in a namespace-imported When definition", () => {
    const source = validSteps
      .replace(
        'import { Given, Then, When } from "@cucumber/cucumber";',
        'import * as cucumber from "@cucumber/cucumber";',
      )
      .replaceAll(/\b(Given|Then|When)\(/g, "cucumber.$1(")
      .replace("this.code = 1;", "assert.ok(true); this.code = 1;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:5: When step definition must not contain assertions",
    );
  });

  it("rejects a namespace-imported Then definition without an assertion", () => {
    const source = validSteps
      .replace(
        'import { Given, Then, When } from "@cucumber/cucumber";',
        'import * as cucumber from "@cucumber/cucumber";',
      )
      .replaceAll(/\b(Given|Then|When)\(/g, "cucumber.$1(")
      .replace("assert.equal(this.code, 1);", "this.observed = this.code;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: Then step definition must contain exactly one direct assertion (found 0)",
    );
  });

  it("rejects a destructured Then from a Cucumber namespace without an assertion", () => {
    const source = validSteps
      .replace(
        'import { Given, Then, When } from "@cucumber/cucumber";',
        'import * as cucumber from "@cucumber/cucumber";\nconst { Given, Then, When } = cucumber;',
      )
      .replace("assert.equal(this.code, 1);", "this.observed = this.code;");
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:7: Then step definition must contain exactly one direct assertion (found 0)",
    );
  });

  it("rejects an aliased Then definition without an assertion", () => {
    const source = validSteps
      .replace("Given, Then, When", "Given, Then as outcome, When")
      .replace(
        'Then("verification is rejected for safety", function () { assert.equal(this.code, 1); });',
        'outcome("verification is rejected for safety", function () { this.observed = this.code; });',
      );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: Then step definition must contain exactly one direct assertion (found 0)",
    );
  });

  it("rejects a local alias of a Then registration without an assertion", () => {
    const source = validSteps
      .replace('import { Given, Then, When } from "@cucumber/cucumber";', 'import { Given, Then, When } from "@cucumber/cucumber";\nconst outcome = Then;')
      .replace(
        'Then("verification is rejected for safety", function () { assert.equal(this.code, 1); });',
        'outcome("verification is rejected for safety", function () { this.observed = this.code; });',
      );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:7: Then step definition must contain exactly one direct assertion (found 0)",
    );
  });

  it("rejects a block-local alias of a Then registration without an assertion", () => {
    const source = `import { Then } from "@cucumber/cucumber";
{
  const outcome = Then;
  outcome("verification is rejected for safety", () => {});
}`;
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: Then step definition must contain exactly one direct assertion (found 0)",
    );
  });

  it("rejects an assigned alias of a Then registration without an assertion", () => {
    const source = `import { Then } from "@cucumber/cucumber";
let result;
result = Then;
result("verification is rejected for safety", () => {});`;
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:4: Then step definition must contain exactly one direct assertion (found 0)",
    );
  });

  it("rejects a dynamic step definition pattern", () => {
    const source = `import { Given } from "@cucumber/cucumber";
const outcomePattern = "verification is rejected for safety";
Given(outcomePattern, () => {});`;
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:3: step definition pattern must be a string or regular expression literal",
    );
  });

  it("rejects a Then phrase registered through Given", () => {
    const source = validSteps.replace(
      'Then("verification is rejected for safety", function () { assert.equal(this.code, 1); });',
      'Given("verification is rejected for safety", function () {});',
    );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: step definition registered with Given matches a Then step",
    );
  });

  it("rejects a Then phrase registered through When", () => {
    const source = validSteps.replace(
      'Then("verification is rejected for safety", function () { assert.equal(this.code, 1); });',
      'When("verification is rejected for safety", function () {});',
    );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts:6: step definition registered with When matches a Then step",
    );
  });

  it("rejects a Then Cucumber Expression registered through Given", () => {
    const feature = validFeature.replace("verification is rejected for safety", "result 1 exists");
    const source = validSteps.replace(
      'Then("verification is rejected for safety", function () { assert.equal(this.code, 1); });',
      'Given("result {int} exists", function () {});',
    );
    expect(
      checkAcceptanceRules(
        sources({
          features: [{ path: "acceptance/features/safety.feature.md", source: feature }],
          stepDefinitions: [{ path: "bad.steps.ts", source }],
        }),
      ),
    ).toContain("bad.steps.ts:6: step definition registered with Given matches a Then step");
  });

  it("rejects a Then Cucumber Expression without an assertion", () => {
    const feature = validFeature.replace("verification is rejected for safety", "result 1 exists");
    const source = validSteps.replace(
      'Then("verification is rejected for safety", function () { assert.equal(this.code, 1); });',
      'Then("result {int} exists", function () {});',
    );
    expect(
      checkAcceptanceRules(
        sources({
          features: [{ path: "acceptance/features/safety.feature.md", source: feature }],
          stepDefinitions: [{ path: "bad.steps.ts", source }],
        }),
      ),
    ).toContain("bad.steps.ts:6: Then step definition must contain exactly one direct assertion (found 0)");
  });

  it("rejects an aliased defineStep definition without an assertion", () => {
    const source = validSteps
      .replace("Given, Then, When", "Given, defineStep as step, When")
      .replace(
        'Then("verification is rejected for safety", function () { assert.equal(this.code, 1); });',
        'step("verification is rejected for safety", function () { this.observed = this.code; });',
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

  it("rejects an assertion in a support Given definition", () => {
    const helpers = [
      {
        path: "acceptance/support/steps.ts",
        source: 'import assert from "node:assert/strict"; import { Given } from "@cucumber/cucumber"; Given("x", () => { assert.ok(true); });',
      },
    ];
    expect(checkAcceptanceRules(sources({ helpers }))).toContain(
      "acceptance/support/steps.ts:1: Given step definition must not contain assertions",
    );
  });

  it("rejects an assertion in a support When definition", () => {
    const helpers = [
      {
        path: "acceptance/support/steps.ts",
        source: 'import assert from "node:assert/strict"; import { When } from "@cucumber/cucumber"; When("x", () => { assert.ok(true); });',
      },
    ];
    expect(checkAcceptanceRules(sources({ helpers }))).toContain(
      "acceptance/support/steps.ts:1: When step definition must not contain assertions",
    );
  });

  it("rejects a support Then definition without an assertion", () => {
    const helpers = [
      {
        path: "acceptance/support/steps.ts",
        source: 'import { Then } from "@cucumber/cucumber"; Then("x", () => {});',
      },
    ];
    expect(checkAcceptanceRules(sources({ helpers }))).toContain(
      "acceptance/support/steps.ts:1: Then step definition must contain exactly one direct assertion (found 0)",
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
      'Given("the runtime directory contains a tracked file", function () { this.tracked = true; });',
      'function helper() { assert.ok(false); }\nGiven("the runtime directory contains a tracked file", function () { helper(); this.tracked = true; });',
    );
    expect(checkAcceptanceRules(sources({ stepDefinitions: [{ path: "bad.steps.ts", source }] }))).toContain(
      "bad.steps.ts: assertions are not allowed outside step definition callbacks",
    );
  });

  it.each([
    ["language", "language='ja'"],
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
    config.source = config.source.replace("language: 'en'", "language: 'en', language: 'ja'");
    expect(checkAcceptanceRules(sources({ config }))).toContain(
      "cucumber.cjs: Cucumber language must be explicitly set to 'en'",
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
    config.source = config.source.replace("language: 'en'", "['language']: 'en'");
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

  it.each(["tags", "name", "nameRegex", "name-regex"])("rejects the Cucumber scenario filter %s", (property) => {
    const config = sources().config;
    config.source = config.source.replace("strict: true", `strict: true, '${property}': 'excluded'`);
    expect(checkAcceptanceRules(sources({ config }))).toContain(
      `cucumber.cjs: Cucumber default profile property '${property}' is not allowed`,
    );
  });

  it("rejects a non-English Cucumber language", () => {
    const config = sources().config;
    config.source = config.source.replace("language: 'en'", "language: 'ja'");
    expect(checkAcceptanceRules(sources({ config }))).toContain(
      "cucumber.cjs: Cucumber language must be explicitly set to 'en'",
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
