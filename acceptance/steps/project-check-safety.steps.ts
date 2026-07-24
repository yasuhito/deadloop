import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { After, Given, Then, When } from "@cucumber/cucumber";

const { runProjectCheck } = require("../../src/project-check.ts");

type ProjectCheckResult = { code: number };
type SafetyWorld = {
  projectRoot?: string;
  elapsedMs?: number;
  result?: ProjectCheckResult;
};

const completionReport = "pending\n";
const diagnosticReport = "diagnostic output\n";
const checkMarker = ".deadloop-check-ran";

function runtimePath(projectRoot: string, directory: string, file: string): string {
  return path.join(projectRoot, directory, file);
}

function writeRuntimeArtifacts(projectRoot: string): void {
  fs.mkdirSync(path.join(projectRoot, ".deadloop"));
  fs.writeFileSync(runtimePath(projectRoot, ".deadloop", "promise.json"), completionReport);
  fs.mkdirSync(path.join(projectRoot, ".pi-subagents"));
  fs.writeFileSync(runtimePath(projectRoot, ".pi-subagents", "metadata.json"), diagnosticReport);
}

function projectRoot(world: SafetyWorld): string {
  if (!world.projectRoot) throw new Error("project precondition is missing");
  return world.projectRoot;
}

function quarantineRoot(): string {
  return path.join(os.tmpdir(), "deadloop-acceptance-quarantine");
}

function runCheck(world: SafetyWorld, command: string, options: { timeoutMs?: number; terminationGraceMs?: number } = {}): Promise<void> {
  return runProjectCheck({
    cwd: projectRoot(world),
    command,
    quarantineRoot: quarantineRoot(),
    ...options,
  }).then((result: ProjectCheckResult) => {
    world.result = result;
  });
}

Given("deadloop が自動チェックするプロジェクトがある", function (this: SafetyWorld) {
  this.projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-acceptance-"));
  fs.writeFileSync(path.join(this.projectRoot, "package.json"), '{"name":"acceptance-fixture"}\n');
  fs.writeFileSync(
    path.join(this.projectRoot, "check-json.cjs"),
    `const fs = require("node:fs");
const path = require("node:path");
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.name.endsWith(".json")) JSON.parse(fs.readFileSync(file, "utf8"));
  }
}
visit(process.cwd());
`,
  );
  execFileSync("git", ["init", "-q", this.projectRoot]);
  execFileSync("git", ["-C", this.projectRoot, "add", "package.json", "check-json.cjs"]);
});

Given("プロジェクトに未追跡の実行時成果物がある", function (this: SafetyWorld) {
  writeRuntimeArtifacts(projectRoot(this));
});

Given("プロジェクトに不正な Git 管理ファイルがある", function (this: SafetyWorld) {
  const root = projectRoot(this);
  fs.writeFileSync(path.join(root, "package.json"), "broken product JSON\n");
});

Given("`.deadloop` ディレクトリに Git 管理ファイルがある", function (this: SafetyWorld) {
  const root = projectRoot(this);
  fs.mkdirSync(path.join(root, ".deadloop"));
  fs.writeFileSync(path.join(root, ".deadloop", "product.json"), "tracked product data\n");
  execFileSync("git", ["-C", root, "add", ".deadloop/product.json"]);
});

When("deadloop が再帰的な検証を実行する", function (this: SafetyWorld) {
  return runCheck(this, "node check-json.cjs");
});

When("deadloop が成功する自動チェックを実行する", function (this: SafetyWorld) {
  return runCheck(this, "true");
});

When("deadloop が自動チェックを開始しようとする", function (this: SafetyWorld) {
  return runCheck(this, `node -e "require('node:fs').writeFileSync('${checkMarker}', 'ran')"`);
});

When("deadloop が失敗する自動チェックを実行する", function (this: SafetyWorld) {
  return runCheck(this, "exit 7");
});

When("deadloop が時間切れになる自動チェックを実行する", function (this: SafetyWorld) {
  return runCheck(this, "sleep 1", { timeoutMs: 20 });
});

When("deadloop が終了要求を無視する自動チェックを時間切れにする", async function (this: SafetyWorld) {
  const startedAt = Date.now();
  await runCheck(this, `node -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'`, {
    timeoutMs: 20,
    terminationGraceMs: 20,
  });
  this.elapsedMs = Date.now() - startedAt;
});

When("deadloop の自動チェック CLI を中断する", async function (this: SafetyWorld) {
  const root = projectRoot(this);
  const child = spawn(
    "node",
    [
      "extensions/deadloop/automations/run-project-check.ts",
      "--cwd",
      root,
      "--command",
      "sleep 5",
      "--quarantine-root",
      quarantineRoot(),
    ],
    { cwd: process.cwd(), stdio: "ignore" },
  );
  while (fs.existsSync(path.join(root, ".pi-subagents"))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
});

When("deadloop が自動チェックを中断する", async function (this: SafetyWorld) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const result = await runProjectCheck({
    cwd: projectRoot(this),
    command: "sleep 1",
    quarantineRoot: quarantineRoot(),
    signal: controller.signal,
  });
  this.result = result;
});

Then("再帰的な検証は成功する", function (this: SafetyWorld) {
  assert.equal(this.result?.code, 0);
});

Then("完了報告は元の内容で復元される", function (this: SafetyWorld) {
  assert.equal(fs.readFileSync(runtimePath(projectRoot(this), ".deadloop", "promise.json"), "utf8"), completionReport);
});

Then("再帰的な検証は失敗する", function (this: SafetyWorld) {
  assert.equal(this.result?.code, 1);
});

Then("deadloop は自動チェックを実行しない", function (this: SafetyWorld) {
  assert.equal(fs.existsSync(path.join(projectRoot(this), checkMarker)), false);
});

Then("自動チェックは失敗結果を返す", function (this: SafetyWorld) {
  assert.equal(this.result?.code, 1);
});

Then("診断情報は元の内容で復元される", function (this: SafetyWorld) {
  assert.equal(fs.readFileSync(runtimePath(projectRoot(this), ".pi-subagents", "metadata.json"), "utf8"), diagnosticReport);
});

Then("時間切れの自動チェックはすぐに終了する", function (this: SafetyWorld) {
  assert.ok((this.elapsedMs ?? Infinity) < 500);
});

Then("自動チェックは中断として報告される", function (this: SafetyWorld) {
  assert.equal(this.result?.code, 130);
});

After(function (this: SafetyWorld) {
  if (this.projectRoot) fs.rmSync(this.projectRoot, { recursive: true, force: true });
});
