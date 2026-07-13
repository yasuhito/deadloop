import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const helper = path.resolve("extensions/deadloop/automations/run-project-check.ts");
const formatter = path.resolve("test/fixtures/project-check/recursive-json-formatter.cjs");
const temporaryDirectories: string[] = [];

function temporaryProject(): string {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-project-check-"));
  temporaryDirectories.push(project);
  return project;
}

function writeEvidence(project: string): Map<string, Buffer> {
  const evidence = new Map<string, Buffer>([
    [".deadloop/promise.json", Buffer.from('{"status":"complete"}\n\u0000evidence')],
    [".pi-subagents/artifacts/transcript.json", Buffer.from("{malformed generated json")],
  ]);
  for (const [relative, bytes] of evidence) {
    const target = path.join(project, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  return evidence;
}

function expectEvidence(project: string, evidence: Map<string, Buffer>): void {
  for (const [relative, bytes] of evidence) expect(fs.readFileSync(path.join(project, relative))).toEqual(bytes);
}

function run(project: string, command: string, timeoutMs = 10_000) {
  return spawnSync(process.execPath, [helper, "--cwd", project, "--timeout-ms", String(timeoutMs), "--command", command], {
    encoding: "utf8",
  });
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runAndSignal(project: string, signal: NodeJS.Signals) {
  const ready = path.join(project, "ready");
  const script = `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000)`;
  const child = spawn(process.execPath, [helper, "--cwd", project, "--command", `${process.execPath} -e ${JSON.stringify(script)}`], {
    stdio: "ignore",
  });
  await waitForFile(ready);
  child.kill(signal);
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal }));
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("run-project-check", () => {
  it("hides generated malformed JSON from a recursive formatter", () => {
    const project = temporaryProject();
    writeEvidence(project);

    expect(run(project, `${process.execPath} ${JSON.stringify(formatter)}`).status).toBe(0);
  });

  it("does not hide malformed tracked JSON", () => {
    const project = temporaryProject();
    fs.writeFileSync(path.join(project, "tracked.json"), "{malformed tracked json");

    expect(run(project, `${process.execPath} ${JSON.stringify(formatter)}`).status).not.toBe(0);
  });

  it("preserves generated evidence bytes after success", () => {
    const project = temporaryProject();
    const evidence = writeEvidence(project);
    run(project, `${process.execPath} -e "process.exit(0)"`);

    expectEvidence(project, evidence);
  });

  it("preserves the project command failure status", () => {
    const project = temporaryProject();
    writeEvidence(project);

    expect(run(project, `${process.execPath} -e "process.exit(37)"`).status).toBe(37);
  });

  it("restores generated evidence after command failure", () => {
    const project = temporaryProject();
    const evidence = writeEvidence(project);
    run(project, `${process.execPath} -e "process.exit(19)"`);

    expectEvidence(project, evidence);
  });

  it("restores generated evidence after a spawn failure", () => {
    const project = temporaryProject();
    const evidence = writeEvidence(project);
    spawnSync(process.execPath, [helper, "--cwd", project, "--", path.join(project, "missing-executable")]);

    expectEvidence(project, evidence);
  });

  it("returns 124 after a timeout", () => {
    const project = temporaryProject();
    writeEvidence(project);

    expect(run(project, `${process.execPath} -e "setInterval(() => {}, 1000)"`, 100).status).toBe(124);
  });

  it("restores generated evidence after a timeout", () => {
    const project = temporaryProject();
    const evidence = writeEvidence(project);
    run(project, `${process.execPath} -e "setInterval(() => {}, 1000)"`, 100);

    expectEvidence(project, evidence);
  });

  it("restores generated evidence before propagating SIGINT", async () => {
    const project = temporaryProject();
    const evidence = writeEvidence(project);

    expect((await runAndSignal(project, "SIGINT")).signal).toBe("SIGINT");
    expectEvidence(project, evidence);
  });

  it("restores generated evidence before propagating SIGTERM", async () => {
    const project = temporaryProject();
    const evidence = writeEvidence(project);

    expect((await runAndSignal(project, "SIGTERM")).signal).toBe("SIGTERM");
    expectEvidence(project, evidence);
  });

  it("recovers evidence left by an abruptly killed prior invocation", async () => {
    const project = temporaryProject();
    const evidence = writeEvidence(project);
    const ready = path.join(project, "ready");
    const script = `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setTimeout(() => {}, 300)`;
    const abandoned = spawn(
      process.execPath,
      [helper, "--cwd", project, "--command", `${process.execPath} -e ${JSON.stringify(script)}`],
      { stdio: "ignore" },
    );
    await waitForFile(ready);
    abandoned.kill("SIGKILL");
    await new Promise((resolve) => abandoned.once("close", resolve));
    run(project, `${process.execPath} -e "process.exit(0)"`);

    expectEvidence(project, evidence);
  });

  it("fails closed when a project command creates a conflicting artifact tree", () => {
    const project = temporaryProject();
    writeEvidence(project);

    expect(run(project, "mkdir .deadloop").status).toBe(1);
  });
});
