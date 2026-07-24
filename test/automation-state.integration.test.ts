import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

function waitForFile(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(filePath)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 5_000) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${filePath}`));
      }
    }, 10);
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
    child.once("error", reject);
  });
}

describe("shared automation state", () => {
  it("preserves concurrent updates from two repository schedulers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-automation-state-"));
    const statePath = path.join(root, "state.json");
    const goPath = path.join(root, "go");
    const helperPath = path.join(root, "save.cjs");
    const modulePath = path.resolve("src/automation-state.cjs");
    fs.writeFileSync(statePath, JSON.stringify({ automations: {
      "repo-a:auto": { lastResult: "old-a" },
      "repo-b:auto": { lastResult: "old-b" },
    } }));
    fs.writeFileSync(helperPath, `const fs = require("node:fs");
const { loadAutomationState, saveAutomationState } = require(${JSON.stringify(modulePath)});
const [statePath, readyPath, goPath, key] = process.argv.slice(2);
const state = loadAutomationState(statePath);
state.automations[key] = { lastResult: key };
fs.writeFileSync(readyPath, "ready");
while (!fs.existsSync(goPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
saveAutomationState(statePath, state, [key]);
`);
    const readyA = path.join(root, "a-ready");
    const readyB = path.join(root, "b-ready");
    const childA = spawn(process.execPath, [helperPath, statePath, readyA, goPath, "repo-a:auto"]);
    const childB = spawn(process.execPath, [helperPath, statePath, readyB, goPath, "repo-b:auto"]);

    try {
      await Promise.all([waitForFile(readyA), waitForFile(readyB)]);
      fs.writeFileSync(goPath, "go");
      await Promise.all([waitForExit(childA), waitForExit(childB)]);

      expect(JSON.parse(fs.readFileSync(statePath, "utf8")).automations).toEqual({
        "repo-a:auto": { lastResult: "repo-a:auto" },
        "repo-b:auto": { lastResult: "repo-b:auto" },
      });
    } finally {
      childA.kill();
      childB.kill();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
