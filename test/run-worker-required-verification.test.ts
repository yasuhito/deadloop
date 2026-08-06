import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { assertCleanOutput } = require("../extensions/deadloop/automations/run-worker-required-verification.ts");
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

  it("rejects a checkout at another commit", () => {
    const fixture = repository();
    expect(() => assertCleanOutput(fixture.root, "a".repeat(40))).toThrow("does not match");
  });
});
