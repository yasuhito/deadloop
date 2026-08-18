import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const { dispatchLockPath, withDispatchLock } = require("../src/dispatch-lock.cjs");

const repositoryId = "R_kgDOtestrepo";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deadloop-dispatch-lock-"));
  roots.push(root);
  return root;
}

function target(number: number, kind = "pull-request") {
  return { kind, number };
}

describe("dispatch lock path", () => {
  it("wires the pull-request dispatch decision through the lock", () => {
    const driver = fs.readFileSync("extensions/deadloop/automations/pr-reviewer-driver.cts", "utf8");

    expect(driver).toContain("withDispatchLock(");
  });

  it("places one target's lock under its repository directory", () => {
    expect(dispatchLockPath({ stateDir: "/state", repositoryId, target: target(31) }))
      .toBe(path.join("/state", "locks", repositoryId, "pull-request-31.lock"));
  });

  it("refuses a repository identifier that is not a GitHub node id", () => {
    expect(() => dispatchLockPath({ stateDir: "/state", repositoryId: "../escape", target: target(31) }))
      .toThrow("dispatch lock requires a GitHub repository ID");
  });

  it("separates the same number in different target kinds", () => {
    expect(dispatchLockPath({ stateDir: "/state", repositoryId, target: target(31, "issue") }))
      .toBe(path.join("/state", "locks", repositoryId, "issue-31.lock"));
  });
});

describe("dispatch lock exclusion", () => {
  it("runs the dispatch decision while holding the target", () => {
    const state = stateDir();

    expect(withDispatchLock({ stateDir: state, repositoryId, target: target(31) }, () => "decided")).toBe("decided");
  });

  it("refuses a second decision on a target this process already holds", () => {
    const state = stateDir();
    const input = { stateDir: state, repositoryId, target: target(31) };

    expect(withDispatchLock(input, () => withDispatchLock(input, () => "inner"))).toBeNull();
  });

  it("holds two different targets at once", () => {
    const state = stateDir();

    expect(withDispatchLock({ stateDir: state, repositoryId, target: target(31) }, () =>
      withDispatchLock({ stateDir: state, repositoryId, target: target(32) }, () => "inner"))).toBe("inner");
  });

  it("releases the target once the decision returns", () => {
    const state = stateDir();
    const input = { stateDir: state, repositoryId, target: target(31) };
    withDispatchLock(input, () => "first");

    expect(withDispatchLock(input, () => "second")).toBe("second");
  });

  it("releases the target when the decision throws", () => {
    const state = stateDir();
    const input = { stateDir: state, repositoryId, target: target(31) };
    try { withDispatchLock(input, () => { throw new Error("decision failed"); }); } catch {}

    expect(withDispatchLock(input, () => "second")).toBe("second");
  });

  it("creates the repository lock directory unreadable by other users", () => {
    const state = stateDir();
    withDispatchLock({ stateDir: state, repositoryId, target: target(31) }, () => "decided");

    expect(fs.statSync(path.join(state, "locks", repositoryId)).mode & 0o777).toBe(0o700);
  });

  it("creates the target lock file unreadable by other users", () => {
    const state = stateDir();
    withDispatchLock({ stateDir: state, repositoryId, target: target(31) }, () => "decided");

    expect(fs.statSync(dispatchLockPath({ stateDir: state, repositoryId, target: target(31) })).mode & 0o777).toBe(0o600);
  });

  it("releases the target when the holding process is killed", () => {
    const state = stateDir();
    const holder = `
      const { withDispatchLock } = require(${JSON.stringify(path.resolve("src/dispatch-lock.cjs"))});
      withDispatchLock({ stateDir: ${JSON.stringify(state)}, repositoryId: ${JSON.stringify(repositoryId)}, target: { kind: "pull-request", number: 31 } },
        () => process.kill(process.pid, "SIGKILL"));
    `;
    spawnSync("node", ["-e", holder], { encoding: "utf8" });

    expect(withDispatchLock({ stateDir: state, repositoryId, target: target(31) }, () => "after death")).toBe("after death");
  });

  it("fails closed when the lock mechanism cannot be used", () => {
    const state = stateDir();
    const run = () => ({ status: 127, stdout: "", stderr: "flock: command not found" });

    expect(() => withDispatchLock({ stateDir: state, repositoryId, target: target(31) }, () => "decided", { run }))
      .toThrow("flock");
  });
});
