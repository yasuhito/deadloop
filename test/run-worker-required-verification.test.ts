import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { assertCleanOutput, runWorkerProjectCheck } = require("../extensions/deadloop/automations/run-worker-required-verification.ts");
const { inspectUnresolvedProjectCheckFailures } = require("../src/project-check.ts");
const roots: string[] = [];
function repository() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-worker-verification-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"]);
  writeFileSync(path.join(root, "file.txt"), "checked\n");
  execFileSync("git", ["-C", root, "add", "file.txt"]);
  execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "test"]);
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { root, head };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("Worker required-verification checkout binding", () => {
  it("accepts a clean checkout at the reported output commit", () => {
    const fixture = repository();
    expect(() => assertCleanOutput(fixture.root, fixture.head)).not.toThrow();
  });

  it("rejects dirty content before it can become commit-bound evidence", () => {
    const fixture = repository();
    writeFileSync(path.join(fixture.root, "file.txt"), "dirty\n");
    expect(() => assertCleanOutput(fixture.root, fixture.head)).toThrow("must be clean");
  });

  it("allows only quarantinable runtime artifacts in an otherwise clean checkout", () => {
    const fixture = repository();
    mkdirSync(path.join(fixture.root, ".deadloop"));
    writeFileSync(path.join(fixture.root, ".deadloop", "state.json"), "{}\n");
    mkdirSync(path.join(fixture.root, ".pi-subagents"));
    writeFileSync(path.join(fixture.root, ".pi-subagents", "log"), "runtime\n");
    expect(() => assertCleanOutput(fixture.root, fixture.head)).not.toThrow();
  });

  it("rejects a normal untracked file", () => {
    const fixture = repository();
    writeFileSync(path.join(fixture.root, "unexpected.txt"), "output\n");
    expect(() => assertCleanOutput(fixture.root, fixture.head)).toThrow("must be clean");
  });

  it("rejects a checkout at another commit", () => {
    const fixture = repository();
    expect(() => assertCleanOutput(fixture.root, "a".repeat(40))).toThrow("does not match");
  });

  it("passes the shared interruption signal to the detached check runner", async () => {
    const fixture = repository();
    const controller = new AbortController();
    controller.abort();
    const result = await runWorkerProjectCheck(
      { cwd: fixture.root, command: "sleep 30", quarantineRoot: path.join(path.dirname(fixture.root), "quarantine"), timeoutMs: 1000 },
      controller.signal,
      async (input: { signal?: AbortSignal }) => ({ code: 130, stdout: "", stderr: "", timedOut: false, interrupted: input.signal?.aborted, signal: "SIGTERM" }),
    );
    expect(result.check.interrupted).toBe(true);
  });

  it("records a restoration conflict for doctor inspection", async () => {
    const fixture = repository();
    const stateDir = `${fixture.root}-state`;
    roots.push(stateDir);
    const quarantinePath = path.join(stateDir, "check-quarantine", "retained");
    mkdirSync(quarantinePath, { recursive: true });
    await runWorkerProjectCheck(
      { cwd: fixture.root, command: "true", quarantineRoot: path.join(stateDir, "check-quarantine"), timeoutMs: 1000 },
      undefined,
      async () => ({ code: 0, stdout: "", stderr: "", timedOut: false, interrupted: false, signal: null, restorationFailure: { message: "restore conflict", quarantinePath } }),
    );
    expect(inspectUnresolvedProjectCheckFailures(stateDir)).toHaveLength(1);
  });
});
