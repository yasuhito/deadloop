import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { Given, Then, When } from "@cucumber/cucumber";

type IssueSelectionWorld = {
  fixtureName?: string;
  selected?: boolean;
};

const decisionScript = "extensions/deadloop/automations/issue-coordinator-decisions.ts";

function selectIssue(fixtureName: string): boolean {
  const result = spawnSync(
    "node",
    [decisionScript, "--fixture", path.join("test/fixtures/issue-coordinator", fixtureName), "--json"],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return JSON.parse(result.stdout).selected === true;
}

Given("選定可能な Issue が `ready-for-agent` と `agent:implement` のラベルを持つ", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-ready-implement.json";
});

Given("作業中の Issue が `agent:in-progress` ラベルを持つ", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-in-progress.json";
});

Given("選定可能な Issue が本文の{string}で未完了の依存を示す", function (this: IssueSelectionWorld, location: string) {
  const fixtures: Record<string, string> = {
    "依存欄": "selection-open-body-dependency.json",
    "末尾": "selection-open-final-section-dependency.json",
  };
  const fixtureName = fixtures[location];
  if (!fixtureName) throw new Error(`unknown dependency location: ${location}`);
  this.fixtureName = fixtureName;
});

Given("選定可能な Issue が本文で完了した依存を示す", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-closed-body-dependency.json";
});

Given("選定可能な Issue が GitHub 上で未完了の依存を持つ", function (this: IssueSelectionWorld) {
  this.fixtureName = "selection-open-relationship-dependency.json";
});

When("Issue coordinator が作業対象を選ぶ", function (this: IssueSelectionWorld) {
  if (!this.fixtureName) throw new Error("issue precondition is missing");
  this.selected = selectIssue(this.fixtureName);
});

Then("その Issue は作業対象に選ばれる", function (this: IssueSelectionWorld) {
  assert.equal(this.selected, true);
});

Then("作業中の Issue は作業対象に選ばれない", function (this: IssueSelectionWorld) {
  assert.equal(this.selected, false);
});

Then("未完了の依存を持つ Issue は作業対象に選ばれない", function (this: IssueSelectionWorld) {
  assert.equal(this.selected, false);
});

Then("完了した依存を持つ Issue は作業対象に選ばれる", function (this: IssueSelectionWorld) {
  assert.equal(this.selected, true);
});

Then("GitHub 上の未完了の依存を持つ Issue は作業対象に選ばれない", function (this: IssueSelectionWorld) {
  assert.equal(this.selected, false);
});
