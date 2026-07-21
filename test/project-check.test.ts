import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const { runProjectCheck } = require("../src/project-check.ts");

const tempDirs: string[] = [];

function fixtureRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-project-check-"));
  tempDirs.push(root);
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}\n');
  fs.writeFileSync(
    path.join(root, "check-json.cjs"),
    `const fs = require("node:fs");
const path = require("node:path");
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.name.endsWith(".json")) JSON.parse(fs.readFileSync(file, "utf8"));
  }
}
visit(process.cwd());
`,
  );
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "package.json", "check-json.cjs"]);
  fs.mkdirSync(path.join(root, ".deadloop"));
  fs.writeFileSync(path.join(root, ".deadloop", "promise.json"), "pending\n");
  fs.mkdirSync(path.join(root, ".pi-subagents"));
  fs.writeFileSync(path.join(root, ".pi-subagents", "metadata.json"), "diagnostic output\n");
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("project check", () => {
  it("does not expose deadloop runtime artifacts to recursive JSON validation", async () => {
    const cwd = fixtureRepo();

    const result = await runProjectCheck({
      cwd,
      command: "node check-json.cjs",
      quarantineRoot: path.join(os.tmpdir(), "deadloop-project-check-quarantine"),
    });

    expect(result.code).toBe(0);
  });

  it("still fails recursive JSON validation for a tracked product file", async () => {
    const cwd = fixtureRepo();
    fs.writeFileSync(path.join(cwd, "package.json"), "broken product JSON\n");

    const result = await runProjectCheck({
      cwd,
      command: "node check-json.cjs",
      quarantineRoot: path.join(os.tmpdir(), "deadloop-project-check-quarantine"),
    });

    expect(result.code).toBe(1);
  });

  it("fails closed instead of hiding a tracked file in a runtime directory", async () => {
    const cwd = fixtureRepo();
    fs.writeFileSync(path.join(cwd, ".deadloop", "product.json"), "broken tracked JSON\n");
    execFileSync("git", ["-C", cwd, "add", ".deadloop/product.json"]);

    const result = await runProjectCheck({
      cwd,
      command: "node check-json.cjs",
      quarantineRoot: path.join(os.tmpdir(), "deadloop-project-check-quarantine"),
    });

    expect(result.code).toBe(1);
  });

  it("restores promise evidence after a failed check", async () => {
    const cwd = fixtureRepo();

    await runProjectCheck({
      cwd,
      command: "exit 7",
      quarantineRoot: path.join(os.tmpdir(), "deadloop-project-check-quarantine"),
    });

    expect(fs.readFileSync(path.join(cwd, ".deadloop", "promise.json"), "utf8")).toBe("pending\n");
  });

  it("restores subagent diagnostics after a timed-out check", async () => {
    const cwd = fixtureRepo();

    await runProjectCheck({
      cwd,
      command: "sleep 1",
      timeoutMs: 20,
      quarantineRoot: path.join(os.tmpdir(), "deadloop-project-check-quarantine"),
    });

    expect(fs.readFileSync(path.join(cwd, ".pi-subagents", "metadata.json"), "utf8")).toBe("diagnostic output\n");
  });

  it("bounds a timed-out check that ignores SIGTERM", async () => {
    const cwd = fixtureRepo();
    const startedAt = Date.now();

    await runProjectCheck({
      cwd,
      command: `node -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'`,
      timeoutMs: 20,
      terminationGraceMs: 20,
      quarantineRoot: path.join(os.tmpdir(), "deadloop-project-check-quarantine"),
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("restores artifacts after forcing a timed-out check to stop", async () => {
    const cwd = fixtureRepo();

    await runProjectCheck({
      cwd,
      command: `node -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'`,
      timeoutMs: 20,
      terminationGraceMs: 20,
      quarantineRoot: path.join(os.tmpdir(), "deadloop-project-check-quarantine"),
    });

    expect(fs.readFileSync(path.join(cwd, ".pi-subagents", "metadata.json"), "utf8")).toBe("diagnostic output\n");
  });

  it("restores runtime artifacts when the CLI is interrupted", async () => {
    const cwd = fixtureRepo();
    const child = spawn(
      "node",
      [
        "extensions/deadloop/automations/run-project-check.ts",
        "--cwd",
        cwd,
        "--command",
        "sleep 5",
        "--quarantine-root",
        path.join(os.tmpdir(), "deadloop-project-check-quarantine"),
      ],
      { cwd: process.cwd(), stdio: "ignore" },
    );
    while (fs.existsSync(path.join(cwd, ".pi-subagents"))) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("close", resolve));

    expect(fs.readFileSync(path.join(cwd, ".pi-subagents", "metadata.json"), "utf8")).toBe("diagnostic output\n");
  });

  it("reports an interrupted check without losing restoration control", async () => {
    const cwd = fixtureRepo();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);

    const result = await runProjectCheck({
      cwd,
      command: "sleep 1",
      quarantineRoot: path.join(os.tmpdir(), "deadloop-project-check-quarantine"),
      signal: controller.signal,
    });

    expect(result.code).toBe(130);
  });
});
