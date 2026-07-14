import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { After, Given, Then, When } from "@cucumber/cucumber";

const { runProjectCheck } = require("../../src/project-check.ts");

type SafetyWorld = {
  projectRoot?: string;
  resultCode?: number;
};

Given("プロジェクトの実行用ディレクトリに追跡ファイルがある", function (this: SafetyWorld) {
  this.projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-acceptance-"));
  fs.writeFileSync(path.join(this.projectRoot, "package.json"), '{"name":"acceptance-fixture"}\n');
  fs.mkdirSync(path.join(this.projectRoot, ".deadloop"));
  fs.writeFileSync(path.join(this.projectRoot, ".deadloop", "product.json"), "tracked product data\n");
  execFileSync("git", ["init", "-q", this.projectRoot]);
  execFileSync("git", ["-C", this.projectRoot, "add", "package.json", ".deadloop/product.json"]);
});

When("プロジェクトの通常検証を開始する", async function (this: SafetyWorld) {
  if (!this.projectRoot) throw new Error("project precondition is missing");
  const result = await runProjectCheck({
    cwd: this.projectRoot,
    command: 'node -e "process.exit(0)"',
    quarantineRoot: path.join(os.tmpdir(), "deadloop-acceptance-quarantine"),
  });
  this.resultCode = result.code;
});

Then("検証は安全のため拒否される", function (this: SafetyWorld) {
  assert.equal(this.resultCode, 1);
});

After(function (this: SafetyWorld) {
  if (this.projectRoot) fs.rmSync(this.projectRoot, { recursive: true, force: true });
});
