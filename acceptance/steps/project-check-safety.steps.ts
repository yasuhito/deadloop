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
  fs.mkdirSync(path.join(projectRoot, ".pi", "subagents"), { recursive: true });
  fs.writeFileSync(runtimePath(projectRoot, ".pi/subagents", "promise.json"), completionReport);
  fs.mkdirSync(path.join(projectRoot, ".pi", "npm"), { recursive: true });
  fs.writeFileSync(runtimePath(projectRoot, ".pi/npm", "metadata.json"), diagnosticReport);
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

Given("A project is configured for deadloop project checks", function (this: SafetyWorld) {
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

Given("The project contains untracked runtime artifacts", function (this: SafetyWorld) {
  writeRuntimeArtifacts(projectRoot(this));
});

Given("The project contains an invalid tracked file", function (this: SafetyWorld) {
  const root = projectRoot(this);
  fs.writeFileSync(path.join(root, "package.json"), "broken product JSON\n");
});

Given("An agent scratch area contains a tracked file", function (this: SafetyWorld) {
  const root = projectRoot(this);
  fs.mkdirSync(path.join(root, ".pi", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "subagents", "product.json"), "tracked product data\n");
  execFileSync("git", ["-C", root, "add", ".pi/subagents/product.json"]);
});

When("deadloop runs recursive verification", function (this: SafetyWorld) {
  return runCheck(this, "node check-json.cjs");
});

When("deadloop runs a successful project check", function (this: SafetyWorld) {
  return runCheck(this, "true");
});

When("deadloop attempts to start a project check", function (this: SafetyWorld) {
  return runCheck(this, `node -e "require('node:fs').writeFileSync('${checkMarker}', 'ran')"`);
});

When("deadloop runs a failing project check", function (this: SafetyWorld) {
  return runCheck(this, "exit 7");
});

When("deadloop runs a project check that times out", function (this: SafetyWorld) {
  return runCheck(this, "sleep 1", { timeoutMs: 20 });
});

When("deadloop times out a project check that ignores termination requests", async function (this: SafetyWorld) {
  const startedAt = Date.now();
  await runCheck(this, `node -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'`, {
    timeoutMs: 20,
    terminationGraceMs: 20,
  });
  this.elapsedMs = Date.now() - startedAt;
});

When("The deadloop project-check CLI is interrupted", async function (this: SafetyWorld) {
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
  while (fs.existsSync(path.join(root, ".pi", "npm"))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));
});

When("deadloop interrupts the project check", async function (this: SafetyWorld) {
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

Then("Recursive verification succeeds", function (this: SafetyWorld) {
  assert.equal(this.result?.code, 0);
});

Then("The completion report is restored with its original contents", function (this: SafetyWorld) {
  assert.equal(fs.readFileSync(runtimePath(projectRoot(this), ".pi/subagents", "promise.json"), "utf8"), completionReport);
});

Then("Recursive verification fails", function (this: SafetyWorld) {
  assert.equal(this.result?.code, 1);
});

Then("deadloop does not run the project check", function (this: SafetyWorld) {
  assert.equal(fs.existsSync(path.join(projectRoot(this), checkMarker)), false);
});

Then("The project check returns a failure result", function (this: SafetyWorld) {
  assert.equal(this.result?.code, 1);
});

Then("The diagnostic information is restored with its original contents", function (this: SafetyWorld) {
  assert.equal(fs.readFileSync(runtimePath(projectRoot(this), ".pi/npm", "metadata.json"), "utf8"), diagnosticReport);
});

Then("The timed-out project check terminates promptly", function (this: SafetyWorld) {
  assert.ok((this.elapsedMs ?? Infinity) < 500);
});

Then("The project check is reported as interrupted", function (this: SafetyWorld) {
  assert.equal(this.result?.code, 130);
});

After(function (this: SafetyWorld) {
  if (this.projectRoot) fs.rmSync(this.projectRoot, { recursive: true, force: true });
});
