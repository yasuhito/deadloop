import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { After, Given, Then, When } from "@cucumber/cucumber";

const { runProjectCheck } = require("../../src/project-check.ts");

type SafetyWorld = {
  projectRoot?: string;
};

const checkMarker = ".deadloop-check-ran";

Given("deadloop が自動チェックするプロジェクトがある", function (this: SafetyWorld) {
  this.projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-acceptance-"));
  fs.writeFileSync(path.join(this.projectRoot, "package.json"), '{"name":"acceptance-fixture"}\n');
  execFileSync("git", ["init", "-q", this.projectRoot]);
  execFileSync("git", ["-C", this.projectRoot, "add", "package.json"]);
});

Given("`.deadloop` ディレクトリに Git 管理ファイルがある", function (this: SafetyWorld) {
  if (!this.projectRoot) throw new Error("project precondition is missing");
  fs.mkdirSync(path.join(this.projectRoot, ".deadloop"));
  fs.writeFileSync(path.join(this.projectRoot, ".deadloop", "product.json"), "tracked product data\n");
  execFileSync("git", ["-C", this.projectRoot, "add", ".deadloop/product.json"]);
});

When("deadloop が自動チェックを開始しようとする", async function (this: SafetyWorld) {
  if (!this.projectRoot) throw new Error("project precondition is missing");
  await runProjectCheck({
    cwd: this.projectRoot,
    command: `node -e "require('node:fs').writeFileSync('${checkMarker}', 'ran')"`,
    quarantineRoot: path.join(os.tmpdir(), "deadloop-acceptance-quarantine"),
  });
});

Then("deadloop は自動チェックを実行しない", function (this: SafetyWorld) {
  if (!this.projectRoot) throw new Error("project precondition is missing");
  assert.equal(fs.existsSync(path.join(this.projectRoot, checkMarker)), false);
});

After(function (this: SafetyWorld) {
  if (this.projectRoot) fs.rmSync(this.projectRoot, { recursive: true, force: true });
});
