import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { acquireSchedulerLock, preflightSchedulerLockCapability, releaseSchedulerLock } = require("../src/scheduler-lock.cjs");
const sandboxes: string[] = [];

function lockFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "deadloop-scheduler-lock-"));
  sandboxes.push(root);
  mkdirSync(root, { recursive: true });
  return path.join(root, "scheduler.lock");
}

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe("scheduler lock", () => {
  it("proves the installed flock supports the required nonblocking FD lock", () => {
    expect(() => preflightSchedulerLockCapability()).not.toThrow();
  });

  it("fails preflight when the flock executable is missing", () => {
    expect(() => preflightSchedulerLockCapability({
      spawnSync: () => ({ error: new Error("ENOENT"), status: null, stderr: "" }),
    })).toThrow("util-linux");
  });

  it("fails preflight when flock does not retain the inherited FD lock", () => {
    let calls = 0;
    expect(() => preflightSchedulerLockCapability({
      spawnSync: () => ({ error: undefined, status: calls++ === 0 ? 0 : 0, stderr: "" }),
    })).toThrow("nonblocking file-descriptor locks");
  });
  it("lets only one contender acquire while the original creator is delayed before publication", () => {
    const lockPath = lockFixture();
    let contender: ReturnType<typeof acquireSchedulerLock> | undefined;

    const creator = acquireSchedulerLock(lockPath, {}, {
      beforePublish: () => { contender = acquireSchedulerLock(lockPath, {}); },
    });

    const winner = [creator, contender].find((result) => result?.acquired)!;
    releaseSchedulerLock(lockPath, winner.token);
    expect([creator, contender].filter((result) => result?.acquired)).toHaveLength(1);
  });

  it("lets a child host acquire the OS lock", () => {
    const lockPath = lockFixture();
    const script = `const lock=require(${JSON.stringify(path.resolve("src/scheduler-lock.cjs"))}); const result=lock.acquireSchedulerLock(process.argv[1],{}); if(!result.acquired) process.exit(2);`;

    expect(spawnSync(process.execPath, ["-e", script, lockPath]).status).toBe(0);
  });

  it("rejects another host while a child Automation host remains alive", async () => {
    const lockPath = lockFixture();
    const script = `const lock=require(${JSON.stringify(path.resolve("src/scheduler-lock.cjs"))}); const result=lock.acquireSchedulerLock(process.argv[1],{}); if(!result.acquired) process.exit(2); process.stdout.write("ready\\n"); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", script, lockPath], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", () => resolve());
    });

    const contender = acquireSchedulerLock(lockPath, {});
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));

    expect(contender.acquired).toBe(false);
  });

  it("lets another host acquire after process exit releases the OS lock", () => {
    const lockPath = lockFixture();
    const script = `const lock=require(${JSON.stringify(path.resolve("src/scheduler-lock.cjs"))}); const result=lock.acquireSchedulerLock(process.argv[1],{}); if(!result.acquired) process.exit(2);`;
    spawnSync(process.execPath, ["-e", script, lockPath]);

    const acquired = acquireSchedulerLock(lockPath, {});
    releaseSchedulerLock(lockPath, acquired.token);

    expect(acquired.acquired).toBe(true);
  });

  it("does not release a lock now owned by a different token", () => {
    const lockPath = lockFixture();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "replacement" }));

    releaseSchedulerLock(lockPath, "original");

    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe("replacement");
  });
});
