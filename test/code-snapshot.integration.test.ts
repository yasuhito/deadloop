import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ensureCodeSnapshot } from "../src/code-snapshot";

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function fixture(lockVersion = 1): { repo: string; stateDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "deadloop-code-snapshot-"));
  roots.push(root);
  const repo = path.join(root, "repo");
  const stateDir = path.join(root, "state");
  mkdirSync(path.join(repo, "extensions", "deadloop", "automations"), { recursive: true });
  mkdirSync(path.join(repo, "node_modules", "fixture-dependency"), { recursive: true });
  writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "fixture" }));
  const dependencyVersion = `${lockVersion}.0.0`;
  const packages = { "": { name: "fixture" }, "node_modules/fixture-dependency": { version: dependencyVersion } };
  writeFileSync(path.join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
  writeFileSync(path.join(repo, "extensions", "deadloop", "automations", "driver.ts"), "export const supply = 'committed';\n");
  const precheck = path.join(repo, "extensions", "deadloop", "automations", "precheck.sh");
  writeFileSync(precheck, "#!/bin/sh\nprintf committed\n");
  chmodSync(precheck, 0o755);
  writeFileSync(path.join(repo, "node_modules", "fixture-dependency", "index.js"), "module.exports = 1;\n");
  writeFileSync(path.join(repo, "node_modules", "fixture-dependency", "package.json"), JSON.stringify({ name: "fixture-dependency", version: dependencyVersion }));
  writeFileSync(path.join(repo, "node_modules", ".package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/fixture-dependency": { version: dependencyVersion } } }));
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.email", "fixture@example.com"]);
  git(repo, ["config", "user.name", "Fixture"]);
  git(repo, ["add", "package.json", "package-lock.json", "extensions"]);
  git(repo, ["commit", "--quiet", "-m", "fixture"]);
  return { repo, stateDir };
}

function supply(input: { repo: string; stateDir: string }) {
  return ensureCodeSnapshot({ packageRoot: input.repo, stateDir: input.stateDir });
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map(async (root) => {
    execFileSync("chmod", ["-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }));
});

describe("code snapshot execution supply", () => {
  it("copies committed automation code instead of an uncommitted edit", () => {
    const input = fixture();
    writeFileSync(path.join(input.repo, "extensions", "deadloop", "automations", "driver.ts"), "export const supply = 'dirty';\n");

    const result = supply(input);

    expect(readFileSync(path.join(result.packageRoot, "extensions", "deadloop", "automations", "driver.ts"), "utf8")).toContain("committed");
  });

  it("executes an automation from the snapshot rather than the working tree", () => {
    const input = fixture();
    writeFileSync(path.join(input.repo, "extensions", "deadloop", "automations", "precheck.sh"), "#!/bin/sh\nprintf dirty\n");

    const result = supply(input);

    expect(execFileSync(path.join(result.automationDir, "precheck.sh"), { encoding: "utf8" })).toBe("committed");
  });

  it("uses a captured code identity after the checkout HEAD advances", () => {
    const input = fixture();
    const loadedIdentity = git(input.repo, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(input.repo, "extensions", "deadloop", "automations", "driver.ts"), "export const supply = 'new-head';\n");
    git(input.repo, ["add", "extensions/deadloop/automations/driver.ts"]);
    git(input.repo, ["commit", "--quiet", "-m", "advance head"]);

    const result = ensureCodeSnapshot({ ...input, packageRoot: input.repo, codeIdentity: loadedIdentity });

    expect(readFileSync(path.join(result.automationDir, "driver.ts"), "utf8")).toContain("committed");
  });

  it("reuses the snapshot for the same code identity", () => {
    const input = fixture();
    const first = supply(input);

    const second = supply(input);

    expect({ first: first.created, second: second.created, path: second.packageRoot }).toEqual({ first: true, second: false, path: first.packageRoot });
  });

  it("shares one dependency snapshot across code identities with the same lock", () => {
    const input = fixture();
    const first = supply(input);
    writeFileSync(path.join(input.repo, "package.json"), JSON.stringify({ name: "fixture", version: "2.0.0" }));
    git(input.repo, ["add", "package.json"]);
    git(input.repo, ["commit", "--quiet", "-m", "second generation"]);

    const second = supply(input);

    expect(second.dependencyRoot).toBe(first.dependencyRoot);
  });

  it("uses a different dependency snapshot when the committed lock changes", () => {
    const input = fixture();
    const first = supply(input);
    const packages = { "": { name: "fixture" }, "node_modules/fixture-dependency": { version: "2.0.0" } };
    writeFileSync(path.join(input.repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
    rmSync(path.join(input.repo, "node_modules"), { recursive: true });
    mkdirSync(path.join(input.repo, "node_modules", "fixture-dependency"), { recursive: true });
    writeFileSync(path.join(input.repo, "node_modules", ".package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/fixture-dependency": { version: "2.0.0" } } }));
    writeFileSync(path.join(input.repo, "node_modules", "fixture-dependency", "package.json"), JSON.stringify({ name: "fixture-dependency", version: "2.0.0" }));
    git(input.repo, ["add", "package-lock.json"]);
    git(input.repo, ["commit", "--quiet", "-m", "change lock"]);

    const second = supply(input);

    expect(second.dependencyRoot).not.toBe(first.dependencyRoot);
  });

  it("fails when installed dependencies do not match the committed lock", () => {
    const input = fixture();
    writeFileSync(path.join(input.repo, "node_modules", ".package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/fixture-dependency": { version: "9.0.0" } } }));

    expect(() => supply(input)).toThrow("installed dependency does not match committed lock");
  });

  it("hard-links dependency files from the installed local dependency tree", () => {
    const input = fixture();

    const result = supply(input);

    expect(statSync(path.join(result.dependencyRoot, "fixture-dependency", "index.js")).ino).toBe(statSync(path.join(input.repo, "node_modules", "fixture-dependency", "index.js")).ino);
  });

  it("makes hard-linked dependency files read-only after provisioning", () => {
    const input = fixture();
    const result = supply(input);
    let writeBlocked = false;

    try { writeFileSync(path.join(input.repo, "node_modules", "fixture-dependency", "index.js"), "mutated\n"); } catch { writeBlocked = true; }

    expect({ writeBlocked, contents: readFileSync(path.join(result.dependencyRoot, "fixture-dependency", "index.js"), "utf8") }).toEqual({ writeBlocked: true, contents: "module.exports = 1;\n" });
  });

  it("links the code snapshot to the fixed dependency snapshot", () => {
    const input = fixture();

    const result = supply(input);

    expect(lstatSync(path.join(result.packageRoot, "node_modules")).isSymbolicLink()).toBe(true);
  });
});
