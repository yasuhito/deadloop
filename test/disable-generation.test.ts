import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function runDisable(modulePath: string, stateDir: string, repoPath: string): Promise<void> {
  const script = `
    const fs = require("node:fs");
    const path = require("node:path");
    const { advanceDisableGeneration } = require(process.argv[1]);
    const stateDir = process.argv[2];
    const repoPath = process.argv[3];
    advanceDisableGeneration(stateDir, repoPath, (file, value) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      const temporary = file + "." + process.pid + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify(value));
      fs.renameSync(temporary, file);
    });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, modulePath, stateDir, repoPath], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  });
}

describe("disable generation", () => {
  it("serializes concurrent revocations for different repositories", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "deadloop-disable-generation-"));
    fixtures.push(root);
    const stateDir = path.join(root, "state");
    mkdirSync(stateDir);
    const repos = Array.from({ length: 4 }, (_value, index) => path.join(root, `repo-${index}`));
    const modulePath = path.resolve("src/disable-generation.cjs");

    await Promise.all(repos.map((repo) => runDisable(modulePath, stateDir, repo)));

    const state = JSON.parse(readFileSync(path.join(stateDir, "disable-generation.json"), "utf8"));
    expect(state.generations).toEqual(Object.fromEntries(repos.map((repo) => [repo, 1])));
  });
});
